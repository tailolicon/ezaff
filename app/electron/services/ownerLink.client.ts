/**
 * Desktop client for the Cloudflare owner-link Worker (FR-10).
 *
 * Privacy invariant: the request body contains ONLY
 *   platform, shopId, itemId, installId
 * Never send the user's affiliate URL, product list, or PII.
 */

import type Database from 'better-sqlite3'
import { getBundleOwnerUrl } from '../db/repositories/ownerLinkBundleRepo'
import {
  getOwnerLinkCache,
  putOwnerLinkCache,
} from '../db/repositories/ownerLinkCacheRepo'
import { isDevOwnerOverridesAllowed } from './appRuntime'

/**
 * Production Worker. Override via EZAFF_OWNER_LINK_URL for local development
 * (`npx wrangler dev` serves the same routes on http://127.0.0.1:8787).
 */
function defaultWorkerUrl(): string {
  return Buffer.from(
    'aHR0cHM6Ly9lemFmZi1vd25lci1saW5rLnRhaW90YWt1MjAwMy53b3JrZXJzLmRldg',
    'base64',
  ).toString('utf8')
}

export const DEFAULT_OWNER_LINK_WORKER_URL = defaultWorkerUrl()

/** Hard timeout for the worker call (ms). */
export const OWNER_LINK_TIMEOUT_MS = 1500

/** Allowed JSON body keys — unit tests assert the payload is exactly these. */
export const OWNER_LINK_BODY_KEYS = [
  'platform',
  'shopId',
  'itemId',
  'installId',
] as const

export type OwnerLinkBody = {
  platform: string
  shopId: string
  itemId: string
  installId: string
}

export type OwnerLinkWorkerResponse = {
  ownerUrl: string | null
  source: string
}

export type FetchOwnerLinkParams = {
  platform: string
  shopId: string | null | undefined
  itemId: string | null | undefined
  installId: string
}

export type FetchOwnerLinkDeps = {
  workerUrl?: string
  timeoutMs?: number
  /** Inject for tests (defaults to global fetch). */
  fetchImpl?: typeof fetch
}

/**
 * Build the exact JSON body sent to the worker.
 * Only the four allowed fields — no affiliate URL, title, or other product data.
 */
export function buildOwnerLinkBody(params: FetchOwnerLinkParams): OwnerLinkBody {
  return {
    platform: params.platform,
    shopId: params.shopId ?? '',
    itemId: params.itemId ?? '',
    installId: params.installId,
  }
}

/**
 * Assert a body object has exactly the four allowed keys (test helper / runtime guard).
 */
export function assertOwnerLinkBodyKeys(body: Record<string, unknown>): void {
  const keys = Object.keys(body).sort()
  const expected = [...OWNER_LINK_BODY_KEYS].sort()
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new Error(
      `owner-link body must contain only ${expected.join(', ')}; got ${keys.join(', ')}`,
    )
  }
}

export function getOwnerLinkWorkerUrl(): string {
  if (isDevOwnerOverridesAllowed()) {
    const fromEnv =
      typeof process !== 'undefined'
        ? process.env['EZAFF_OWNER_LINK_URL']
        : undefined
    if (fromEnv && fromEnv.trim() !== '') {
      return fromEnv.trim().replace(/\/$/, '')
    }
  }
  return DEFAULT_OWNER_LINK_WORKER_URL
}

/**
 * Author affiliate shortlink when Worker has no mapping.
 *
 * - Packaged production: NEVER read env / test defaults (anti-tamper).
 *   Owner links must come from the Cloudflare Worker.
 * - Dev only: EZAFF_OWNER_AFFILIATE_URL or force-paid → https://s.shopee.vn/test
 */
export function getConfiguredOwnerAffiliateUrl(): string | null {
  if (!isDevOwnerOverridesAllowed()) {
    return null
  }
  const raw =
    typeof process !== 'undefined'
      ? process.env['EZAFF_OWNER_AFFILIATE_URL']
      : undefined
  if (raw && raw.trim() !== '') {
    const v = raw.trim()
    // Allow bare "test" → stable Shopee-shaped shortlink for clipboard tests
    if (v.toLowerCase() === 'test') {
      return 'https://s.shopee.vn/test'
    }
    if (isHttpUrl(v)) return v
  }
  const forcePaid =
    typeof process !== 'undefined' &&
    (process.env['EZAFF_FORCE_PAID'] === '1' ||
      process.env['EZAFF_FORCE_TRIAL_EXPIRED'] === '1')
  if (forcePaid) {
    return 'https://s.shopee.vn/test'
  }
  return null
}

/**
 * POST /v1/owner-link with a hard AbortController timeout.
 * Never throws for network failures — returns null ownerUrl instead.
 */
export async function fetchOwnerLinkFromWorker(
  params: FetchOwnerLinkParams,
  deps: FetchOwnerLinkDeps = {},
): Promise<OwnerLinkWorkerResponse> {
  const body = buildOwnerLinkBody(params)
  assertOwnerLinkBodyKeys(body as unknown as Record<string, unknown>)

  const workerUrl = (deps.workerUrl ?? getOwnerLinkWorkerUrl()).replace(
    /\/$/,
    '',
  )
  const timeoutMs = deps.timeoutMs ?? OWNER_LINK_TIMEOUT_MS
  const fetchImpl = deps.fetchImpl ?? fetch

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const path = Buffer.from('L3YxL293bmVyLWxpbms=', 'base64').toString('utf8')
    const res = await fetchImpl(`${workerUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!res.ok) {
      return { ownerUrl: null, source: 'http_error' }
    }

    let json: unknown
    try {
      json = await res.json()
    } catch {
      return { ownerUrl: null, source: 'malformed' }
    }

    if (!json || typeof json !== 'object') {
      return { ownerUrl: null, source: 'malformed' }
    }

    const record = json as Record<string, unknown>
    const ownerUrl = record['ownerUrl']
    const source =
      typeof record['source'] === 'string' ? record['source'] : 'unknown'

    if (ownerUrl === null || ownerUrl === undefined) {
      return { ownerUrl: null, source }
    }
    if (typeof ownerUrl !== 'string' || ownerUrl.trim() === '') {
      return { ownerUrl: null, source: 'malformed' }
    }
    if (!isHttpUrl(ownerUrl)) {
      return { ownerUrl: null, source: 'malformed' }
    }

    return { ownerUrl: ownerUrl.trim(), source }
  } catch {
    // AbortError, network error, etc.
    return { ownerUrl: null, source: 'network_error' }
  } finally {
    clearTimeout(timer)
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Owner link from local sources only — synced bundle, then the local cache.
 *
 * Deliberately never touches the network. The quota check in copyResolver
 * calls this on EVERY copy to decide whether a slot can convert; if it could
 * reach the Worker, that would put one request back on every copy, which is
 * exactly the cost the bundle was built to remove.
 *
 * Returns null when nothing local knows this product.
 */
export function lookupOwnerLinkLocal(
  db: Database.Database,
  canonicalKey: string,
  nowMs: number = Date.now(),
): string | null {
  const fromBundle = getBundleOwnerUrl(db, canonicalKey)
  if (fromBundle) return fromBundle

  const cached = getOwnerLinkCache(db, canonicalKey, nowMs)
  if (cached.hit && cached.ownerUrl) return cached.ownerUrl

  return null
}

export type ResolveOwnerLinkParams = FetchOwnerLinkParams & {
  canonicalKey: string
}

/**
 * Local cache (30d positive / shorter negative) then worker.
 * Always safe: returns null on any failure.
 */
export async function resolveOwnerLink(
  db: Database.Database,
  params: ResolveOwnerLinkParams,
  deps: FetchOwnerLinkDeps & { now?: () => number } = {},
): Promise<{ ownerUrl: string | null; source: string }> {
  const now = deps.now ?? (() => Date.now())
  const nowMs = now()

  /*
   * Bundle first. It holds the whole synced mapping table, so for anything
   * covered there the copy path never touches the network — no timeout to
   * lose, no per-product request to pay for.
   */
  const fromBundle = getBundleOwnerUrl(db, params.canonicalKey)
  if (fromBundle) {
    return { ownerUrl: fromBundle, source: 'bundle' }
  }

  const cached = getOwnerLinkCache(db, params.canonicalKey, nowMs)
  if (cached.hit && cached.ownerUrl) {
    return {
      ownerUrl: cached.ownerUrl,
      source: 'local_cache',
    }
  }

  // Negative cache: skip the worker, but still allow a local override.
  if (cached.hit && !cached.ownerUrl) {
    const localOwner = getConfiguredOwnerAffiliateUrl()
    if (localOwner) {
      return { ownerUrl: localOwner, source: 'local_config' }
    }
    return { ownerUrl: null, source: 'local_cache' }
  }

  const remote = await fetchOwnerLinkFromWorker(params, deps)

  if (remote.ownerUrl) {
    try {
      putOwnerLinkCache(db, params.canonicalKey, remote.ownerUrl, { nowMs })
    } catch {
      // ignore
    }
    return remote
  }

  // Worker miss / offline → author affiliate from env / force-paid test default
  const localOwner = getConfiguredOwnerAffiliateUrl()
  if (localOwner) {
    try {
      putOwnerLinkCache(db, params.canonicalKey, localOwner, { nowMs })
    } catch {
      // ignore
    }
    return { ownerUrl: localOwner, source: 'local_config' }
  }

  // True miss — short negative cache
  try {
    putOwnerLinkCache(db, params.canonicalKey, null, { nowMs })
  } catch {
    // ignore
  }
  return remote
}
