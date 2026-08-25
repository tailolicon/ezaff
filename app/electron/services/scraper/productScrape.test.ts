import { describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../db/repositories/testDb'
import {
  createProductWithScrape,
  mapScrapeResultToStatus,
  rescrapeProduct,
} from './productScrape'
import type { ScrapeResult } from './types'

function scrape(
  partial: Partial<ScrapeResult> & { ok: boolean },
): ScrapeResult {
  return {
    platform: 'shopee',
    title: null,
    image_url: null,
    price: null,
    currency: 'VND',
    category: null,
    shop_name: null,
    shop_id: '1',
    item_id: '2',
    description: null,
    source: 'api',
    error: null,
    ...partial,
  }
}

describe('mapScrapeResultToStatus — partial transitions', () => {
  it('full fields → done', () => {
    const mapped = mapScrapeResultToStatus(
      scrape({
        ok: true,
        title: 'Áo thun basic',
        image_url: 'https://img.example/a.jpg',
        price: 99_000,
      }),
    )
    expect(mapped.scrape_status).toBe('done')
    expect(mapped.scrape_error).toBeNull()
  })

  it('title only → partial with Thiếu ảnh', () => {
    const mapped = mapScrapeResultToStatus(
      scrape({
        ok: true,
        title: 'Áo thun basic',
        image_url: null,
        price: null,
      }),
    )
    expect(mapped.scrape_status).toBe('partial')
    expect(mapped.scrape_error).toMatch(/^Thiếu/)
    expect(mapped.scrape_error).toMatch(/ảnh/)
    expect(mapped.title).toBe('Áo thun basic')
  })

  it('image only → partial with Thiếu tên', () => {
    const mapped = mapScrapeResultToStatus(
      scrape({
        ok: true,
        title: null,
        image_url: 'https://img.example/a.jpg',
        price: null,
      }),
    )
    expect(mapped.scrape_status).toBe('partial')
    expect(mapped.scrape_error).toMatch(/tên/)
    expect(mapped.image_url).toContain('img.example')
  })

  it('nothing usable → error', () => {
    const mapped = mapScrapeResultToStatus(
      scrape({
        ok: false,
        title: '26175826603',
        shop_id: '502146001',
        item_id: '26175826603',
        error: 'fail',
      }),
    )
    expect(mapped.scrape_status).toBe('error')
  })
})

describe('createProductWithScrape status persistence', () => {
  it('persists partial status and title when image missing', async () => {
    const db = createTestDb()
    const product = await createProductWithScrape(
      db,
      'https://shopee.vn/product/111/222',
      {
        followRedirects: async (u) => u,
        cacheImageFn: async () => null,
        scrapeFn: async () =>
          scrape({
            ok: true,
            title: 'Sản phẩm partial',
            image_url: null,
            price: 50_000,
            shop_id: '111',
            item_id: '222',
          }),
      },
    )
    expect(product.scrape_status).toBe('partial')
    expect(product.title).toBe('Sản phẩm partial')
    expect(product.price).toBe(50_000)
    expect(product.scrape_error).toMatch(/Thiếu/)
  })

  it('rescrape with skipLookupCache calls scrapeFn', async () => {
    const db = createTestDb()
    const scrapeFn = vi.fn(async (): Promise<ScrapeResult> =>
      scrape({
        ok: true,
        title: 'Lần 1',
        image_url: 'https://img.example/1.jpg',
        price: 10_000,
        shop_id: '111',
        item_id: '222',
      }),
    )
    const product = await createProductWithScrape(
      db,
      'https://shopee.vn/product/111/222',
      {
        followRedirects: async (u) => u,
        cacheImageFn: async () => null,
        scrapeFn,
      },
    )
    expect(scrapeFn).toHaveBeenCalledTimes(1)

    scrapeFn.mockImplementation(async () =>
      scrape({
        ok: true,
        title: 'Lần 2',
        image_url: 'https://img.example/2.jpg',
        price: 20_000,
        shop_id: '111',
        item_id: '222',
      }),
    )

    const again = await rescrapeProduct(db, product.id, {
      followRedirects: async (u) => u,
      cacheImageFn: async () => null,
      scrapeFn,
      skipLookupCache: true,
    })
    expect(scrapeFn).toHaveBeenCalledTimes(2)
    expect(again.title).toBe('Lần 2')
  })
})
