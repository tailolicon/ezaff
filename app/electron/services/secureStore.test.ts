import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createMemoryRegistryStore,
  createSecureStore,
  encodeLicensePayload,
  decodeLicensePayload,
  mergeLicenseRecords,
  type LicenseRecord,
  type SafeStorageLike,
} from './secureStore'

/**
 * Models Electron's Windows safeStorage, where the AES key lives in
 * userData\Local State: a new userData folder means a new key, and payloads
 * written by the old one no longer decrypt.
 *
 * Every other test here passes safeStorage: null, which is why the registry
 * mirror could be encrypted with a key that dies with userData and no test
 * noticed.
 */
function profileScopedSafeStorage(keyId: string): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`${keyId}|${plain}`, 'utf8'),
    decryptString: (buf) => {
      const text = buf.toString('utf8')
      const sep = text.indexOf('|')
      if (sep === -1 || text.slice(0, sep) !== keyId) {
        throw new Error(
          'Error while decrypting the ciphertext provided to safeStorage.decryptString.',
        )
      }
      return text.slice(sep + 1)
    },
  }
}

const temps: string[] = []

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ezaff-license-'))
  temps.push(dir)
  return dir
}

function sample(partial: Partial<LicenseRecord> = {}): LicenseRecord {
  return {
    installId: 'id-a',
    installed_at: 1_000_000,
    max_seen_time: 2_000_000,
    clock_tampered: false,
    tos_accepted_at: null,
    tos_version: null,
    ...partial,
  }
}

describe('mergeLicenseRecords', () => {
  it('lấy installed_at cũ nhất và max_seen_time lớn nhất khi lệch', () => {
    const a = sample({
      installed_at: 100,
      max_seen_time: 500,
      installId: 'file',
    })
    const b = sample({
      installed_at: 50,
      max_seen_time: 800,
      installId: 'reg',
    })
    const m = mergeLicenseRecords(a, b)
    expect(m).not.toBeNull()
    expect(m!.installed_at).toBe(50)
    expect(m!.max_seen_time).toBe(800)
    expect(m!.installId).toBe('file')
  })

  it('clock_tampered = true nếu một trong hai là true', () => {
    const m = mergeLicenseRecords(
      sample({ clock_tampered: false }),
      sample({ clock_tampered: true }),
    )
    expect(m!.clock_tampered).toBe(true)
  })

  it('một bên null → lấy bên còn lại', () => {
    const only = sample({ installed_at: 42 })
    expect(mergeLicenseRecords(only, null)).toEqual(only)
    expect(mergeLicenseRecords(null, only)).toEqual(only)
    expect(mergeLicenseRecords(null, null)).toBeNull()
  })
})

describe('encode/decode plain payload', () => {
  it('round-trip JSON thuần khi không có safeStorage', () => {
    const warnings: string[] = []
    const rec = sample({ installId: 'round' })
    const payload = encodeLicensePayload(rec, null, {
      warn: (m) => warnings.push(m),
    })
    expect(payload.startsWith('P1:')).toBe(true)
    expect(warnings.length).toBeGreaterThan(0)
    expect(decodeLicensePayload(payload, null)).toEqual(rec)
  })
})

describe('createSecureStore dual persistence', () => {
  it('ghi cả file và registry; load gộp least-favourable khi lệch', async () => {
    const dir = await tempDir()
    const registry = createMemoryRegistryStore()
    const store = createSecureStore({
      userDataPath: dir,
      registry,
      safeStorage: null,
      logger: { warn: () => undefined },
    })

    const base = sample({
      installed_at: 1_000,
      max_seen_time: 2_000,
      installId: 'dual-1',
    })
    await store.save(base)

    // Tamper registry alone to a more "favourable" (newer) installed_at —
    // merge must keep the older one from file.
    const favourable = sample({
      installId: 'dual-1',
      installed_at: 9_999_999,
      max_seen_time: 1_500,
      clock_tampered: false,
    })
    await registry.write(
      encodeLicensePayload(favourable, null, { warn: () => undefined }),
    )

    const loaded = await store.load()
    expect(loaded!.installed_at).toBe(1_000) // oldest
    expect(loaded!.max_seen_time).toBe(2_000) // largest
  })

  it('xoá một trong hai kho không reset trial (giữ installed_at)', async () => {
    const dir = await tempDir()
    const registry = createMemoryRegistryStore()
    const store = createSecureStore({
      userDataPath: dir,
      registry,
      safeStorage: null,
      logger: { warn: () => undefined },
    })

    const base = sample({
      installed_at: 111,
      max_seen_time: 222,
      installId: 'keep-me',
    })
    await store.save(base)

    await store.deleteFileStore()
    const fromReg = await store.load()
    expect(fromReg!.installed_at).toBe(111)
    expect(fromReg!.installId).toBe('keep-me')

    // Restore dual, then wipe registry
    await store.save(fromReg!)
    await store.deleteRegistryStore()
    const fromFile = await store.load()
    expect(fromFile!.installed_at).toBe(111)
  })

  it('loadAndReconcile ghi lại cả hai kho khi thiếu một bên', async () => {
    const dir = await tempDir()
    const registry = createMemoryRegistryStore()
    const store = createSecureStore({
      userDataPath: dir,
      registry,
      safeStorage: null,
      logger: { warn: () => undefined },
    })

    await store.save(
      sample({ installed_at: 5, max_seen_time: 10, installId: 'rec' }),
    )
    await store.deleteFileStore()

    const merged = await store.loadAndReconcile()
    expect(merged!.installed_at).toBe(5)

    // File should be restored from registry
    const again = await store.load()
    expect(again!.installed_at).toBe(5)
  })
})

describe('registry mirror survives a userData wipe', () => {
  it('giữ nguyên installed_at khi userData bị xoá và khoá safeStorage đổi', async () => {
    const registry = createMemoryRegistryStore()

    const dirA = await tempDir()
    const storeA = createSecureStore({
      userDataPath: dirA,
      registry,
      safeStorage: profileScopedSafeStorage('key-A'),
      logger: { warn: () => undefined },
    })
    await storeA.save(
      sample({ installed_at: 111, max_seen_time: 222, installId: 'survivor' }),
    )

    // User deletes %APPDATA%\ezaff: fresh folder, fresh safeStorage key. The
    // registry value is all that is left, and it must still be readable.
    const dirB = await tempDir()
    const storeB = createSecureStore({
      userDataPath: dirB,
      registry,
      safeStorage: profileScopedSafeStorage('key-B'),
      logger: { warn: () => undefined },
    })

    const loaded = await storeB.load()
    expect(loaded).not.toBeNull()
    expect(loaded!.installed_at).toBe(111)
    expect(loaded!.installId).toBe('survivor')
  })

  it('file vẫn được mã hoá, chỉ bản sao registry là không', async () => {
    const dir = await tempDir()
    const registry = createMemoryRegistryStore()
    const store = createSecureStore({
      userDataPath: dir,
      registry,
      safeStorage: profileScopedSafeStorage('key-A'),
      logger: { warn: () => undefined },
    })

    await store.save(sample({ installId: 'shapes' }))

    const onDisk = await readFile(store.filePath, 'utf8')
    expect(onDisk.startsWith('E1:')).toBe(true)
    expect(registry.snapshot()!.startsWith('P1:')).toBe(true)
  })

  it('vẫn đọc được bản sao E1 do bản cũ ghi ra', async () => {
    const dir = await tempDir()
    const safeStorage = profileScopedSafeStorage('key-A')
    const registry = createMemoryRegistryStore(
      encodeLicensePayload(sample({ installed_at: 77, installId: 'legacy' }), safeStorage),
    )
    const store = createSecureStore({
      userDataPath: dir,
      registry,
      safeStorage,
      logger: { warn: () => undefined },
    })

    const loaded = await store.load()
    expect(loaded!.installed_at).toBe(77)
    expect(loaded!.installId).toBe('legacy')
  })
})
