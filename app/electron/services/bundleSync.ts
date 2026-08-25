/**
 * Daily sync of the owner-link bundle from the Worker.
 *
 * This replaces the per-product lookup that used to fire on every add. One
 * request a day carrying only a version number — no product ids leave the
 * machine on this path, which is both cheaper and more honest than the old
 * flow that shipped every product the user touched.
 *
 * Never throws: a failed sync leaves the existing table in place and the copy
 * path falls back to the user's own link, exactly as it does offline.
 */

import type Database from 'better-sqlite3'
import {
  applyBundle,
  getBundleState,
  type BundleEntry,
} from '../db/repositories/ownerLinkBundleRepo'
import { getOwnerLinkWorkerUrl } from './ownerLink.client'
import { logInfo } from './log'

/** How stale the local bundle may get before a sync is attempted. */
export const BUNDLE_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * Generous next to the 1.5s copy-path budget: this runs in the background and
 * a full snapshot is a few megabytes.
 */
export const BUNDLE_SYNC_TIMEOUT_MS = 60_000

const BUNDLE_FORMAT = 'v1'
const ID_RE = /^\d{1,20}$/
const CODE_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Must stay in step with SHORTLINK_HOSTS in server/src/bundle.ts. */
const SHORTLINK_HOSTS = ['s.shopee.vn', 'shope.ee', 'shp.ee'] as const

export type BundleSyncResult = {
  ok: boolean
  /** Version now stored locally. */
  version: number
  /** Entries written this run (0 when already current). */
  applied: number
  reason: string
}

export type BundleSyncDeps = {
  workerUrl?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}

/** "0abc123" → "https://s.shopee.vn/abc123". Null when malformed. */
export function unpackUrl(packed: string): string | null {
  if (packed.length < 2) return null
  const host = SHORTLINK_HOSTS[Number(packed[0])]
  if (!host) return null
  const code = packed.slice(1)
  if (!CODE_RE.test(code)) return null
  return `https://${host}/${code}`
}

/**
 * Parse the packed body. Corrupt lines are skipped rather than aborting the
 * whole sync — one bad row should not cost the user every other mapping.
 */
export function parseBundleBody(
  text: string,
): { version: number; entries: BundleEntry[] } | null {
  const newline = text.indexOf('\n')
  if (newline === -1) return null

  const header = text.slice(0, newline).trim().split(/\s+/)
  if (header[0] !== BUNDLE_FORMAT) return null
  const version = Number(header[1])
  if (!Number.isInteger(version) || version < 0) return null

  const entries: BundleEntry[] = []
  for (const line of text.slice(newline + 1).split('\n')) {
    if (line === '') continue
    const parts = line.split(',')
    if (parts.length !== 3) continue
    const [shopId, itemId, packed] = parts as [string, string, string]
    if (!ID_RE.test(shopId) || !ID_RE.test(itemId)) continue
    const ownerUrl = unpackUrl(packed)
    if (!ownerUrl) continue
    entries.push({ shopId, itemId, ownerUrl })
  }

  return { version, entries }
}

/** True when the bundle has never synced or is older than the interval. */
export function isBundleStale(
  db: Database.Database,
  nowMs: number = Date.now(),
): boolean {
  const state = getBundleState(db)
  if (state.syncedAt == null) return true
  return nowMs - state.syncedAt >= BUNDLE_SYNC_INTERVAL_MS
}

export async function syncOwnerLinkBundle(
  db: Database.Database,
  deps: BundleSyncDeps = {},
): Promise<BundleSyncResult> {
  const now = deps.now ?? (() => Date.now())
  const state = getBundleState(db)
  const workerUrl = (deps.workerUrl ?? getOwnerLinkWorkerUrl()).replace(/\/$/, '')
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? BUNDLE_SYNC_TIMEOUT_MS

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetchImpl(
      `${workerUrl}/v1/bundle?since=${state.version}`,
      { signal: controller.signal },
    )

    if (res.status === 204) {
      // Already current — still stamp the clock so we do not retry all day.
      applyBundle(db, [], state.version, { nowMs: now() })
      return {
        ok: true,
        version: state.version,
        applied: 0,
        reason: 'up_to_date',
      }
    }

    if (!res.ok) {
      return {
        ok: false,
        version: state.version,
        applied: 0,
        reason: `http_${res.status}`,
      }
    }

    const kind = res.headers.get('X-Bundle-Kind')
    const parsed = parseBundleBody(await res.text())
    if (!parsed) {
      return {
        ok: false,
        version: state.version,
        applied: 0,
        reason: 'malformed',
      }
    }

    /*
     * A full snapshot replaces the table; a delta merges. Getting this
     * backwards either wipes good mappings or leaves deleted ones behind, and
     * neither would be visible until a user copied the wrong link — so trust
     * the header and treat anything unexpected as a snapshot.
     */
    const replace = kind !== 'delta'
    if (replace && parsed.entries.length === 0) {
      return {
        ok: false,
        version: state.version,
        applied: 0,
        reason: 'empty_snapshot',
      }
    }
    applyBundle(db, parsed.entries, parsed.version, {
      replace,
      nowMs: now(),
    })

    return {
      ok: true,
      version: parsed.version,
      applied: parsed.entries.length,
      reason: replace ? 'full' : 'delta',
    }
  } catch (err) {
    return {
      ok: false,
      version: state.version,
      applied: 0,
      reason: err instanceof Error ? err.name : 'error',
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fire-and-forget sync for app start. Skips entirely when the local copy is
 * still fresh, so launching the app repeatedly costs nothing.
 */
export function scheduleBundleSync(
  db: Database.Database,
  deps: BundleSyncDeps = {},
): void {
  const now = deps.now ?? (() => Date.now())
  if (!isBundleStale(db, now())) return

  void syncOwnerLinkBundle(db, deps).then((result) => {
    if (result.ok) {
      logInfo(
        `[ezaff] bundle sync ${result.reason} → v${result.version} (+${result.applied})`,
      )
    } else {
      logInfo('[ezaff] bundle sync skipped:', result.reason)
    }
  })
}
