import { describe, expect, it } from 'vitest'
import {
  formatPrice,
  formatRating,
  formatRatingNumber,
  formatRatingSoldLine,
  formatSold,
  formatSoldSuffix,
  productImageSrc,
} from './format'

describe('productImageSrc', () => {
  it('prefers remote https over local Windows path', () => {
    expect(
      productImageSrc(
        'C:\\Users\\me\\AppData\\Roaming\\ezaff\\images\\abc.jpg',
        'https://down-vn.img.susercontent.com/file/xyz',
      ),
    ).toBe('https://down-vn.img.susercontent.com/file/xyz')
  })

  it('converts Windows path to file URL when no remote', () => {
    const src = productImageSrc(
      'C:\\Users\\me\\AppData\\Roaming\\ezaff\\images\\abc.jpg',
      null,
    )
    expect(src).toMatch(/^file:\/\/\//)
    expect(src).toContain('Users/me/AppData')
  })

  it('returns null when both empty', () => {
    expect(productImageSrc(null, null)).toBeNull()
    expect(productImageSrc('', '')).toBeNull()
  })
})

describe('formatRating / formatSold / formatPrice', () => {
  it('formats rating with count', () => {
    expect(formatRating(4.89, 34988)).toBe('★ 4.89 (34.988)')
  })

  it('formats sold compact', () => {
    expect(formatSold(500)).toBe('Đã bán 500')
    expect(formatSold(1200)).toMatch(/Đã bán/)
  })

  it('formats VND price', () => {
    expect(formatPrice(168500)).toBe('168.500 ₫')
  })
})

describe('formatRatingSoldLine', () => {
  it('puts the star after the rating, like the mockup', () => {
    expect(formatRatingSoldLine(4.9, 12300)).toBe('4,9★ · 12,3k đã bán')
  })

  it('keeps the star when there is no sold count', () => {
    expect(formatRatingSoldLine(5, null)).toBe('5,0★')
  })

  it('omits the rating entirely when unknown', () => {
    expect(formatRatingSoldLine(null, 480)).toBe('480 đã bán')
    expect(formatRatingSoldLine(0, null)).toBeNull()
    expect(formatRatingSoldLine(null, null)).toBeNull()
  })

  it('splits rating number for the gold star', () => {
    expect(formatRatingNumber(4.74)).toBe('4,7')
    expect(formatRatingNumber(null)).toBeNull()
    expect(formatSoldSuffix(12300)).toBe('12,3k đã bán')
  })
})
