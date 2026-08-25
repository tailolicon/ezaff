import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import {
  buildFtsMatchQuery,
  createProduct,
  listProducts,
  updateProduct,
  deleteProduct,
} from './productRepo'
import { assignProductToGroup, createGroup } from './groupRepo'
import { insertCopyEvent } from './eventRepo'
import { createTestDb } from './testDb'

describe('buildFtsMatchQuery', () => {
  it('empty query returns null (caller returns all)', () => {
    expect(buildFtsMatchQuery('')).toBeNull()
    expect(buildFtsMatchQuery('   ')).toBeNull()
  })

  it('quotes and special characters do not produce raw operators', () => {
    const q = buildFtsMatchQuery(`ao "thun" OR (x) AND *foo:bar`)
    expect(q).not.toBeNull()
    // Tokens are always double-quoted phrases with prefix *
    expect(q).toMatch(/^"[^"]+"\*/)
    expect(q!.includes('"OR"*') || q!.includes('"or"*')).toBe(true)
  })

  it('only punctuation yields null (treated as empty)', () => {
    expect(buildFtsMatchQuery(`""" *** (((`)).toBeNull()
  })
})

describe('product search (FTS5)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
  })

  afterEach(() => {
    db.close()
  })

  it('empty query returns all products', () => {
    createProduct(db, {
      original_url: 'https://shopee.vn/product/1/1',
      title: 'Áo thun',
    })
    createProduct(db, {
      original_url: 'https://shopee.vn/product/1/2',
      title: 'Giày thể thao',
    })

    expect(listProducts(db, { query: '' })).toHaveLength(2)
    expect(listProducts(db, { query: '   ' })).toHaveLength(2)
    expect(listProducts(db, {})).toHaveLength(2)
  })

  it('diacritics: tìm không dấu khớp tiêu đề có dấu', () => {
    createProduct(db, {
      original_url: 'https://shopee.vn/product/2/1',
      title: 'Áo thun basic cotton',
    })
    createProduct(db, {
      original_url: 'https://shopee.vn/product/2/2',
      title: 'Giày chạy bộ',
    })

    const byAscii = listProducts(db, { query: 'ao thun' })
    expect(byAscii).toHaveLength(1)
    expect(byAscii[0].title).toContain('Áo thun')

    const byAccent = listProducts(db, { query: 'Áo' })
    expect(byAccent).toHaveLength(1)
  })

  it('partial word: tiền tố khớp từ dài hơn', () => {
    createProduct(db, {
      original_url: 'https://shopee.vn/product/3/1',
      title: 'Kem chống nắng SPF50',
    })
    createProduct(db, {
      original_url: 'https://shopee.vn/product/3/2',
      title: 'Sữa rửa mặt',
    })

    const hits = listProducts(db, { query: 'chong' })
    expect(hits).toHaveLength(1)
    expect(hits[0].title).toMatch(/chống nắng/i)
  })

  it('quotes and special characters do not throw', () => {
    createProduct(db, {
      original_url: 'https://shopee.vn/product/4/1',
      title: 'Áo "premium" size M',
      note: 'ghi chú (video)',
    })

    const nasty = [
      `"foo"`,
      `a"b`,
      `OR AND NOT`,
      `*wild*`,
      `title:foo`,
      `((((`,
      `hello^world`,
      `"" ***`,
    ]
    for (const q of nasty) {
      expect(() => listProducts(db, { query: q })).not.toThrow()
    }
  })

  it('searches note, shop_name, category', () => {
    createProduct(db, {
      original_url: 'https://shopee.vn/product/5/1',
      title: 'Sản phẩm A',
      note: 'dùng trong livestream',
      shop_name: 'Shop Việt',
      category: 'Thời trang nữ',
    })
    createProduct(db, {
      original_url: 'https://shopee.vn/product/5/2',
      title: 'Sản phẩm B',
    })

    expect(listProducts(db, { query: 'livestream' })).toHaveLength(1)
    expect(listProducts(db, { query: 'viet' })).toHaveLength(1)
    expect(listProducts(db, { query: 'thoi trang' })).toHaveLength(1)
  })

  it('FTS stays in sync on insert, update, delete', () => {
    const p = createProduct(db, {
      original_url: 'https://shopee.vn/product/6/1',
      title: 'Ban đầu',
    })
    expect(listProducts(db, { query: 'Ban' })).toHaveLength(1)

    updateProduct(db, { id: p.id, title: 'Đổi tiêu đề mới' })
    expect(listProducts(db, { query: 'Ban' })).toHaveLength(0)
    // "tiêu" folds to "tieu"; Vietnamese "đ" is a separate letter (not d)
    expect(listProducts(db, { query: 'tieu' })).toHaveLength(1)
    expect(listProducts(db, { query: 'moi' })).toHaveLength(1)

    deleteProduct(db, p.id)
    expect(listProducts(db, { query: 'tieu' })).toHaveLength(0)
    expect(listProducts(db, {})).toHaveLength(0)
  })

  it('filter by group in SQL', () => {
    const g = createGroup(db, { name: 'Video' })
    const inGroup = createProduct(db, {
      original_url: 'https://shopee.vn/product/7/1',
      title: 'Trong nhóm',
    })
    createProduct(db, {
      original_url: 'https://shopee.vn/product/7/2',
      title: 'Ngoài nhóm',
    })
    assignProductToGroup(db, inGroup.id, g.id)

    const filtered = listProducts(db, { groupId: g.id })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].id).toBe(inGroup.id)
  })

  it('filter by platform, price range, date', () => {
    const now = Date.now()
    const a = createProduct(db, {
      original_url: 'https://shopee.vn/product/8/1',
      title: 'Shopee rẻ',
      price: 10000,
    })
    createProduct(db, {
      original_url: 'https://lazada.vn/p/xyz',
      title: 'Lazada đắt',
      price: 500000,
    })

    expect(listProducts(db, { platform: 'shopee' })).toHaveLength(1)
    expect(
      listProducts(db, { priceMin: 5000, priceMax: 20000 }),
    ).toHaveLength(1)
    expect(
      listProducts(db, { dateFrom: now - 60_000, dateTo: now + 60_000 }),
    ).toHaveLength(2)
    expect(listProducts(db, { dateFrom: now + 120_000 })).toHaveLength(0)
    expect(a.platform).toBe('shopee')
  })

  it('sort: title A-Z and price', () => {
    createProduct(db, {
      original_url: 'https://shopee.vn/product/9/1',
      title: 'Beta',
      price: 300,
    })
    createProduct(db, {
      original_url: 'https://shopee.vn/product/9/2',
      title: 'Alpha',
      price: 100,
    })
    createProduct(db, {
      original_url: 'https://shopee.vn/product/9/3',
      title: 'Gamma',
      price: 200,
    })

    const byTitle = listProducts(db, { sort: 'title' })
    expect(byTitle.map((p) => p.title)).toEqual(['Alpha', 'Beta', 'Gamma'])

    const byPrice = listProducts(db, { sort: 'price' })
    expect(byPrice.map((p) => p.price)).toEqual([100, 200, 300])
  })

  it('sort most_used orders by copy_events count (0 when empty)', () => {
    createProduct(db, {
      original_url: 'https://shopee.vn/product/10/1',
      title: 'A',
    })
    createProduct(db, {
      original_url: 'https://shopee.vn/product/10/2',
      title: 'B',
    })
    // No copy_events yet — should not throw; all counts are 0
    const listed = listProducts(db, { sort: 'most_used' })
    expect(listed).toHaveLength(2)
  })

  it('sort most_used orders by real copy_events counts', () => {
    const low = createProduct(db, {
      original_url: 'https://shopee.vn/product/11/1',
      title: 'Ít dùng',
    })
    const high = createProduct(db, {
      original_url: 'https://shopee.vn/product/11/2',
      title: 'Hay dùng',
    })
    const mid = createProduct(db, {
      original_url: 'https://shopee.vn/product/11/3',
      title: 'Trung bình',
    })

    // high: 5 copies, mid: 2, low: 1
    for (let i = 0; i < 5; i++) {
      insertCopyEvent(db, {
        productId: high.id,
        templateId: null,
        usedOwner: false,
        reason: 'trial',
      })
    }
    insertCopyEvent(db, {
      productId: mid.id,
      templateId: null,
      usedOwner: false,
      reason: 'trial',
    })
    insertCopyEvent(db, {
      productId: mid.id,
      templateId: null,
      usedOwner: false,
      reason: 'not_rolled',
    })
    insertCopyEvent(db, {
      productId: low.id,
      templateId: null,
      usedOwner: false,
      reason: 'trial',
    })

    const listed = listProducts(db, { sort: 'most_used' })
    expect(listed.map((p) => p.title)).toEqual([
      'Hay dùng',
      'Trung bình',
      'Ít dùng',
    ])
  })
})
