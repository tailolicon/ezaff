/**
 * Trial licence + clock-tamper protection + ToS acceptance (FR-1, FR-10 trial, FR-11).
 *
 * This service is the ONLY place that decides whether the trial is active.
 * Phase 7 (copyResolver) will call getLicenseStatus().
 */

import { randomUUID } from 'node:crypto'
import { TOS_VERSION } from '../../shared/tosVersion'
import { isDevOwnerOverridesAllowed } from './appRuntime'
import type { LicenseRecord, SecureStore } from './secureStore'

/** Re-export so existing imports from this module keep working. */
export { TOS_VERSION }

/** Silent grace window from first run, then the paid-mode resolver applies. */
export const TRIAL_DURATION_MS = 60 * 60 * 1000

/**
 * Author/dev: force paid mode (trial expired) without waiting 1h.
 * Env: EZAFF_FORCE_PAID=1 or EZAFF_FORCE_TRIAL_EXPIRED=1
 * IGNORED in packaged production builds.
 */
export function isForcePaidMode(): boolean {
  // Packaged builds ignore force-paid env (anti-tamper)
  if (!isDevOwnerOverridesAllowed()) return false
  if (typeof process === 'undefined') return false
  const v =
    process.env['EZAFF_FORCE_PAID'] ?? process.env['EZAFF_FORCE_TRIAL_EXPIRED']
  return v === '1' || v === 'true' || v === 'yes'
}

/**
 * If wall clock jumps backwards more than this relative to max_seen_time,
 * treat as clock tampering (permanent trial end).
 */
export const CLOCK_TAMPER_TOLERANCE_MS = 5 * 60 * 1000

export type LicenseState = 'trial' | 'expired'

export type LicenseStatus = {
  state: LicenseState
  trialEndsAt: number
  msRemaining: number
  clockTampered: boolean
  tosAcceptedAt: number | null
  tosVersion: string | null
}

export type Clock = () => number

export type LicenseServiceDeps = {
  store: SecureStore
  clock?: Clock
}

export type LicenseService = {
  /** Ensure a record exists and apply clock / max_seen updates. */
  ensureInitialized: () => Promise<LicenseRecord>
  /** Sole authority for trial / expired decision. */
  getLicenseStatus: () => Promise<LicenseStatus>
  /** Persist ToS acceptance for the current TOS_VERSION. */
  acceptTos: () => Promise<LicenseStatus>
  /** True when current TOS_VERSION has not been accepted. */
  needsTosAcceptance: () => Promise<boolean>
}

function createFreshRecord(now: number): LicenseRecord {
  return {
    installId: randomUUID(),
    installed_at: now,
    max_seen_time: now,
    clock_tampered: false,
    tos_accepted_at: null,
    tos_version: null,
  }
}

/**
 * Apply clock observation: detect tamper, advance max_seen_time.
 * Returns whether the record mutated.
 */
export function applyClockObservation(
  record: LicenseRecord,
  now: number,
  toleranceMs: number = CLOCK_TAMPER_TOLERANCE_MS,
): { record: LicenseRecord; changed: boolean } {
  let changed = false
  let next: LicenseRecord = record

  if (now < record.max_seen_time - toleranceMs) {
    if (!record.clock_tampered) {
      next = { ...next, clock_tampered: true }
      changed = true
    }
  }

  if (now > next.max_seen_time) {
    next = { ...next, max_seen_time: now }
    changed = true
  }

  return { record: next, changed }
}

export function computeLicenseStatus(
  record: LicenseRecord,
  now: number,
  trialDurationMs: number = TRIAL_DURATION_MS,
): LicenseStatus {
  const trialEndsAt = record.installed_at + trialDurationMs
  const clockTampered = record.clock_tampered

  let state: LicenseState = 'trial'
  if (clockTampered || now >= trialEndsAt || isForcePaidMode()) {
    state = 'expired'
  }

  const msRemaining =
    state === 'trial' ? Math.max(0, trialEndsAt - now) : 0

  return {
    state,
    trialEndsAt,
    msRemaining,
    clockTampered,
    tosAcceptedAt: record.tos_accepted_at,
    tosVersion: record.tos_version,
  }
}

export function createLicenseService(deps: LicenseServiceDeps): LicenseService {
  const clock: Clock = deps.clock ?? (() => Date.now())
  const { store } = deps

  async function loadOrCreate(): Promise<LicenseRecord> {
    const existing = await store.loadAndReconcile()
    if (existing) return existing
    const fresh = createFreshRecord(clock())
    await store.save(fresh)
    return fresh
  }

  async function observeAndPersist(): Promise<LicenseRecord> {
    const current = await loadOrCreate()
    const now = clock()
    const { record, changed } = applyClockObservation(current, now)
    if (changed) {
      await store.save(record)
    }
    return record
  }

  async function ensureInitialized(): Promise<LicenseRecord> {
    return observeAndPersist()
  }

  async function getLicenseStatus(): Promise<LicenseStatus> {
    const record = await observeAndPersist()
    return computeLicenseStatus(record, clock())
  }

  async function acceptTos(): Promise<LicenseStatus> {
    const record = await observeAndPersist()
    const now = clock()
    const next: LicenseRecord = {
      ...record,
      tos_accepted_at: now,
      tos_version: TOS_VERSION,
    }
    await store.save(next)
    return computeLicenseStatus(next, now)
  }

  async function needsTosAcceptance(): Promise<boolean> {
    const record = await observeAndPersist()
    return (
      record.tos_accepted_at == null ||
      record.tos_version !== TOS_VERSION
    )
  }

  return {
    ensureInitialized,
    getLicenseStatus,
    acceptTos,
    needsTosAcceptance,
  }
}

// —— Main-process singleton ——

let singleton: LicenseService | null = null

export function setLicenseService(service: LicenseService): void {
  singleton = service
}

export function getLicenseService(): LicenseService {
  if (!singleton) {
    throw new Error('LicenseService chưa được khởi tạo')
  }
  return singleton
}
