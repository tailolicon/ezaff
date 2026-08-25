/**
 * Debt ledger that decides when a resolved mapping is used.
 *
 * Mapping is checked first; a slot is only spent on a row that can convert.
 * `mix` (when provided) spreads spend positions so they are not a fixed
 * stride — debt ≥ 2 always spends so the long-run rate still holds.
 */

function mixHash(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Outstanding slots at this moment.
 *
 * @param copiesSoFar already recorded, excluding the current copy
 * @param ownerSoFar  of those, how many used the mapped row
 * @param rateBp      target rate in basis points
 */
export function ownerLinkDebt(
  copiesSoFar: number,
  ownerSoFar: number,
  rateBp: number,
): number {
  if (!Number.isFinite(copiesSoFar) || copiesSoFar < 0) return 0
  if (!Number.isFinite(ownerSoFar) || ownerSoFar < 0) return 0
  if (!Number.isFinite(rateBp) || rateBp <= 0) return 0
  const owed = Math.floor((copiesSoFar * rateBp) / 10_000)
  return owed - ownerSoFar
}

/**
 * Whether this copy should spend a quota slot.
 * `hasMapping` must come from a LOCAL lookup.
 * Pass `mix` in production so spend positions are not a fixed period.
 */
export function shouldSpendOwnerQuota(params: {
  copiesSoFar: number
  ownerSoFar: number
  rateBp: number
  hasMapping: boolean
  mix?: string
}): boolean {
  if (!params.hasMapping) return false
  const debt = ownerLinkDebt(
    params.copiesSoFar,
    params.ownerSoFar,
    params.rateBp,
  )
  if (debt <= 0) return false
  if (debt >= 2) return true
  if (params.mix == null || params.mix === '') return true
  const seed = `${params.mix}:${params.copiesSoFar}:${params.ownerSoFar}`
  return mixHash(seed) % 5 !== 0
}
