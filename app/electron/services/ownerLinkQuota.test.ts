import { describe, expect, it } from 'vitest'
import { ownerLinkDebt, shouldSpendOwnerQuota } from './ownerLinkQuota'

const RATE = 500 // 5%

describe('ownerLinkDebt', () => {
  it('owes nothing until the first slot is earned', () => {
    for (let n = 0; n < 20; n++) {
      expect(ownerLinkDebt(n, 0, RATE)).toBeLessThan(1)
    }
    expect(ownerLinkDebt(20, 0, RATE)).toBe(1)
  })

  it('goes back to zero once the slot is spent', () => {
    expect(ownerLinkDebt(20, 1, RATE)).toBe(0)
    expect(ownerLinkDebt(39, 1, RATE)).toBe(0)
    expect(ownerLinkDebt(40, 1, RATE)).toBe(1)
  })

  it('accrues while coverage is too thin to spend it', () => {
    // 100 copies, none convertible → three slots still owed at 5%
    expect(ownerLinkDebt(100, 0, RATE)).toBe(5)
  })

  it('never goes positive at a zero rate', () => {
    expect(ownerLinkDebt(10_000, 0, 0)).toBe(0)
  })

  it('shrugs off nonsense counts rather than throwing', () => {
    expect(ownerLinkDebt(-5, 0, RATE)).toBe(0)
    expect(ownerLinkDebt(10, -5, RATE)).toBe(0)
    expect(ownerLinkDebt(Number.NaN, 0, RATE)).toBe(0)
  })
})

describe('shouldSpendOwnerQuota', () => {
  it('never spends on a product with no mapping — the whole point', () => {
    expect(
      shouldSpendOwnerQuota({
        copiesSoFar: 10_000,
        ownerSoFar: 0,
        rateBp: RATE,
        hasMapping: false,
      }),
    ).toBe(false)
  })

  it('spends once the debt is earned and the product is mapped', () => {
    expect(
      shouldSpendOwnerQuota({
        copiesSoFar: 20,
        ownerSoFar: 0,
        rateBp: RATE,
        hasMapping: true,
      }),
    ).toBe(true)
  })

  it('always spends when two or more slots are owed, even with mix', () => {
    expect(
      shouldSpendOwnerQuota({
        copiesSoFar: 40,
        ownerSoFar: 0,
        rateBp: RATE,
        hasMapping: true,
        mix: 'any-key',
      }),
    ).toBe(true)
  })

  it('with mix, debt=1 is not a fixed stride across different keys', () => {
    const flags = Array.from({ length: 40 }, (_, i) =>
      shouldSpendOwnerQuota({
        copiesSoFar: 20,
        ownerSoFar: 0,
        rateBp: RATE,
        hasMapping: true,
        mix: `k${i}`,
      }),
    )
    expect(flags.some((v) => v)).toBe(true)
    expect(flags.some((v) => !v)).toBe(true)
  })

  it('stops at exactly the target rate, never above', () => {
    expect(
      shouldSpendOwnerQuota({
        copiesSoFar: 20,
        ownerSoFar: 1,
        rateBp: RATE,
        hasMapping: true,
      }),
    ).toBe(false)
  })
})

/**
 * The behaviour the whole change exists for: with partial coverage the old
 * scheme realised rate × coverage, this one realises the full rate.
 */
describe('long-run rate under partial coverage', () => {
  function simulate(
    totalCopies: number,
    coverage: number,
    mix?: string,
  ): number {
    let owner = 0
    for (let i = 0; i < totalCopies; i++) {
      // Deterministic stand-in for "every Nth product is mapped".
      const hasMapping = coverage > 0 && i % Math.round(1 / coverage) === 0
      if (
        shouldSpendOwnerQuota({
          copiesSoFar: i,
          ownerSoFar: owner,
          rateBp: RATE,
          hasMapping,
          mix: mix ? `${mix}:${i}` : undefined,
        })
      ) {
        owner += 1
      }
    }
    return owner / totalCopies
  }

  it('hits 5% at full coverage', () => {
    expect(simulate(10_000, 1)).toBeCloseTo(0.05, 3)
  })

  it('still hits 5% at 40% coverage — old scheme gave 2%', () => {
    expect(simulate(10_000, 0.4)).toBeCloseTo(0.05, 3)
  })

  it('still hits 5% at 10% coverage', () => {
    expect(simulate(10_000, 0.1)).toBeCloseTo(0.05, 3)
  })

  it('falls short only when coverage is below the rate itself', () => {
    // 2% of copies convertible cannot fund a 5% quota; it tracks coverage.
    const rate = simulate(10_000, 0.02)
    expect(rate).toBeLessThan(0.05)
    expect(rate).toBeCloseTo(0.02, 2)
  })

  it('never exceeds the target, whatever the coverage', () => {
    for (const coverage of [0.02, 0.1, 0.25, 0.5, 1]) {
      expect(simulate(10_000, coverage)).toBeLessThanOrEqual(0.05)
    }
  })

  it('still converges with mix jitter and never exceeds the target', () => {
    const rate = simulate(10_000, 1, 'install-x')
    expect(rate).toBeLessThanOrEqual(0.05)
    expect(rate).toBeGreaterThan(0.048)
  })
})
