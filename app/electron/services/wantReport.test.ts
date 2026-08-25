import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyBundle } from '../db/repositories/ownerLinkBundleRepo'
import { createProduct } from '../db/repositories/productRepo'
import { createTestDb } from '../db/repositories/testDb'
import { getWantState } from '../db/repositories/wantStateRepo'
import {
  collectMissingIds,
  isWantReportDue,
  reportMissingProducts,
  WANT_REPORT_INTERVAL_MS,
} from './wantReport'

let db: Database.Database

beforeEach(() => {
  db = createTestDb()
})

afterEach(() => {
  db.close()
})

/** Insert a Shopee product with a given scrape outcome. */
function addProduct(
  shopId: string,
  itemId: string,
  scrapeStatus: string | null,
): void {
  createProduct(db, {
    original_url: `https://shopee.vn/product/${shopId}/${itemId}`,
    platform: 'shopee',
    shop_id: shopId,
    item_id: itemId,
    title: 'Sản phẩm thử',
    scrape_status: scrapeStatus,
  })
}

function okResponse(): Response {
  return { ok: true, status: 204 } as unknown as Response
}

describe('collectMissingIds — the verification rule', () => {
  it('reports a scrape-verified product the bundle does not cover', () => {
    addProduct('1016604648', '23258487489', 'done')
    expect(collectMissingIds(db)).toEqual(['1016604648:23258487489'])
  })

  it('treats partial scrapes as verified — the page was reached', () => {
    addProduct('11', '22', 'partial')
    expect(collectMissingIds(db)).toEqual(['11:22'])
  })

  it('never reports an unverified id, whatever the reason', () => {
    addProduct('1', '11', 'manual')
    addProduct('2', '22', 'error')
    addProduct('3', '33', 'scraping')
    addProduct('4', '44', null)
    // Shopee mints a valid-looking shortlink for a fabricated id, so an
    // unverified id would become a dead link shipped to every user.
    expect(collectMissingIds(db)).toEqual([])
  })

  it('skips products the bundle already covers', () => {
    addProduct('1016604648', '23258487489', 'done')
    addProduct('99', '88', 'done')
    applyBundle(
      db,
      [
        {
          shopId: '1016604648',
          itemId: '23258487489',
          ownerUrl: 'https://s.shopee.vn/have',
        },
      ],
      1,
    )
    expect(collectMissingIds(db)).toEqual(['99:88'])
  })

  it('skips category and shop links that carry no item id', () => {
    createProduct(db, {
      original_url: 'https://shopee.vn/some-shop',
      platform: 'shopee',
      shop_id: '123',
      item_id: null,
      scrape_status: 'done',
    })
    expect(collectMissingIds(db)).toEqual([])
  })

  it('honours the batch cap', () => {
    for (let i = 0; i < 5; i++) addProduct(`10${i}`, `20${i}`, 'done')
    expect(collectMissingIds(db, 3)).toHaveLength(3)
  })
})

describe('reportMissingProducts', () => {
  it('sends only install id and bare id pairs — nothing about the library', async () => {
    addProduct('1016604648', '23258487489', 'done')
    const fetchImpl = vi.fn(async () => okResponse())

    await reportMissingProducts(db, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      workerUrl: 'http://worker.test',
      getInstallId: async () => 'inst-1',
      now: () => 5000,
    })

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://worker.test/v1/want')
    const body = JSON.parse(String(init.body))
    expect(Object.keys(body).sort()).toEqual(['installId', 'missing'])
    expect(body.missing).toEqual(['1016604648:23258487489'])
    // No title, url, price or category may ride along.
    expect(String(init.body)).not.toContain('Sản phẩm thử')
    expect(String(init.body)).not.toContain('shopee.vn/product')
  })

  it('records the report so it does not fire again the same day', async () => {
    addProduct('1', '2', 'done')
    await reportMissingProducts(db, {
      fetchImpl: (async () => okResponse()) as unknown as typeof fetch,
      workerUrl: 'http://worker.test',
      getInstallId: async () => 'inst-1',
      now: () => 5000,
    })
    expect(getWantState(db)).toEqual({ reportedAt: 5000, reportedCount: 1 })
    expect(isWantReportDue(db, 5000)).toBe(false)
  })

  it('skips the request entirely when nothing is missing', async () => {
    const fetchImpl = vi.fn(async () => okResponse())
    const result = await reportMissingProducts(db, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      workerUrl: 'http://worker.test',
      getInstallId: async () => 'inst-1',
      now: () => 5000,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.reason).toBe('nothing_missing')
    expect(getWantState(db).reportedAt).toBeNull()
  })

  it('sends later the same day after an uncovered product is added', async () => {
    const fetchImpl = vi.fn(async () => okResponse())
    await reportMissingProducts(db, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      workerUrl: 'http://worker.test',
      getInstallId: async () => 'inst-1',
      now: () => 5000,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(isWantReportDue(db, 5000)).toBe(false)

    addProduct('9', '8', 'done')
    expect(isWantReportDue(db, 5000)).toBe(true)
  })

  it('a failed report never throws and does not mark the day done', async () => {
    addProduct('1', '2', 'done')
    for (const fetchImpl of [
      vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response),
      vi.fn(async () => {
        throw new Error('offline')
      }),
    ]) {
      const result = await reportMissingProducts(db, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        workerUrl: 'http://worker.test',
        getInstallId: async () => 'inst-1',
      })
      expect(result.ok).toBe(false)
      expect(getWantState(db).reportedAt).toBeNull()
    }
  })
})

describe('isWantReportDue', () => {
  it('a fresh install with nothing missing is not due', () => {
    expect(isWantReportDue(db, 1000)).toBe(false)
  })

  it('a fresh install with an uncovered product is due', () => {
    addProduct('1', '2', 'done')
    expect(isWantReportDue(db, 1000)).toBe(true)
  })

  it('becomes due again only after the interval', async () => {
    addProduct('1', '2', 'done')
    await reportMissingProducts(db, {
      fetchImpl: (async () => okResponse()) as unknown as typeof fetch,
      workerUrl: 'http://worker.test',
      getInstallId: async () => 'i',
      now: () => 1000,
    })
    expect(isWantReportDue(db, 1000 + WANT_REPORT_INTERVAL_MS - 1)).toBe(false)
    expect(isWantReportDue(db, 1000 + WANT_REPORT_INTERVAL_MS)).toBe(true)
  })
})
