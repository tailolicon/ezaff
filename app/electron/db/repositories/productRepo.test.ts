import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createProduct,
  deleteProduct,
  getProductById,
  listProducts,
  updateProduct,
} from './productRepo'
import { createTestDb } from './testDb'

describe('productRepo', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
  })

  afterEach(() => {
    db.close()
  })

  it('create: lưu sản phẩm mới với platform và canonical_key', () => {
    const product = createProduct(db, {
      original_url: 'https://shopee.vn/product/123/456',
      title: 'Áo thun basic',
      price: 99000,
      note: 'Link video',
    })

    expect(product.id).toBeTruthy()
    expect(product.platform).toBe('shopee')
    expect(product.shop_id).toBe('123')
    expect(product.item_id).toBe('456')
    expect(product.canonical_key).toBe('shopee:123:456')
    expect(product.title).toBe('Áo thun basic')
    expect(product.price).toBe(99000)
    expect(product.currency).toBe('VND')
    expect(product.scrape_status).toBe('manual')
    expect(product.created_at).toBeGreaterThan(0)
    expect(product.updated_at).toBe(product.created_at)

    const loaded = getProductById(db, product.id)
    expect(loaded).not.toBeNull()
    expect(loaded?.original_url).toBe('https://shopee.vn/product/123/456')
    expect(loaded?.title).toBe('Áo thun basic')
  })

  it('create: listProducts không trả về original_url', () => {
    createProduct(db, {
      original_url: 'https://s.shopee.vn/abcSecret',
      title: 'Bí mật',
    })
    const list = listProducts(db)
    expect(list).toHaveLength(1)
    expect(list[0]).not.toHaveProperty('original_url')
    expect(list[0].title).toBe('Bí mật')
  })

  it('update: cập nhật title, giá, ghi chú và link', () => {
    const created = createProduct(db, {
      original_url: 'https://shopee.vn/product/1/2',
      title: 'Cũ',
      price: 1000,
    })

    const updated = updateProduct(db, {
      id: created.id,
      title: 'Mới',
      price: 25000,
      note: 'Ghi chú mới',
      original_url: 'https://shopee.vn/product/9/8',
    })

    expect(updated.title).toBe('Mới')
    expect(updated.price).toBe(25000)
    expect(updated.note).toBe('Ghi chú mới')
    expect(updated.original_url).toBe('https://shopee.vn/product/9/8')
    expect(updated.canonical_key).toBe('shopee:9:8')
    expect(updated.shop_id).toBe('9')
    expect(updated.item_id).toBe('8')
    expect(updated.updated_at).toBeGreaterThanOrEqual(created.updated_at)

    const loaded = getProductById(db, created.id)
    expect(loaded?.title).toBe('Mới')
    expect(loaded?.original_url).toBe('https://shopee.vn/product/9/8')
  })

  it('delete: xoá sản phẩm theo id', () => {
    const created = createProduct(db, {
      original_url: 'https://lazada.vn/products/p-i123.html',
      title: 'Sẽ xoá',
    })

    expect(deleteProduct(db, created.id)).toBe(true)
    expect(getProductById(db, created.id)).toBeNull()
    expect(listProducts(db)).toHaveLength(0)
    expect(deleteProduct(db, created.id)).toBe(false)
  })

  it('reject: trùng canonical_key khi tạo', () => {
    createProduct(db, {
      original_url: 'https://shopee.vn/product/111/222',
      title: 'Lần 1',
    })

    expect(() =>
      createProduct(db, {
        original_url: 'https://shopee.vn/product/111/222?utm_source=x',
        title: 'Lần 2',
      }),
    ).toThrow(/canonical_key|đã tồn tại/i)
  })

  it('reject: trùng canonical_key khi cập nhật sang link đã có', () => {
    const a = createProduct(db, {
      original_url: 'https://shopee.vn/product/10/20',
      title: 'A',
    })
    const b = createProduct(db, {
      original_url: 'https://shopee.vn/product/30/40',
      title: 'B',
    })

    expect(() =>
      updateProduct(db, {
        id: b.id,
        original_url: 'https://shopee.vn/product/10/20',
      }),
    ).toThrow(/canonical_key|đã tồn tại/i)

    // A vẫn còn, B không đổi key
    expect(getProductById(db, a.id)?.canonical_key).toBe('shopee:10:20')
    expect(getProductById(db, b.id)?.canonical_key).toBe('shopee:30:40')
  })
})
