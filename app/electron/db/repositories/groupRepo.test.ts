import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { createProduct } from './productRepo'
import {
  assignProductToGroup,
  createGroup,
  deleteGroup,
  listGroups,
  listGroupsForProduct,
  renameGroup,
  setProductGroups,
  unassignProductFromGroup,
} from './groupRepo'
import { createTestDb } from './testDb'

describe('groupRepo', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
  })

  afterEach(() => {
    db.close()
  })

  it('create: tạo nhóm với tên và màu', () => {
    const group = createGroup(db, { name: 'Video TikTok', color: '#0f6b4c' })
    expect(group.id).toBeTruthy()
    expect(group.name).toBe('Video TikTok')
    expect(group.color).toBe('#0f6b4c')
    expect(group.sort_order).toBe(0)
    expect(group.created_at).toBeGreaterThan(0)
  })

  it('rename: đổi tên nhóm', () => {
    const group = createGroup(db, { name: 'Cũ' })
    const renamed = renameGroup(db, group.id, 'Mới')
    expect(renamed.name).toBe('Mới')
    expect(renamed.id).toBe(group.id)
  })

  it('delete: xoá nhóm cascade các dòng product_groups', () => {
    const group = createGroup(db, { name: 'Sẽ xoá' })
    const product = createProduct(db, {
      original_url: 'https://shopee.vn/product/1/2',
      title: 'SP',
    })
    assignProductToGroup(db, product.id, group.id)

    const joinBefore = db
      .prepare('SELECT COUNT(*) AS c FROM product_groups WHERE group_id = ?')
      .get(group.id) as { c: number }
    expect(joinBefore.c).toBe(1)

    expect(deleteGroup(db, group.id)).toBe(true)

    const joinAfter = db
      .prepare('SELECT COUNT(*) AS c FROM product_groups WHERE group_id = ?')
      .get(group.id) as { c: number }
    expect(joinAfter.c).toBe(0)

    // Product still exists
    const productStill = db
      .prepare('SELECT id FROM products WHERE id = ?')
      .get(product.id)
    expect(productStill).toBeTruthy()
  })

  it('product có thể thuộc nhiều nhóm', () => {
    const a = createGroup(db, { name: 'Nhóm A' })
    const b = createGroup(db, { name: 'Nhóm B' })
    const product = createProduct(db, {
      original_url: 'https://shopee.vn/product/10/20',
      title: 'Đa nhóm',
    })

    assignProductToGroup(db, product.id, a.id)
    assignProductToGroup(db, product.id, b.id)

    const memberships = listGroupsForProduct(db, product.id)
    expect(memberships).toHaveLength(2)
    expect(memberships.map((g) => g.name).sort()).toEqual(['Nhóm A', 'Nhóm B'])

    // Idempotent assign
    assignProductToGroup(db, product.id, a.id)
    expect(listGroupsForProduct(db, product.id)).toHaveLength(2)
  })

  it('count per group: đếm đúng số sản phẩm mỗi nhóm', () => {
    const hot = createGroup(db, { name: 'Hot' })
    const cold = createGroup(db, { name: 'Cold' })

    const p1 = createProduct(db, {
      original_url: 'https://shopee.vn/product/1/1',
      title: 'P1',
    })
    const p2 = createProduct(db, {
      original_url: 'https://shopee.vn/product/1/2',
      title: 'P2',
    })
    const p3 = createProduct(db, {
      original_url: 'https://shopee.vn/product/1/3',
      title: 'P3',
    })

    assignProductToGroup(db, p1.id, hot.id)
    assignProductToGroup(db, p2.id, hot.id)
    assignProductToGroup(db, p3.id, cold.id)
    // p1 also in cold
    assignProductToGroup(db, p1.id, cold.id)

    const listed = listGroups(db)
    const hotRow = listed.find((g) => g.id === hot.id)
    const coldRow = listed.find((g) => g.id === cold.id)
    expect(hotRow?.product_count).toBe(2)
    expect(coldRow?.product_count).toBe(2)
  })

  it('unassign: gỡ sản phẩm khỏi nhóm', () => {
    const group = createGroup(db, { name: 'Gỡ' })
    const product = createProduct(db, {
      original_url: 'https://lazada.vn/p/1',
      title: 'X',
    })
    assignProductToGroup(db, product.id, group.id)
    expect(unassignProductFromGroup(db, product.id, group.id)).toBe(true)
    expect(listGroupsForProduct(db, product.id)).toHaveLength(0)
    expect(unassignProductFromGroup(db, product.id, group.id)).toBe(false)
  })

  it('setProductGroups: thay thế toàn bộ membership', () => {
    const a = createGroup(db, { name: 'A' })
    const b = createGroup(db, { name: 'B' })
    const c = createGroup(db, { name: 'C' })
    const product = createProduct(db, {
      original_url: 'https://tiki.vn/p/1',
      title: 'Set',
    })

    setProductGroups(db, product.id, [a.id, b.id])
    expect(listGroupsForProduct(db, product.id).map((g) => g.id).sort()).toEqual(
      [a.id, b.id].sort(),
    )

    setProductGroups(db, product.id, [c.id])
    expect(listGroupsForProduct(db, product.id).map((g) => g.id)).toEqual([
      c.id,
    ])

    setProductGroups(db, product.id, [])
    expect(listGroupsForProduct(db, product.id)).toHaveLength(0)
  })

  it('reject: tên nhóm trùng', () => {
    createGroup(db, { name: 'Trùng' })
    expect(() => createGroup(db, { name: 'Trùng' })).toThrow(/đã tồn tại/i)
  })
})
