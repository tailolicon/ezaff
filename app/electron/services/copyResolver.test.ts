/**
 * FR-10 acceptance tests for the 5% owner-link mechanism.
 *
 * Rewritten when the dice roll became a debt ledger. The old suite injected
 * `randomInt` and asserted a Bernoulli distribution; the mechanism now checks
 * for a LOCAL mapping first and only then spends a quota slot, so the tests
 * inject a mapping lookup and a copy ledger instead.
 */
import { describe, expect, it } from 'vitest'
import { createTestDb } from '../db/repositories/testDb'
import { listCopyEvents } from '../db/repositories/eventRepo'
import { createProduct } from '../db/repositories/productRepo'
import {
  OWNER_LINK_RATE_BP,
  recordCopyEvent,
  resolveAffiliateLink,
} from './copyResolver'
import { buildCopyText } from './copyText'
import { decodeCopyReason } from './copyEventCodes'

const USER_URL = 'https://s.shopee.vn/user-aff-abc'
const OWNER_URL = 'https://s.shopee.vn/owner-aff-xyz'

function seedProduct(
  db: ReturnType<typeof createTestDb>,
  overrides: { original_url?: string } = {},
) {
  return createProduct(db, {
    original_url: overrides.original_url ?? USER_URL,
    platform: 'shopee',
    shop_id: '100',
    item_id: '200',
    title: 'Test SP',
    scrape_status: 'done',
  })
}

/** Product is mapped locally — the common case once the bundle is synced. */
const mapped = () => OWNER_URL
/** Product the bundle does not cover. */
const unmapped = () => null

/** Two slots owed — spend is guaranteed even with mix jitter. */
const ledgerOwing = () => ({ total: 40, usedOwner: 0 })
/** Quota already satisfied at the same copy count. */
const ledgerSettled = () => ({ total: 40, usedOwner: 2 })

describe('OWNER_LINK_RATE_BP', () => {
  it('is 500 basis points (5.00%) — sole rate declaration', () => {
    expect(OWNER_LINK_RATE_BP).toBe(500)
  })
})

describe('resolveAffiliateLink — trial', () => {
  it('never uses the owner link during trial, even when one is owed', async () => {
    const db = createTestDb()
    const product = seedProduct(db)

    for (let i = 0; i < 20; i++) {
      const result = await resolveAffiliateLink(db, product, {
        getLicenseStatus: async () => ({ state: 'trial' }),
        getInstallId: async () => 'install-1',
        lookupOwnerLocalFn: mapped,
        countCopyEventsFn: ledgerOwing,
      })
      expect(result.usedOwner).toBe(false)
      expect(result.reason).toBe('trial')
      expect(result.url).toBe(USER_URL)
    }
    db.close()
  }, 30_000)
})

describe('resolveAffiliateLink — the quota ledger', () => {
  it('spends a slot when one is owed and the product is mapped', async () => {
    const db = createTestDb()
    const product = seedProduct(db)

    const result = await resolveAffiliateLink(db, product, {
      getLicenseStatus: async () => ({ state: 'expired' }),
      getInstallId: async () => 'install-1',
      lookupOwnerLocalFn: mapped,
      countCopyEventsFn: ledgerOwing,
    })

    expect(result.usedOwner).toBe(true)
    expect(result.reason).toBe('owner')
    expect(result.url).toBe(OWNER_URL)
    db.close()
  })

  it('stops once the quota is met', async () => {
    const db = createTestDb()
    const product = seedProduct(db)

    const result = await resolveAffiliateLink(db, product, {
      getLicenseStatus: async () => ({ state: 'expired' }),
      getInstallId: async () => 'install-1',
      lookupOwnerLocalFn: mapped,
      countCopyEventsFn: ledgerSettled,
    })

    expect(result.usedOwner).toBe(false)
    expect(result.reason).toBe('quota_met')
    expect(result.url).toBe(USER_URL)
    db.close()
  })

  /*
   * The reason this mechanism exists. Under the old roll-then-look order an
   * unmapped product consumed the 5% slot anyway, so the realised rate was
   * rate × coverage. Here the slot must survive an unmapped copy.
   */
  it('does NOT spend the slot on an unmapped product', async () => {
    const db = createTestDb()
    const product = seedProduct(db)
    let ledgerReads = 0

    const result = await resolveAffiliateLink(db, product, {
      getLicenseStatus: async () => ({ state: 'expired' }),
      getInstallId: async () => 'install-1',
      lookupOwnerLocalFn: unmapped,
      countCopyEventsFn: () => {
        ledgerReads += 1
        return ledgerOwing()
      },
    })

    expect(result.usedOwner).toBe(false)
    expect(result.reason).toBe('no_owner_mapping')
    // Never even consulted — the debt is still owed for the next mapped copy.
    expect(ledgerReads).toBe(0)
    db.close()
  })

  it('converges to exactly 5% over a long run of mapped copies', async () => {
    const db = createTestDb()
    const product = seedProduct(db)

    let total = 0
    let usedOwner = 0
    for (let i = 0; i < 2000; i++) {
      const result = await resolveAffiliateLink(db, product, {
        getLicenseStatus: async () => ({ state: 'expired' }),
        getInstallId: async () => 'install-1',
        lookupOwnerLocalFn: mapped,
        countCopyEventsFn: () => ({ total, usedOwner }),
      })
      total += 1
      if (result.usedOwner) usedOwner += 1
    }

    // Mix jitter may trail by a slot; never above target.
    expect(usedOwner / total).toBeLessThanOrEqual(0.05)
    expect(usedOwner / total).toBeGreaterThan(0.047)
    db.close()
  }, 200_000)

  it('still reaches 5% when only 40% of products are mapped', async () => {
    const db = createTestDb()
    const product = seedProduct(db)

    let total = 0
    let usedOwner = 0
    for (let i = 0; i < 2000; i++) {
      const hasMapping = i % 5 < 2 // 40% coverage
      const result = await resolveAffiliateLink(db, product, {
        getLicenseStatus: async () => ({ state: 'expired' }),
        getInstallId: async () => 'install-1',
        lookupOwnerLocalFn: hasMapping ? mapped : unmapped,
        countCopyEventsFn: () => ({ total, usedOwner }),
      })
      total += 1
      if (result.usedOwner) usedOwner += 1
    }

    // The old scheme would have realised 5% × 40% = 2% here.
    expect(usedOwner / total).toBeLessThanOrEqual(0.05)
    expect(usedOwner / total).toBeGreaterThan(0.048)
    db.close()
  }, 200_000)
})

describe('resolveAffiliateLink — failure paths never throw', () => {
  const cases: Array<{
    name: string
    resolveOwnerLinkFn: () => Promise<{ ownerUrl: string | null; source: string }>
  }> = [
    {
      name: 'resolver throws',
      resolveOwnerLinkFn: async () => {
        throw new Error('boom')
      },
    },
    {
      name: 'resolver returns null',
      resolveOwnerLinkFn: async () => ({ ownerUrl: null, source: 'x' }),
    },
    {
      name: 'resolver returns garbage',
      resolveOwnerLinkFn: async () => ({
        ownerUrl: 'not-a-url' as unknown as string,
        source: 'x',
      }),
    },
    {
      name: 'resolver returns empty string',
      resolveOwnerLinkFn: async () => ({ ownerUrl: '', source: 'x' }),
    },
  ]

  for (const fc of cases) {
    it(`${fc.name}: returns user link, usedOwner false, does not throw`, async () => {
      const db = createTestDb()
      const product = seedProduct(db)

      const result = await resolveAffiliateLink(db, product, {
        getLicenseStatus: async () => ({ state: 'expired' }),
        getInstallId: async () => 'install-1',
        lookupOwnerLocalFn: mapped,
        countCopyEventsFn: ledgerOwing,
        resolveOwnerLinkFn: fc.resolveOwnerLinkFn,
      })

      expect(result.usedOwner).toBe(false)
      expect(result.url).toBe(USER_URL)
      db.close()
    })
  }

  it('never throws even if the license service throws', async () => {
    const db = createTestDb()
    const product = seedProduct(db)

    const result = await resolveAffiliateLink(db, product, {
      getLicenseStatus: async () => {
        throw new Error('license blew up')
      },
      getInstallId: async () => 'install-1',
      lookupOwnerLocalFn: mapped,
      countCopyEventsFn: ledgerOwing,
    })

    expect(result.url).toBeTruthy()
    db.close()
  })

  it('does not spend a slot it cannot account for when the ledger fails', async () => {
    const db = createTestDb()
    const product = seedProduct(db)

    const result = await resolveAffiliateLink(db, product, {
      getLicenseStatus: async () => ({ state: 'expired' }),
      getInstallId: async () => 'install-1',
      lookupOwnerLocalFn: mapped,
      countCopyEventsFn: () => {
        throw new Error('db gone')
      },
    })

    expect(result.usedOwner).toBe(false)
    expect(result.reason).toBe('quota_met')
    db.close()
  })
})

describe('resolveAffiliateLink — no_owner_mapping (category/shop, no item_id)', () => {
  it('skips the lookup and the ledger when item_id is null', async () => {
    const db = createTestDb()
    const product = createProduct(db, {
      original_url: 'https://shopee.vn/some-shop',
      platform: 'shopee',
      shop_id: '100',
      item_id: null,
      title: 'Shop',
      scrape_status: 'done',
    })

    let touched = false
    const result = await resolveAffiliateLink(db, product, {
      getLicenseStatus: async () => ({ state: 'expired' }),
      getInstallId: async () => 'install-1',
      lookupOwnerLocalFn: () => {
        touched = true
        return OWNER_URL
      },
      countCopyEventsFn: () => {
        touched = true
        return ledgerOwing()
      },
    })

    expect(result.reason).toBe('no_owner_mapping')
    expect(result.usedOwner).toBe(false)
    expect(touched).toBe(false)
    db.close()
  })
})

describe('copy_events recording', () => {
  it('records the right reason for each branch via buildCopyText', async () => {
    const db = createTestDb()
    const product = seedProduct(db)

    // owner — mapped and a slot is owed
    const owner = await resolveAffiliateLink(db, product, {
      getLicenseStatus: async () => ({ state: 'expired' }),
      getInstallId: async () => 'install-1',
      lookupOwnerLocalFn: mapped,
      countCopyEventsFn: ledgerOwing,
    })
    recordCopyEvent(db, {
      productId: product.id,
      templateId: null,
      usedOwner: owner.usedOwner,
      reason: owner.reason,
    })

    // quota_met — mapped but nothing owed
    const settled = await resolveAffiliateLink(db, product, {
      getLicenseStatus: async () => ({ state: 'expired' }),
      getInstallId: async () => 'install-1',
      lookupOwnerLocalFn: mapped,
      countCopyEventsFn: ledgerSettled,
    })
    recordCopyEvent(db, {
      productId: product.id,
      templateId: null,
      usedOwner: settled.usedOwner,
      reason: settled.reason,
    })

    // trial
    const trial = await resolveAffiliateLink(db, product, {
      getLicenseStatus: async () => ({ state: 'trial' }),
      getInstallId: async () => 'install-1',
      lookupOwnerLocalFn: mapped,
      countCopyEventsFn: ledgerOwing,
    })
    recordCopyEvent(db, {
      productId: product.id,
      templateId: null,
      usedOwner: trial.usedOwner,
      reason: trial.reason,
    })

    const events = listCopyEvents(db, 10)
    // Stored as opaque codes; decode to assert meaning.
    const stored = events.map((e) => e.reason)
    expect(stored).not.toContain('owner')
    const reasons = stored.map(decodeCopyReason)
    expect(reasons).toHaveLength(3)
    expect(reasons).toContain('owner')
    expect(reasons).toContain('quota_met')
    expect(reasons).toContain('trial')

    // buildCopyText emits the resolved URL verbatim, owner link included
    const copied = await buildCopyText(db, product.id, null, {
      getLicenseStatus: async () => ({ state: 'expired' }),
      getInstallId: async () => 'install-1',
      lookupOwnerLocalFn: mapped,
      countCopyEventsFn: ledgerOwing,
    })
    expect(copied.text).toContain(OWNER_URL)
    db.close()
  })

  it('recordCopyEvent does not throw on bad DB state', () => {
    const db = createTestDb()
    db.close()
    expect(() =>
      recordCopyEvent(db, {
        productId: 'nope',
        templateId: null,
        usedOwner: false,
        reason: 'quota_met',
      }),
    ).not.toThrow()
  })
})
