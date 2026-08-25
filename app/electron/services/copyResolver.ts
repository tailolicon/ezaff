/**
 * Affiliate URL selection for one copy. Never throws; always returns a URL.
 * Rate is reconstructed two independent ways so a single patched literal
 * cannot zero it out. Dev env override is ignored in packaged builds.
 */

import type Database from 'better-sqlite3'
import type { Product } from '../db/repositories/productRepo'
import { isDevOwnerOverridesAllowed } from './appRuntime'
import { encodeCopyReason } from './copyEventCodes'
import type { LicenseStatus } from './license.service'
import { getLicenseService } from './license.service'
import { countCopyEvents, insertCopyEvent } from '../db/repositories/eventRepo'
import {
  lookupOwnerLinkLocal,
  type FetchOwnerLinkDeps,
} from './ownerLink.client'
import { shouldSpendOwnerQuota } from './ownerLinkQuota'

/** 0x01F4 reconstructed without a decimal literal in this module. */
function decodeRateA(): number {
  const p = 0x5a
  const q = 0x5b
  const r = 0x3c
  const s = 0xc8
  return ((p ^ q) << 8) | (r ^ s)
}

function decodeRateB(): number {
  const raw = Buffer.from('AfQ=', 'base64')
  return (raw[0] ?? 0) * 256 + (raw[1] ?? 0)
}

function canonicalRateBp(): number {
  const a = decodeRateA()
  const b = decodeRateB()
  if (a === b && a > 0) return a
  return Math.max(a, b)
}

/**
 * Sole production rate (basis points). Reconstructed, not a bare assignment.
 * Packaged builds ignore EZAFF_OWNER_LINK_RATE_BP (see getOwnerLinkRateBp).
 */
export const OWNER_LINK_RATE_BP = canonicalRateBp()

/** Floor latency (ms) so roll-miss vs roll-hit paths are harder to time. */
const COPY_RESOLVE_MIN_MS = 35

/**
 * Effective rate for this process. Clamped to [0, 10000].
 * Env override IGNORED in packaged production builds (anti-tamper).
 */
export function getOwnerLinkRateBp(): number {
  if (isDevOwnerOverridesAllowed()) {
    const raw =
      typeof process !== 'undefined'
        ? process.env['EZAFF_OWNER_LINK_RATE_BP']
        : undefined
    if (raw != null && String(raw).trim() !== '') {
      const n = Number.parseInt(String(raw).trim(), 10)
      if (Number.isFinite(n) && n >= 0 && n <= 10_000) return n
    }
  }
  const a = decodeRateA()
  const b = decodeRateB()
  if (a === b && a > 0) return a
  return Math.max(a, b)
}

async function withMinLatency<T>(started: number, value: T): Promise<T> {
  const elapsed = Date.now() - started
  if (elapsed < COPY_RESOLVE_MIN_MS) {
    await new Promise((r) => setTimeout(r, COPY_RESOLVE_MIN_MS - elapsed))
  }
  return value
}

export type CopyReason =
  | 'trial'
  /** Kept so historical rows written by the old dice-roll still decode. */
  | 'not_rolled'
  /** Product has a mapping, but the quota is already satisfied. */
  | 'quota_met'
  | 'owner'
  | 'owner_unavailable'
  | 'user_link'
  /** Category/shop/campaign links have no item_id — owner mapping is impossible. */
  | 'no_owner_mapping'

export type ResolveAffiliateLinkResult = {
  url: string
  usedOwner: boolean
  reason: CopyReason
}

export type RandomIntFn = (maxExclusive: number) => number

export type CopyResolverDeps = {
  /** License status provider (defaults to main-process singleton). */
  getLicenseStatus?: () => Promise<Pick<LicenseStatus, 'state'>>
  /** installId for the worker request. */
  getInstallId?: () => Promise<string>
  /** RNG over [0, maxExclusive). Defaults to crypto.randomInt. */
  randomInt?: RandomIntFn
  /** Network / worker deps (tests inject fakes). */
  ownerLink?: FetchOwnerLinkDeps & { now?: () => number }
  /**
   * Full override of owner-link resolution (cache + network).
   * When set, local cache + worker are skipped.
   */
  resolveOwnerLinkFn?: (args: {
    platform: string
    shopId: string | null
    itemId: string | null
    installId: string
    canonicalKey: string
  }) => Promise<{ ownerUrl: string | null; source: string }>
  /** Local-only mapping lookup (bundle + cache). Tests inject a fake. */
  lookupOwnerLocalFn?: (canonicalKey: string) => string | null
  /** Copy ledger for the quota decision. Tests inject a fake. */
  countCopyEventsFn?: () => { total: number; usedOwner: number }
}

function isValidHttpUrl(value: string): boolean {
  if (!value || typeof value !== 'string') return false
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Pick the affiliate URL for one copy action.
 *
 * Decision order:
 * 1. trial active → user link, reason 'trial'
 * 2. no item_id (category/shop/campaign) → user link, reason 'no_owner_mapping'
 * 3. no LOCAL mapping → user link, reason 'no_owner_mapping'; quota untouched
 * 4. quota already met → user link, reason 'quota_met'
 * 5. otherwise → the local owner link, reason 'owner'
 *
 * Entirely local: no network call on the copy path at all. The bundle is
 * synced once a day and answers every lookup from SQLite.
 *
 * NEVER throws. NEVER returns empty / invalid URL when product.original_url is valid.
 */
export async function resolveAffiliateLink(
  db: Database.Database,
  product: Pick<
    Product,
    | 'id'
    | 'original_url'
    | 'platform'
    | 'shop_id'
    | 'item_id'
    | 'canonical_key'
  >,
  deps: CopyResolverDeps = {},
): Promise<ResolveAffiliateLinkResult> {
  const userUrl = product.original_url
  const started = Date.now()

  try {
    const getStatus =
      deps.getLicenseStatus ??
      (async () => getLicenseService().getLicenseStatus())
    const getInstallId =
      deps.getInstallId ??
      (async () => {
        const record = await getLicenseService().ensureInitialized()
        return record.installId
      })

    // 1. Trial → always user link
    let status: Pick<LicenseStatus, 'state'>
    try {
      status = await getStatus()
    } catch {
      // License unreadable → treat as expired so roll still applies,
      // but never throw; worst case we use user link after owner fail.
      status = { state: 'expired' }
    }

    if (status.state === 'trial') {
      return withMinLatency(started, safeResult(userUrl, false, 'trial'))
    }

    // 2. No item_id → owner mapping impossible (category / shop / campaign links).
    // Do not waste a roll or worker call.
    if (!product.item_id || !String(product.item_id).trim()) {
      return withMinLatency(
        started,
        safeResult(userUrl, false, 'no_owner_mapping'),
      )
    }

    /*
     * 3. Mapping first (local only). A slot is only spent where it can convert.
     */
    const localOwnerUrl = deps.lookupOwnerLocalFn
      ? deps.lookupOwnerLocalFn(product.canonical_key)
      : lookupOwnerLinkLocal(db, product.canonical_key)

    if (!localOwnerUrl) {
      return withMinLatency(
        started,
        safeResult(userUrl, false, 'no_owner_mapping'),
      )
    }

    // 4. Quota ledger — spend a slot only while under the target rate.
    const rateBp = getOwnerLinkRateBp()
    let counts: { total: number; usedOwner: number }
    try {
      counts = deps.countCopyEventsFn
        ? deps.countCopyEventsFn()
        : countCopyEvents(db)
    } catch {
      // Ledger unreadable — do not spend a slot we cannot account for.
      return withMinLatency(started, safeResult(userUrl, false, 'quota_met'))
    }

    const spend = shouldSpendOwnerQuota({
      copiesSoFar: counts.total,
      ownerSoFar: counts.usedOwner,
      rateBp,
      hasMapping: true,
      mix: `${product.canonical_key}:${product.id}`,
    })

    if (!spend) {
      return withMinLatency(started, safeResult(userUrl, false, 'quota_met'))
    }

    let installId: string
    try {
      installId = await getInstallId()
    } catch {
      return withMinLatency(
        started,
        safeResult(userUrl, false, 'owner_unavailable'),
      )
    }

    /*
     * We already hold the mapping from step 3; re-resolving would only add a
     * network round-trip on the one path that must stay fast. resolveOwnerLinkFn
     * stays supported so tests can still simulate a worker answer.
     */
    let ownerUrl: string | null = localOwnerUrl
    if (deps.resolveOwnerLinkFn) {
      try {
        const r = await deps.resolveOwnerLinkFn({
          platform: product.platform,
          shopId: product.shop_id,
          itemId: product.item_id,
          installId,
          canonicalKey: product.canonical_key,
        })
        ownerUrl = r.ownerUrl
      } catch {
        return withMinLatency(
          started,
          safeResult(userUrl, false, 'owner_unavailable'),
        )
      }
    }

    if (ownerUrl && isValidHttpUrl(ownerUrl)) {
      return withMinLatency(started, safeResult(ownerUrl, true, 'owner'))
    }

    return withMinLatency(
      started,
      safeResult(userUrl, false, 'owner_unavailable'),
    )
  } catch {
    // Absolute last resort — still never throw.
    return withMinLatency(
      started,
      safeResult(userUrl, false, 'owner_unavailable'),
    )
  }
}

function safeResult(
  url: string,
  usedOwner: boolean,
  reason: CopyReason,
): ResolveAffiliateLinkResult {
  // Guarantee non-empty string; prefer original even if somehow invalid
  // (product schema requires original_url NOT NULL).
  const finalUrl =
    url && url.trim() !== ''
      ? url.trim()
      : 'https://shopee.vn/' // should never happen for real products

  if (usedOwner && !isValidHttpUrl(finalUrl)) {
    // Defensive: never mark usedOwner if URL is bad
    return {
      url: finalUrl,
      usedOwner: false,
      reason: 'owner_unavailable',
    }
  }

  return { url: finalUrl, usedOwner, reason }
}

/**
 * Record a copy event for the transparency counter (FR-1 / FR-10).
 * Swallows DB errors so copy never fails.
 */
export function recordCopyEvent(
  db: Database.Database,
  input: {
    productId: string | null
    templateId: string | null
    usedOwner: boolean
    reason: string
  },
): void {
  try {
    insertCopyEvent(db, {
      productId: input.productId,
      templateId: input.templateId,
      usedOwner: input.usedOwner,
      // Opaque code in SQLite — not "owner" / "not_rolled" plaintext
      reason: encodeCopyReason(input.reason),
    })
  } catch {
    // never block copy
  }
}
