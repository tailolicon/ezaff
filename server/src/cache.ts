import type { Env, OwnerLinkRequest, ProviderResult } from './types'

/** Successful owner-link cache TTL: 30 days (seconds). */
export const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60

export function cacheKey(req: OwnerLinkRequest): string {
  return `cache:${req.platform}:${req.shopId}:${req.itemId}`
}

export async function getCachedOwnerLink(
  env: Env,
  req: OwnerLinkRequest,
): Promise<ProviderResult | null> {
  const raw = await env.OWNER_KV.get(cacheKey(req))
  if (raw == null || raw.trim() === '') {
    return null
  }
  return { ownerUrl: raw.trim(), source: 'cache' }
}

/**
 * Cache only successful (non-null) owner URLs for 30 days.
 * Null results are not cached at the Worker layer (client handles negative cache).
 */
export async function putCachedOwnerLink(
  env: Env,
  req: OwnerLinkRequest,
  ownerUrl: string,
): Promise<void> {
  await env.OWNER_KV.put(cacheKey(req), ownerUrl, {
    expirationTtl: CACHE_TTL_SECONDS,
  })
}
