/**
 * "want" collection: which products users have that the bundle does not cover.
 *
 * This is the coverage meter. Without it there is no way to know whether the
 * shipped bundle answers 95% of real demand or 40% — and no way to tell which
 * products are worth generating next.
 *
 * ── Why one key per install per day ───────────────────────────────────────
 * KV writes are the scarce resource: 1,000/day on the free plan, 1M/month on
 * paid. Writing a key per wanted product would be millions of writes. Writing
 * one key per install per day is 3,000/day at 3,000 users — comfortably inside
 * the paid allowance — and a client that reports twice in one day overwrites
 * its own key rather than adding a second write.
 */

/** Reported lists expire on their own; the ranking only cares about recent demand. */
export const WANT_TTL_SECONDS = 14 * 24 * 60 * 60

/** UTC day stamp so the key is stable regardless of the client's timezone. */
export function wantDayStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10)
}

export function wantKey(installId: string, nowMs: number): string {
  return `want:${wantDayStamp(nowMs)}:${installId}`
}

export type RecordWantResult = {
  stored: number
  key: string
}

/**
 * Store one install's daily miss list.
 *
 * Duplicates within a single report are collapsed — a client that sends the
 * same id twice should not inflate that product's rank.
 */
export async function recordWant(
  kv: KVNamespace,
  installId: string,
  missing: string[],
  nowMs: number,
): Promise<RecordWantResult> {
  const unique = [...new Set(missing)]
  const key = wantKey(installId, nowMs)
  await kv.put(key, JSON.stringify(unique), {
    expirationTtl: WANT_TTL_SECONDS,
  })
  return { stored: unique.length, key }
}
