import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import {
  computeRatePercent,
  countCopyEvents,
  getCopyStats,
  insertCopyEvent,
} from './eventRepo'
import { createProduct } from './productRepo'
import { createTestDb } from './testDb'

describe('computeRatePercent', () => {
  it('returns null when total is 0 (no divide by zero)', () => {
    expect(computeRatePercent(0, 0)).toBeNull()
    expect(computeRatePercent(0, 5)).toBeNull()
  })

  it('rounds to two decimal places', () => {
    // 1/3 → 33.333… → 33.33
    expect(computeRatePercent(3, 1)).toBe(33.33)
    // 2/3 → 66.666… → 66.67
    expect(computeRatePercent(3, 2)).toBe(66.67)
    // exact 5%
    expect(computeRatePercent(100, 5)).toBe(5)
    // 1/7 → 14.2857… → 14.29
    expect(computeRatePercent(7, 1)).toBe(14.29)
  })
})

describe('getCopyStats', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
  })

  afterEach(() => {
    db.close()
  })

  it('zero events: empty totals, null rate, empty breakdown', () => {
    const stats = getCopyStats(db)
    expect(stats).toEqual({
      total: 0,
      usedOwner: 0,
      ratePercent: null,
      byReason: [],
    })
  })

  it('only trial events: usedOwner 0, rate 0, one reason row', () => {
    const product = createProduct(db, {
      original_url: 'https://shopee.vn/product/1/1',
      title: 'P1',
    })
    for (let i = 0; i < 4; i++) {
      insertCopyEvent(db, {
        productId: product.id,
        templateId: null,
        usedOwner: false,
        reason: 'trial',
      })
    }

    const stats = getCopyStats(db)
    expect(stats.total).toBe(4)
    expect(stats.usedOwner).toBe(0)
    expect(stats.ratePercent).toBe(0)
    expect(stats.byReason).toEqual([{ reason: 'trial', count: 4 }])
  })

  it('mixed reasons: correct M/N percentage and breakdown', () => {
    const product = createProduct(db, {
      original_url: 'https://shopee.vn/product/2/2',
      title: 'P2',
    })

    // 10 events: 1 owner, 6 not_rolled, 2 trial, 1 owner_unavailable
    insertCopyEvent(db, {
      productId: product.id,
      templateId: null,
      usedOwner: true,
      reason: 'owner',
    })
    for (let i = 0; i < 6; i++) {
      insertCopyEvent(db, {
        productId: product.id,
        templateId: null,
        usedOwner: false,
        reason: 'not_rolled',
      })
    }
    insertCopyEvent(db, {
      productId: product.id,
      templateId: null,
      usedOwner: false,
      reason: 'trial',
    })
    insertCopyEvent(db, {
      productId: product.id,
      templateId: null,
      usedOwner: false,
      reason: 'trial',
    })
    insertCopyEvent(db, {
      productId: product.id,
      templateId: null,
      usedOwner: false,
      reason: 'owner_unavailable',
    })

    const stats = getCopyStats(db)
    expect(stats.total).toBe(10)
    expect(stats.usedOwner).toBe(1)
    expect(stats.ratePercent).toBe(10)
    // Ordered by count DESC, then reason ASC
    expect(stats.byReason).toEqual([
      { reason: 'not_rolled', count: 6 },
      { reason: 'trial', count: 2 },
      { reason: 'owner', count: 1 },
      { reason: 'owner_unavailable', count: 1 },
    ])
  })

  it('percentage rounding on non-integer ratios', () => {
    const product = createProduct(db, {
      original_url: 'https://shopee.vn/product/3/3',
      title: 'P3',
    })
    // 1 owner out of 3 → 33.33%
    insertCopyEvent(db, {
      productId: product.id,
      templateId: null,
      usedOwner: true,
      reason: 'owner',
    })
    insertCopyEvent(db, {
      productId: product.id,
      templateId: null,
      usedOwner: false,
      reason: 'not_rolled',
    })
    insertCopyEvent(db, {
      productId: product.id,
      templateId: null,
      usedOwner: false,
      reason: 'not_rolled',
    })

    const stats = getCopyStats(db)
    expect(stats.total).toBe(3)
    expect(stats.usedOwner).toBe(1)
    expect(stats.ratePercent).toBe(33.33)
  })

  it('quota ledger ignores trial rows so they cannot build a post-trial burst', () => {
    const product = createProduct(db, {
      original_url: 'https://shopee.vn/product/4/4',
      title: 'P4',
    })
    for (let i = 0; i < 40; i++) {
      insertCopyEvent(db, {
        productId: product.id,
        templateId: null,
        usedOwner: false,
        reason: 'a7',
      })
    }
    insertCopyEvent(db, {
      productId: product.id,
      templateId: null,
      usedOwner: false,
      reason: 'g8',
    })
    const ledger = countCopyEvents(db)
    expect(ledger.total).toBe(1)
    expect(ledger.usedOwner).toBe(0)
    const stats = getCopyStats(db)
    expect(stats.total).toBe(41)
  })
})
