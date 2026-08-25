import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyMetaBundle,
  getMetaState,
  getProductMeta,
  type MetaEntry,
} from '../db/repositories/productMetaRepo'
import { createTestDb } from '../db/repositories/testDb'
import { createProductWithScrape } from './scraper/productScrape'
import type { ScrapeResult } from './scraper/types'
import { isMetaStale, parseMetaBody, syncProductMeta } from './metaSync'

let db: Database.Database

beforeEach(() => {
  db = createTestDb()
})

afterEach(() => {
  db.close()
})

const entry = (over: Partial<MetaEntry> = {}): MetaEntry => ({
  shopId: '100',
  itemId: '200',
  commissionPct: 12,
  priceVnd: 139000,
  historicalSold: 40000,
  rating: 5,
  shopName: 'TopGia HCM Store',
  name: 'Giấy vệ sinh Top Gia 1280 tờ',
  ...over,
})

function body(version: number, rows: MetaEntry[]): string {
  const lines = rows.map((r) =>
    [
      r.shopId, r.itemId, r.commissionPct, r.priceVnd,
      r.historicalSold, r.rating, r.shopName, r.name,
    ].join('\t'),
  )
  return `m1 ${version} ${lines.length}\n${lines.join('\n')}\n`
}

function response(
  status: number,
  text = '',
  headers: Record<string, string> = {},
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers[k] ?? null },
    text: async () => text,
  } as unknown as Response
}

const failedScrape = (): ScrapeResult => ({
  ok: false,
  platform: 'shopee',
  title: null,
  image_url: null,
  price: null,
  currency: 'VND',
  category: null,
  category_path: null,
  shop_name: null,
  shop_id: '100',
  item_id: '200',
  description: null,
  source: null,
  error: 'chặn bởi anti-bot',
})

describe('parseMetaBody', () => {
  it('round-trips a record', () => {
    const parsed = parseMetaBody(body(4, [entry()]))
    expect(parsed?.version).toBe(4)
    expect(parsed?.entries[0]).toEqual(entry())
  })

  it('keeps commas and quotes in titles — the reason it is tab-separated', () => {
    const messy = entry({ name: 'Robot hút bụi, lau nhà "2in1", giá rẻ' })
    expect(parseMetaBody(body(1, [messy]))?.entries[0]?.name).toBe(messy.name)
  })

  it('skips corrupt rows without voiding the file', () => {
    const text = body(1, [entry()]).replace(/\n$/, '\nrubbish\n')
    expect(parseMetaBody(text)?.entries).toHaveLength(1)
  })

  it('refuses the link-bundle format outright', () => {
    expect(parseMetaBody('v1 1 1\n1,2,0abc\n')).toBeNull()
  })
})

describe('product_meta store', () => {
  it('stores and reads metadata by canonical key', () => {
    applyMetaBundle(db, [entry()], 1)
    expect(getProductMeta(db, 'shopee:100:200')).toMatchObject({
      name: 'Giấy vệ sinh Top Gia 1280 tờ',
      priceVnd: 139000,
      rating: 5,
    })
  })

  /*
   * 4.7% of the real harvest has no name at all. Returning such a row would
   * make the caller skip scraping and leave a nameless product behind.
   */
  it('treats a nameless row as no metadata', () => {
    applyMetaBundle(db, [entry({ name: '', shopName: '' })], 1)
    expect(getProductMeta(db, 'shopee:100:200')).toBeNull()
  })

  it('delta merges, snapshot replaces', () => {
    applyMetaBundle(db, [entry()], 1)
    applyMetaBundle(db, [entry({ itemId: '999', name: 'Khác' })], 2)
    expect(getProductMeta(db, 'shopee:100:200')).not.toBeNull()

    applyMetaBundle(db, [entry({ itemId: '777', name: 'Mới' })], 3, {
      replace: true,
    })
    expect(getProductMeta(db, 'shopee:100:200')).toBeNull()
    expect(getProductMeta(db, 'shopee:100:777')).not.toBeNull()
  })
})

describe('syncProductMeta', () => {
  it('applies a snapshot and records the version', async () => {
    const fetchImpl = vi.fn(async () =>
      response(200, body(7, [entry()]), { 'X-Meta-Kind': 'full' }),
    )
    const r = await syncProductMeta(db, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      workerUrl: 'http://worker.test',
      now: () => 1000,
    })
    expect(r).toMatchObject({ ok: true, version: 7, reason: 'full' })
    expect(getMetaState(db)).toMatchObject({ version: 7, syncedAt: 1000 })
  })

  it('asks with its current version so the Worker can send a delta', async () => {
    applyMetaBundle(db, [], 4)
    const fetchImpl = vi.fn(async () => response(204))
    await syncProductMeta(db, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      workerUrl: 'http://worker.test',
    })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://worker.test/v1/meta?since=4')
  })

  it('a failure leaves existing metadata untouched', async () => {
    applyMetaBundle(db, [entry()], 4)
    for (const fetchImpl of [
      vi.fn(async () => response(500)),
      vi.fn(async () => response(200, 'garbage', { 'X-Meta-Kind': 'full' })),
      vi.fn(async () => {
        throw new Error('offline')
      }),
    ]) {
      const r = await syncProductMeta(db, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        workerUrl: 'http://worker.test',
      })
      expect(r.ok).toBe(false)
      expect(getProductMeta(db, 'shopee:100:200')).not.toBeNull()
      expect(getMetaState(db).version).toBe(4)
    }
  })
})

describe('isMetaStale', () => {
  it('a fresh install is stale', () => {
    expect(isMetaStale(db, 1000)).toBe(true)
  })
})

/**
 * The behaviour that makes this worth shipping: an add survives a failed
 * scrape when the bundle knows the product.
 */
describe('add path with synced metadata', () => {
  it('keeps name and price when the scrape is blocked', async () => {
    applyMetaBundle(db, [entry()], 1)

    const product = await createProductWithScrape(
      db,
      'https://shopee.vn/product/100/200',
      {
        followRedirects: async (u) => u,
        scrapeFn: async () => failedScrape(),
        cacheImageFn: async () => null,
      },
    )

    expect(product.title).toBe('Giấy vệ sinh Top Gia 1280 tờ')
    expect(product.price).toBe(139000)
    expect(product.shop_name).toBe('TopGia HCM Store')
    // Not 'error' — there is real data to show.
    expect(product.scrape_status).not.toBe('error')
  })

  it('still ends up unusable when the bundle has nothing either', async () => {
    const product = await createProductWithScrape(
      db,
      'https://shopee.vn/product/100/200',
      {
        followRedirects: async (u) => u,
        scrapeFn: async () => failedScrape(),
        cacheImageFn: async () => null,
      },
    )
    expect(product.title).toBeNull()
    expect(product.scrape_status).toBe('error')
  })

  it('a successful scrape wins over bundled metadata', async () => {
    applyMetaBundle(db, [entry({ name: 'Tên cũ trong bundle', priceVnd: 1 })], 1)

    const product = await createProductWithScrape(
      db,
      'https://shopee.vn/product/100/200',
      {
        followRedirects: async (u) => u,
        scrapeFn: async () => ({
          ...failedScrape(),
          ok: true,
          title: 'Tên thật vừa quét',
          price: 250000,
          image_url: 'https://img.test/a.jpg',
          error: null,
        }),
        cacheImageFn: async () => null,
      },
    )

    // The live page is more current than a harvest from days ago.
    expect(product.title).toBe('Tên thật vừa quét')
    expect(product.price).toBe(250000)
  })
})
