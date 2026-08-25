import type { Env } from './types'

/** Max requests per installId per rolling minute window. */
export const RATE_LIMIT_PER_MINUTE = 60

/**
 * Sliding-minute counter stored in KV.
 * Key: rl:{installId}:{unixMinute}
 * Returns true if the request is allowed.
 *
 * Only stores installId + minute bucket — never the full request body.
 */
export async function checkRateLimit(
  env: Env,
  installId: string,
  nowMs: number = Date.now(),
): Promise<{ allowed: boolean; remaining: number }> {
  const minute = Math.floor(nowMs / 60_000)
  // Opaque key — installId only, no product identifiers needed for RL.
  const key = `rl:${installId}:${minute}`
  const raw = await env.OWNER_KV.get(key)
  const count = raw ? Number.parseInt(raw, 10) || 0 : 0

  if (count >= RATE_LIMIT_PER_MINUTE) {
    return { allowed: false, remaining: 0 }
  }

  const next = count + 1
  // Expire shortly after the minute window ends.
  await env.OWNER_KV.put(key, String(next), { expirationTtl: 120 })
  return { allowed: true, remaining: RATE_LIMIT_PER_MINUTE - next }
}
