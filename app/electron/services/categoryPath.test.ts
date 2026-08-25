import { describe, expect, it } from 'vitest'
import {
  buildCategoryPath,
  categoryLeaf,
  categoryRoot,
  isUnderCategory,
  splitCategoryPath,
} from './categoryPath'

const SHOPEE_CHAIN = [
  'Shopee',
  'Điện Thoại & Phụ Kiện',
  'Phụ kiện điện thoại',
  'Pin dự phòng',
  'Trên 20.000 mAh',
]

describe('buildCategoryPath', () => {
  it('keeps every real level and drops the marketplace root', () => {
    expect(buildCategoryPath(SHOPEE_CHAIN)).toBe(
      'Điện Thoại & Phụ Kiện > Phụ kiện điện thoại > Pin dự phòng > Trên 20.000 mAh',
    )
  })

  it('drops navigation chrome from other marketplaces too', () => {
    expect(
      buildCategoryPath(['Trang chủ', 'Lazada', 'Nhà cửa', 'Nhà bếp']),
    ).toBe('Nhà cửa > Nhà bếp')
  })

  it('collapses consecutive duplicates and blanks', () => {
    expect(buildCategoryPath(['A', 'A', '', '  ', 'B'])).toBe('A > B')
  })

  it('returns null when nothing meaningful remains', () => {
    expect(buildCategoryPath([])).toBeNull()
    expect(buildCategoryPath(['Shopee', '', 'Trang chủ'])).toBeNull()
  })
})

describe('splitCategoryPath / leaf / root', () => {
  const path = 'Điện Thoại & Phụ Kiện > Phụ kiện điện thoại > Pin dự phòng'

  it('splits back into levels', () => {
    expect(splitCategoryPath(path)).toEqual([
      'Điện Thoại & Phụ Kiện',
      'Phụ kiện điện thoại',
      'Pin dự phòng',
    ])
  })

  it('tolerates ">" written without spaces', () => {
    expect(splitCategoryPath('A>B>C')).toEqual(['A', 'B', 'C'])
  })

  it('reads leaf and root', () => {
    expect(categoryLeaf(path)).toBe('Pin dự phòng')
    expect(categoryRoot(path)).toBe('Điện Thoại & Phụ Kiện')
    expect(categoryLeaf(null)).toBeNull()
    expect(categoryRoot('')).toBeNull()
  })
})

describe('isUnderCategory', () => {
  const path = 'Điện Thoại & Phụ Kiện > Phụ kiện điện thoại > Pin dự phòng'

  it('matches the branch and everything below it', () => {
    expect(isUnderCategory(path, 'Điện Thoại & Phụ Kiện')).toBe(true)
    expect(
      isUnderCategory(path, 'Điện Thoại & Phụ Kiện > Phụ kiện điện thoại'),
    ).toBe(true)
    expect(isUnderCategory(path, path)).toBe(true)
  })

  it('does not match a sibling or a deeper prefix', () => {
    expect(isUnderCategory(path, 'Nhà Cửa & Đời Sống')).toBe(false)
    expect(isUnderCategory(path, `${path} > Trên 20.000 mAh`)).toBe(false)
    expect(isUnderCategory(path, 'Phụ kiện điện thoại')).toBe(false)
  })

  it('is case-insensitive and safe on empty input', () => {
    expect(isUnderCategory(path, 'điện thoại & phụ kiện')).toBe(true)
    expect(isUnderCategory(path, '')).toBe(false)
    expect(isUnderCategory(null, 'A')).toBe(false)
  })
})
