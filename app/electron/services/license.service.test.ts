import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLOCK_TAMPER_TOLERANCE_MS,
  TOS_VERSION,
  TRIAL_DURATION_MS,
  applyClockObservation,
  computeLicenseStatus,
  createLicenseService,
} from './license.service'
import {
  createMemoryRegistryStore,
  createSecureStore,
  encodeLicensePayload,
  type LicenseRecord,
} from './secureStore'

const temps: string[] = []

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ezaff-licsvc-'))
  temps.push(dir)
  return dir
}

type Harness = {
  service: ReturnType<typeof createLicenseService>
  store: ReturnType<typeof createSecureStore>
  registry: ReturnType<typeof createMemoryRegistryStore>
  setNow: (ms: number) => void
  getNow: () => number
}

async function makeHarness(startMs = 1_000_000): Promise<Harness> {
  let now = startMs
  const dir = await tempDir()
  const registry = createMemoryRegistryStore()
  const store = createSecureStore({
    userDataPath: dir,
    registry,
    safeStorage: null,
    logger: { warn: () => undefined },
  })
  const service = createLicenseService({
    store,
    clock: () => now,
  })
  return {
    service,
    store,
    registry,
    setNow: (ms) => {
      now = ms
    },
    getNow: () => now,
  }
}

describe('applyClockObservation / computeLicenseStatus', () => {
  it('đánh dấu clock_tampered khi now lùi quá 5 phút so với max_seen_time', () => {
    const record: LicenseRecord = {
      installId: 'x',
      installed_at: 0,
      max_seen_time: 10_000_000,
      clock_tampered: false,
      tos_accepted_at: null,
      tos_version: null,
    }
    const jumpedBack =
      record.max_seen_time - CLOCK_TAMPER_TOLERANCE_MS - 1
    const { record: next, changed } = applyClockObservation(
      record,
      jumpedBack,
    )
    expect(changed).toBe(true)
    expect(next.clock_tampered).toBe(true)

    const status = computeLicenseStatus(next, jumpedBack)
    expect(status.state).toBe('expired')
    expect(status.clockTampered).toBe(true)
  })

  it('cho phép lệch nhỏ trong 5 phút mà không coi là chỉnh giờ', () => {
    const record: LicenseRecord = {
      installId: 'x',
      installed_at: 0,
      max_seen_time: 10_000_000,
      clock_tampered: false,
      tos_accepted_at: null,
      tos_version: null,
    }
    const slight =
      record.max_seen_time - CLOCK_TAMPER_TOLERANCE_MS + 1_000
    const { record: next } = applyClockObservation(record, slight)
    expect(next.clock_tampered).toBe(false)
  })
})

describe('createLicenseService', () => {
  it('cài mới bắt đầu cửa sổ 1 giờ', async () => {
    const t0 = 5_000_000
    const { service } = await makeHarness(t0)
    const status = await service.getLicenseStatus()

    expect(status.state).toBe('trial')
    expect(status.clockTampered).toBe(false)
    expect(status.trialEndsAt).toBe(t0 + TRIAL_DURATION_MS)
    expect(status.msRemaining).toBe(TRIAL_DURATION_MS)
    expect(status.tosAcceptedAt).toBeNull()
    expect(status.tosVersion).toBeNull()
    expect(await service.needsTosAcceptance()).toBe(true)
  })

  it('hết cửa sổ sau 1 giờ', async () => {
    const t0 = 10_000_000
    const { service, setNow } = await makeHarness(t0)
    await service.ensureInitialized()

    setNow(t0 + TRIAL_DURATION_MS)
    const atBoundary = await service.getLicenseStatus()
    expect(atBoundary.state).toBe('expired')
    expect(atBoundary.msRemaining).toBe(0)

    setNow(t0 + TRIAL_DURATION_MS + 60_000)
    const after = await service.getLicenseStatus()
    expect(after.state).toBe('expired')
  })

  it('chỉnh giờ lùi → clock_tampered và hết trial', async () => {
    const t0 = 20_000_000
    const { service, setNow } = await makeHarness(t0)
    await service.ensureInitialized()

    // Advance wall clock so max_seen_time grows (still inside the 1h window)
    setNow(t0 + 20 * 60 * 1000)
    let status = await service.getLicenseStatus()
    expect(status.state).toBe('trial')

    // Jump back more than 5 minutes
    setNow(t0)
    status = await service.getLicenseStatus()
    expect(status.clockTampered).toBe(true)
    expect(status.state).toBe('expired')

    // Permanent: even if clock returns to "now", stays expired via tamper flag
    setNow(t0 + 20 * 60 * 1000)
    status = await service.getLicenseStatus()
    expect(status.clockTampered).toBe(true)
    expect(status.state).toBe('expired')
  })

  it('xoá một trong hai kho không reset trial', async () => {
    const t0 = 30_000_000
    const { service, store, setNow } = await makeHarness(t0)
    await service.ensureInitialized()

    setNow(t0 + 20 * 60 * 1000)
    await service.getLicenseStatus()

    await store.deleteFileStore()
    const afterDeleteFile = await service.getLicenseStatus()
    expect(afterDeleteFile.state).toBe('trial')
    // trialEndsAt still based on original installed_at
    expect(afterDeleteFile.trialEndsAt).toBe(t0 + TRIAL_DURATION_MS)

    await store.deleteRegistryStore()
    // File was reconciled back on previous getLicenseStatus
    const afterDeleteReg = await service.getLicenseStatus()
    expect(afterDeleteReg.trialEndsAt).toBe(t0 + TRIAL_DURATION_MS)
    expect(afterDeleteReg.state).toBe('trial')
  })

  it('khi hai kho lệch nhau → giá trị bất lợi nhất thắng', async () => {
    const t0 = 40_000_000
    const { service, store, registry, setNow } = await makeHarness(t0)
    await service.ensureInitialized()
    setNow(t0 + 60_000)
    await service.getLicenseStatus()

    // Craft a disagreeing registry: newer installed_at (would reset trial)
    // and smaller max_seen_time
    const badForAntiReset: LicenseRecord = {
      installId: 'hijack',
      installed_at: t0 + 999_999_999, // much newer — favourable to cheater
      max_seen_time: t0, // smaller
      clock_tampered: false,
      tos_accepted_at: null,
      tos_version: null,
    }
    await registry.write(
      encodeLicensePayload(badForAntiReset, null, {
        warn: () => undefined,
      }),
    )

    // Also leave file with original older installed_at
    // (registry write alone doesn't touch file)

    const status = await service.getLicenseStatus()
    // Oldest installed_at wins → original t0
    expect(status.trialEndsAt).toBe(t0 + TRIAL_DURATION_MS)
    expect(status.state).toBe('trial')

    // max_seen should be the larger one (from file after prior checks)
    const merged = await store.load()
    expect(merged!.installed_at).toBe(t0)
    expect(merged!.max_seen_time).toBeGreaterThanOrEqual(t0 + 60_000)
  })

  it('acceptTos lưu tos_accepted_at và tos_version; bump version cần accept lại', async () => {
    const t0 = 50_000_000
    const { service, setNow } = await makeHarness(t0)
    setNow(t0 + 1000)
    const accepted = await service.acceptTos()
    expect(accepted.tosAcceptedAt).toBe(t0 + 1000)
    expect(accepted.tosVersion).toBe(TOS_VERSION)
    expect(await service.needsTosAcceptance()).toBe(false)
  })
})
