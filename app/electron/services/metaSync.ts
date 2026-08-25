/**
 * Daily sync of the product-metadata bundle.
 *
 * Deliberately optional. The link bundle is what the 5% mechanism needs and
 * must land; this one only makes adding products faster, so every failure
 * path is a silent no-op and the app falls back to scraping exactly as it did
 * before this existed.
 *
 * Runs after the link bundle for the same reason: if a slow connection only
 * gets through one of them, it should be the one that matters.
 */

import type Database from 'better-sqlite3'
import {
  applyMetaBundle,
  getMetaState,
  type MetaEntry,
} from '../db/repositories/productMetaRepo'
import { getOwnerLinkWorkerUrl } from './ownerLink.client'
import { logInfo } from './log'

export const META_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Larger than the link bundle's: the snapshot is ~9 MB compressed. */
export const META_SYNC_TIMEOUT_MS = 180_000

const META_FORMAT = 'm1'
const ID_RE = /^\d{1,20}$/

export type MetaSyncResult = {
  ok: boolean
  version: number
  applied: number
  reason: string
}

export type MetaSyncDeps = {
  workerUrl?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}

const clamp = (value: string, max: number): number => {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(Math.round(n), max)
}

/** Bad rows are skipped; a wrong price shown as fact is worse than no price. */
export function parseMetaBody(
  text: string,
): { version: number; entries: MetaEntry[] } | null {
  const newline = text.indexOf('\n')
  if (newline === -1) return null

  const header = text.slice(0, newline).trim().split(/\s+/)
  if (header[0] !== META_FORMAT) return null
  const version = Number(header[1])
  if (!Number.isInteger(version) || version < 0) return null

  const entries: MetaEntry[] = []
  for (const line of text.slice(newline + 1).split('\n')) {
    if (line === '') continue
    const f = line.split('\t')
    if (f.length !== 8) continue
    const [shopId, itemId, pct, price, sold, rating, shopName, name] = f as [
      string, string, string, string, string, string, string, string,
    ]
    if (!ID_RE.test(shopId) || !ID_RE.test(itemId)) continue
    entries.push({
      shopId,
      itemId,
      commissionPct: clamp(pct, 100),
      priceVnd: clamp(price, 1e12),
      historicalSold: clamp(sold, 1e9),
      rating: clamp(rating, 5),
      shopName,
      name,
    })
  }
  return { version, entries }
}

export function isMetaStale(
  db: Database.Database,
  nowMs: number = Date.now(),
): boolean {
  const state = getMetaState(db)
  if (state.syncedAt == null) return true
  return nowMs - state.syncedAt >= META_SYNC_INTERVAL_MS
}

export async function syncProductMeta(
  db: Database.Database,
  deps: MetaSyncDeps = {},
): Promise<MetaSyncResult> {
  const now = deps.now ?? (() => Date.now())
  const state = getMetaState(db)
  const workerUrl = (deps.workerUrl ?? getOwnerLinkWorkerUrl()).replace(/\/$/, '')
  const fetchImpl = deps.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    deps.timeoutMs ?? META_SYNC_TIMEOUT_MS,
  )

  try {
    const res = await fetchImpl(`${workerUrl}/v1/meta?since=${state.version}`, {
      signal: controller.signal,
    })

    if (res.status === 204) {
      applyMetaBundle(db, [], state.version, { nowMs: now() })
      return { ok: true, version: state.version, applied: 0, reason: 'up_to_date' }
    }
    if (!res.ok) {
      return { ok: false, version: state.version, applied: 0, reason: `http_${res.status}` }
    }

    const kind = res.headers.get('X-Meta-Kind')
    const parsed = parseMetaBody(await res.text())
    if (!parsed) {
      return { ok: false, version: state.version, applied: 0, reason: 'malformed' }
    }

    // Same rule as the link bundle: only an explicit delta merges, anything
    // else replaces. Getting it backwards leaves stale rows behind silently.
    const replace = kind !== 'delta'
    applyMetaBundle(db, parsed.entries, parsed.version, {
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

export function scheduleMetaSync(
  db: Database.Database,
  deps: MetaSyncDeps = {},
): void {
  const now = deps.now ?? (() => Date.now())
  if (!isMetaStale(db, now())) return

  void syncProductMeta(db, deps).then((result) => {
    logInfo(
      result.ok
        ? `[ezaff] meta sync ${result.reason} → v${result.version} (+${result.applied})`
        : `[ezaff] meta sync skipped: ${result.reason}`,
    )
  })
}
