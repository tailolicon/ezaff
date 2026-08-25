/**
 * Daily report of products the synced bundle does not cover.
 *
 * This is what turns the bundle from a guess into a measured system: it is the
 * only signal telling the author which products real users actually hold, and
 * therefore which ones are worth generating next.
 *
 * ── The verification rule ─────────────────────────────────────────────────
 * Only products the scraper has confirmed against Shopee are ever reported.
 *
 * Shopee's `batch_product_links` does NOT validate its input — a fabricated
 * item id comes back `code: 0` with a perfectly well-formed shortlink that
 * leads nowhere (measured). Nothing in the response distinguishes it from a
 * real one. So a bad id reported here would become a dead link in the bundle,
 * shipped to every user, and a dead link is strictly worse than no link at
 * all: with no mapping the app falls back to the user's own working link.
 *
 * A successful scrape means the app fetched that product page and got a title
 * or price back, which is the only proof available that the id is real.
 */

import type Database from 'better-sqlite3'
import { T_KV } from '../db/storeIds'
import { getWantState, setWantState } from '../db/repositories/wantStateRepo'
import { getOwnerLinkWorkerUrl } from './ownerLink.client'
import { logInfo } from './log'

export const WANT_REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000
export const WANT_REPORT_TIMEOUT_MS = 15_000

/** Must not exceed WANT_MAX_IDS in server/src/schema.ts or the body is rejected. */
export const WANT_MAX_IDS = 5000

/**
 * Scrape outcomes that prove the product exists.
 * 'done' and 'partial' both mean the scraper reached the page and got data.
 * 'manual', 'error', 'scraping' and null do not — those ids are unverified.
 */
export const VERIFIED_SCRAPE_STATUSES = ['done', 'partial'] as const

export type WantReportResult = {
  ok: boolean
  reported: number
  reason: string
}

export type WantReportDeps = {
  workerUrl?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
  getInstallId?: () => Promise<string>
}

/**
 * Shopee products with a verified id that the bundle has no mapping for.
 * Returns "shopId:itemId" strings — the whole payload, nothing else.
 */
export function collectMissingIds(
  db: Database.Database,
  limit: number = WANT_MAX_IDS,
): string[] {
  const placeholders = VERIFIED_SCRAPE_STATUSES.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT p.shop_id AS shopId, p.item_id AS itemId
         FROM products p
         LEFT JOIN ${T_KV} o ON o.canonical_key = p.canonical_key
        WHERE o.canonical_key IS NULL
          AND p.platform = 'shopee'
          AND p.shop_id IS NOT NULL AND TRIM(p.shop_id) <> ''
          AND p.item_id IS NOT NULL AND TRIM(p.item_id) <> ''
          AND p.scrape_status IN (${placeholders})
        ORDER BY p.updated_at DESC
        LIMIT ?`,
    )
    .all(...VERIFIED_SCRAPE_STATUSES, limit) as Array<{
    shopId: string
    itemId: string
  }>

  const out: string[] = []
  for (const row of rows) {
    const shopId = row.shopId?.trim()
    const itemId = row.itemId?.trim()
    // Belt and braces: the wire format is digits only, and the server rejects
    // anything else outright — better to drop it here than lose the batch.
    if (!/^\d{1,20}$/.test(shopId) || !/^\d{1,20}$/.test(itemId)) continue
    out.push(`${shopId}:${itemId}`)
  }
  return out
}

export function isWantReportDue(
  db: Database.Database,
  nowMs: number = Date.now(),
): boolean {
  const state = getWantState(db)
  const hasMissing = collectMissingIds(db, 1).length > 0
  if (!hasMissing) return false
  // Last run found nothing (or never ran). A product added later today
  // must still be reported — do not wait out the 24h stamp.
  if (state.reportedAt == null || state.reportedCount === 0) return true
  return nowMs - state.reportedAt >= WANT_REPORT_INTERVAL_MS
}

/** Never throws — a failed report costs one day of telemetry and nothing else. */
export async function reportMissingProducts(
  db: Database.Database,
  deps: WantReportDeps = {},
): Promise<WantReportResult> {
  const now = deps.now ?? (() => Date.now())
  const missing = collectMissingIds(db)

  if (missing.length === 0) {
    // Do not stamp. A later add that is not in the bundle must still report.
    return { ok: true, reported: 0, reason: 'nothing_missing' }
  }

  const workerUrl = (deps.workerUrl ?? getOwnerLinkWorkerUrl()).replace(/\/$/, '')
  const fetchImpl = deps.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    deps.timeoutMs ?? WANT_REPORT_TIMEOUT_MS,
  )

  try {
    const getInstallId =
      deps.getInstallId ??
      (async () => {
        const { getLicenseService } = await import('./license.service')
        const record = await getLicenseService().ensureInitialized()
        return record.installId
      })
    const installId = await getInstallId()

    const res = await fetchImpl(`${workerUrl}/v1/want`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installId, missing }),
      signal: controller.signal,
    })

    if (!res.ok) {
      return { ok: false, reported: 0, reason: `http_${res.status}` }
    }

    setWantState(db, { reportedAt: now(), reportedCount: missing.length })
    return { ok: true, reported: missing.length, reason: 'sent' }
  } catch (err) {
    return {
      ok: false,
      reported: 0,
      reason: err instanceof Error ? err.name : 'error',
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Fire-and-forget for app start; skips entirely when not due. */
export function scheduleWantReport(
  db: Database.Database,
  deps: WantReportDeps = {},
): void {
  const now = deps.now ?? (() => Date.now())
  if (!isWantReportDue(db, now())) return

  void reportMissingProducts(db, deps).then((result) => {
    logInfo(
      result.ok
        ? `[ezaff] want report: ${result.reported}`
        : `[ezaff] want report skipped: ${result.reason}`,
    )
  })
}

/**
 * After a scrape finishes: if this library now has an uncovered verified
 * product and we have not sent a non-empty report today, send one.
 */
export function nudgeWantReport(
  db: Database.Database,
  deps: WantReportDeps = {},
): void {
  scheduleWantReport(db, deps)
}
