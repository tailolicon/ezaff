import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getProductLookupCache,
  putProductLookupCache,
  PRODUCT_LOOKUP_TTL_MS,
} from './productLookupCacheRepo'
import { createTestDb } from './testDb'
import { createProductWithScrape } from '../../services/scraper/productScrape'
import type { ScrapeResult } from '../../services/scraper/types'
import { saveImageBuffer } from '../../services/scraper/imageCache'
import { existsSync } from 'node:fs'

describe('product_lookup_cache', () => {
  it('put + get returns hit with fields', () => {
    const db = createTestDb()
    const key = 'shopee:1:2'
    putProductLookupCache(db, key, {
      title: 'Áo thun',
      image_url: 'https://img.example/a.jpg',
      price: 99_000,
      currency: 'VND',
      category: 'Áo',
      shop_name: 'Shop A',
      shop_id: '1',
      item_id: '2',
      description: null,
      source: 'api',
    })
    const hit = getProductLookupCache(db, key)
    expect(hit.hit).toBe(true)
    if (!hit.hit) return
    expect(hit.result.title).toBe('Áo thun')
    expect(hit.result.price).toBe(99_000)
    expect(hit.result.source).toMatch(/^cache/)
  })

  it('expired entry is a miss', () => {
    const db = createTestDb()
    const key = 'shopee:9:9'
    const now = 1_000_000
    putProductLookupCache(
      db,
      key,
      {
        title: 'X',
        image_url: null,
        price: null,
        currency: 'VND',
        category: null,
        shop_name: null,
        shop_id: '9',
        item_id: '9',
        description: null,
        source: 'api',
      },
      { nowMs: now, ttlMs: 10 },
    )
    expect(getProductLookupCache(db, key, now + 11).hit).toBe(false)
    expect(getProductLookupCache(db, key, now + 5).hit).toBe(true)
  })

  it('TTL default is multi-day positive cache', () => {
    expect(PRODUCT_LOOKUP_TTL_MS).toBeGreaterThan(24 * 60 * 60 * 1000)
  })
})

describe('Phase 12 — cache prevents second network lookup', () => {
  it('createProductWithScrape reuses cache for same canonical_key', async () => {
    const db = createTestDb()
    let scrapeCalls = 0
    const scrapeFn = vi.fn(async (): Promise<ScrapeResult> => {
      scrapeCalls += 1
      return {
        ok: true,
        platform: 'shopee',
        title: 'Áo thun cache test',
        image_url: 'https://img.example/cache.jpg',
        price: 120_000,
        currency: 'VND',
        category: null,
        shop_name: 'Shop Cache',
        shop_id: '502146001',
        item_id: '26175826603',
        description: null,
        source: 'api',
        error: null,
      }
    })

    const url =
      'https://shopee.vn/product/502146001/26175826603?utm_source=test'

    const first = await createProductWithScrape(db, url, {
      scrapeFn,
      cacheImageFn: async () => null,
      followRedirects: async (u) => u,
    })
    expect(first.scrape_status).toBe('done')
    expect(scrapeCalls).toBe(1)

    // Same product again — different tracking params, same canonical_key
    // must not hit scrapeFn again
    await expect(
      createProductWithScrape(db, url + '&af_id=other', {
        scrapeFn,
        cacheImageFn: async () => null,
        followRedirects: async (u) => u,
      }),
    ).rejects.toThrow(/canonical_key|đã tồn tại|tồn tại/i)

    // Force a rescrape path via cache hit: delete product, re-create
    // Actually create rejects on duplicate. Use rescrape on a NEW product
    // that shares cache via put from first.
    // Insert via scrapeFn counter: new product with same IDs fails.
    // Instead call createProductWithScrape with skipLookupCache false on a
    // different URL that maps to same key — still duplicate product.
    //
    // Prove cache: call getProductLookupCache + simulate second create
    // with a unique URL that still maps to same key is blocked by product
    // unique constraint. So test cache via rescrapeProduct after put.

    const { rescrapeProduct } = await import(
      '../../services/scraper/productScrape'
    )
    const before = scrapeCalls
    await rescrapeProduct(db, first.id, {
      scrapeFn,
      cacheImageFn: async () => null,
      followRedirects: async (u) => u,
      // cache enabled — should NOT call scrapeFn
    })
    expect(scrapeCalls).toBe(before) // no extra network scrape
  })
})

describe('Phase 12 — clipboard image saves into cache dir', () => {
  let dir: string

  afterEach(() => {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  })

  it('saveImageBuffer writes under images/ and returns image_local path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ezaff-img-'))
    // Minimal valid-ish PNG header bytes (not a full PNG; just non-empty)
    const body = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
      0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
      0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00,
      0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ])
    const path = await saveImageBuffer(body, {
      userDataPath: dir,
      ext: '.png',
      seed: 'test-clipboard',
    })
    expect(path).not.toBeNull()
    expect(path!.includes(join(dir, 'images'))).toBe(true)
    expect(path!.endsWith('.png')).toBe(true)
    expect(existsSync(path!)).toBe(true)
  })
})
