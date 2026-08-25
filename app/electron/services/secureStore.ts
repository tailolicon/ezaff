/**
 * Dual-location licence persistence (FR-11).
 *
 * Stores a small licence record in:
 * 1. Encrypted file under userData (Electron safeStorage; plain JSON fallback)
 * 2. Mirror under HKCU\Software\ezaff (Windows registry)
 *
 * Read path: load both; if they disagree or one is missing, take the
 * OLDEST installed_at and the LARGEST max_seen_time (least favourable).
 * Deleting one store must never grant a fresh trial.
 */

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logWarn } from './log'

const execFileAsync = promisify(execFile)

/** Windows registry location (spec FR-11). */
export const LICENSE_REGISTRY_KEY = 'HKCU\\Software\\ezaff'
export const LICENSE_REGISTRY_VALUE = 'LicenseData'

export const LICENSE_FILE_NAME = 'license.dat'

/** Shape persisted in both stores. */
export type LicenseRecord = {
  installId: string
  installed_at: number
  max_seen_time: number
  clock_tampered: boolean
  tos_accepted_at: number | null
  tos_version: string | null
}

/**
 * Abstract registry access so tests never touch the real Windows registry.
 */
export interface RegistryStore {
  read(): Promise<string | null>
  write(payload: string): Promise<void>
  /** Optional: clear the value (tests / uninstall helpers). */
  clear?(): Promise<void>
}

/** Minimal surface of Electron safeStorage used here. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export type SecureStoreLogger = {
  warn: (message: string) => void
}

export type SecureStoreDeps = {
  userDataPath: string
  registry: RegistryStore
  /** null / undefined → always store plain (with warning when available API was expected). */
  safeStorage?: SafeStorageLike | null
  logger?: SecureStoreLogger
  /** Override file name (tests). */
  fileName?: string
}

export type SecureStore = {
  load: () => Promise<LicenseRecord | null>
  /**
   * Load both stores, merge least-favourable values, and write the merged
   * record back to both if they disagreed or one was missing.
   */
  loadAndReconcile: () => Promise<LicenseRecord | null>
  save: (record: LicenseRecord) => Promise<void>
  /** Absolute path of the on-disk store (tests). */
  filePath: string
  /** Delete only the file store (tests). */
  deleteFileStore: () => Promise<void>
  /** Delete only the registry mirror (tests). */
  deleteRegistryStore: () => Promise<void>
}

function recordsEqual(a: LicenseRecord, b: LicenseRecord): boolean {
  return (
    a.installId === b.installId &&
    a.installed_at === b.installed_at &&
    a.max_seen_time === b.max_seen_time &&
    a.clock_tampered === b.clock_tampered &&
    a.tos_accepted_at === b.tos_accepted_at &&
    a.tos_version === b.tos_version
  )
}

const defaultLogger: SecureStoreLogger = {
  warn: (message) => {
    logWarn(message)
  },
}

function isLicenseRecord(value: unknown): value is LicenseRecord {
  if (value === null || typeof value !== 'object') return false
  const o = value as Record<string, unknown>
  return (
    typeof o.installId === 'string' &&
    typeof o.installed_at === 'number' &&
    typeof o.max_seen_time === 'number' &&
    typeof o.clock_tampered === 'boolean' &&
    (o.tos_accepted_at === null || typeof o.tos_accepted_at === 'number') &&
    (o.tos_version === null || typeof o.tos_version === 'string')
  )
}

/**
 * Merge two records with least-favourable values for trial anti-reset:
 * - oldest installed_at
 * - largest max_seen_time
 * - clock_tampered if either is true
 * - ToS: keep non-null acceptance; if both set, keep the older acceptance
 */
export function mergeLicenseRecords(
  a: LicenseRecord | null,
  b: LicenseRecord | null,
): LicenseRecord | null {
  if (!a && !b) return null
  if (!a) return { ...b! }
  if (!b) return { ...a }

  let tos_accepted_at: number | null = null
  let tos_version: string | null = null

  if (a.tos_accepted_at != null && b.tos_accepted_at != null) {
    if (a.tos_accepted_at <= b.tos_accepted_at) {
      tos_accepted_at = a.tos_accepted_at
      tos_version = a.tos_version
    } else {
      tos_accepted_at = b.tos_accepted_at
      tos_version = b.tos_version
    }
  } else if (a.tos_accepted_at != null) {
    tos_accepted_at = a.tos_accepted_at
    tos_version = a.tos_version
  } else if (b.tos_accepted_at != null) {
    tos_accepted_at = b.tos_accepted_at
    tos_version = b.tos_version
  }

  return {
    installId: a.installId || b.installId,
    installed_at: Math.min(a.installed_at, b.installed_at),
    max_seen_time: Math.max(a.max_seen_time, b.max_seen_time),
    clock_tampered: a.clock_tampered || b.clock_tampered,
    tos_accepted_at,
    tos_version,
  }
}

/**
 * Encode a record without safeStorage, so it can be read back on a machine
 * whose userData folder is gone. See encodeLicensePayload for why that matters.
 */
export function encodePlainLicensePayload(record: LicenseRecord): string {
  const json = JSON.stringify(record)
  return `P1:${Buffer.from(json, 'utf8').toString('base64')}`
}

/** Encode a record for dual storage (ASCII-safe). */
export function encodeLicensePayload(
  record: LicenseRecord,
  safeStorage: SafeStorageLike | null | undefined,
  logger: SecureStoreLogger = defaultLogger,
): string {
  const json = JSON.stringify(record)

  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(json)
    return `E1:${encrypted.toString('base64')}`
  }

  logger.warn(
    '[ezaff] safeStorage không khả dụng trên máy này — lưu bản ghi licence dạng JSON thuần (không mã hoá).',
  )
  return encodePlainLicensePayload(record)
}

/** Decode a payload previously written by encodeLicensePayload. */
export function decodeLicensePayload(
  raw: string,
  safeStorage: SafeStorageLike | null | undefined,
): LicenseRecord {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error('Bản ghi licence rỗng')
  }

  let json: string

  if (trimmed.startsWith('E1:')) {
    if (!safeStorage) {
      throw new Error('Không giải mã được bản ghi licence đã mã hoá (thiếu safeStorage)')
    }
    const buf = Buffer.from(trimmed.slice(3), 'base64')
    json = safeStorage.decryptString(buf)
  } else if (trimmed.startsWith('P1:')) {
    json = Buffer.from(trimmed.slice(3), 'base64').toString('utf8')
  } else {
    // Legacy / test plain JSON
    json = trimmed
  }

  const parsed: unknown = JSON.parse(json)
  if (!isLicenseRecord(parsed)) {
    throw new Error('Bản ghi licence không hợp lệ')
  }
  return parsed
}

/**
 * In-memory registry for unit tests.
 */
export function createMemoryRegistryStore(
  initial: string | null = null,
): RegistryStore & { snapshot: () => string | null } {
  let value: string | null = initial
  return {
    async read() {
      return value
    },
    async write(payload: string) {
      value = payload
    },
    async clear() {
      value = null
    },
    snapshot() {
      return value
    },
  }
}

/**
 * Real Windows registry mirror via `reg.exe`.
 * No-ops on non-Windows platforms (returns null / skips write).
 */
export function createWindowsRegistryStore(
  key: string = LICENSE_REGISTRY_KEY,
  valueName: string = LICENSE_REGISTRY_VALUE,
): RegistryStore {
  return {
    async read() {
      if (process.platform !== 'win32') return null
      try {
        const { stdout } = await execFileAsync('reg', [
          'query',
          key,
          '/v',
          valueName,
        ])
        // Example line: "    LicenseData    REG_SZ    P1:eyJ..."
        const lines = stdout.split(/\r?\n/)
        for (const line of lines) {
          if (!line.toLowerCase().includes(valueName.toLowerCase())) continue
          const match = line.match(/REG_SZ\s+(.+)\s*$/i)
          if (match?.[1]) return match[1].trim()
        }
        return null
      } catch {
        return null
      }
    },

    async write(payload: string) {
      if (process.platform !== 'win32') return
      // REG_SZ: payload is base64-prefixed ASCII, safe for /d
      await execFileAsync('reg', [
        'add',
        key,
        '/v',
        valueName,
        '/t',
        'REG_SZ',
        '/d',
        payload,
        '/f',
      ])
    },

    async clear() {
      if (process.platform !== 'win32') return
      try {
        await execFileAsync('reg', ['delete', key, '/v', valueName, '/f'])
      } catch {
        // value may not exist
      }
    },
  }
}

export function createSecureStore(deps: SecureStoreDeps): SecureStore {
  const logger = deps.logger ?? defaultLogger
  const fileName = deps.fileName ?? LICENSE_FILE_NAME
  const filePath = join(deps.userDataPath, fileName)
  const safeStorage = deps.safeStorage ?? null

  async function readFileStore(): Promise<LicenseRecord | null> {
    try {
      const raw = await readFile(filePath, 'utf8')
      return decodeLicensePayload(raw, safeStorage)
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? (err as { code?: string }).code
          : undefined
      if (code === 'ENOENT') return null
      logger.warn(
        `[ezaff] Không đọc được file licence: ${err instanceof Error ? err.message : String(err)}`,
      )
      return null
    }
  }

  async function readRegistryStore(): Promise<LicenseRecord | null> {
    try {
      const raw = await deps.registry.read()
      if (raw == null || raw === '') return null
      return decodeLicensePayload(raw, safeStorage)
    } catch (err) {
      logger.warn(
        `[ezaff] Không đọc được registry licence: ${err instanceof Error ? err.message : String(err)}`,
      )
      return null
    }
  }

  async function load(): Promise<LicenseRecord | null> {
    const [fileRec, regRec] = await Promise.all([
      readFileStore(),
      readRegistryStore(),
    ])
    return mergeLicenseRecords(fileRec, regRec)
  }

  async function save(record: LicenseRecord): Promise<void> {
    const payload = encodeLicensePayload(record, safeStorage, logger)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, payload, 'utf8')

    /*
     * The registry mirror is deliberately NOT safeStorage-encrypted.
     *
     * On Windows safeStorage encrypts with an AES-GCM key kept in
     * userData\Local State (payloads carry the "v10" prefix). The mirror
     * exists for exactly one scenario — userData was deleted — and in that
     * scenario the key is gone too, so an E1 payload here is unreadable
     * precisely when it is needed and the trial silently restarts.
     * Measured: two userData dirs produce two different os_crypt keys.
     *
     * Encryption bought nothing anyway: anyone able to edit this value can
     * delete it instead, which yields the same fresh trial. Readers still
     * accept E1, so mirrors written by older builds keep working.
     */
    await deps.registry.write(encodePlainLicensePayload(record))
  }

  async function loadAndReconcile(): Promise<LicenseRecord | null> {
    const [fileRec, regRec] = await Promise.all([
      readFileStore(),
      readRegistryStore(),
    ])
    const merged = mergeLicenseRecords(fileRec, regRec)
    if (!merged) return null

    const fileOk = fileRec != null && recordsEqual(fileRec, merged)
    const regOk = regRec != null && recordsEqual(regRec, merged)
    if (!fileOk || !regOk) {
      await save(merged)
    }
    return merged
  }

  async function deleteFileStore(): Promise<void> {
    try {
      await unlink(filePath)
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? (err as { code?: string }).code
          : undefined
      if (code !== 'ENOENT') throw err
    }
  }

  async function deleteRegistryStore(): Promise<void> {
    if (deps.registry.clear) {
      await deps.registry.clear()
    } else {
      await deps.registry.write('')
    }
  }

  return {
    load,
    loadAndReconcile,
    save,
    filePath,
    deleteFileStore,
    deleteRegistryStore,
  }
}
