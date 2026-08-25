import { describe, expect, it } from 'vitest'
import {
  extractJsonLdProducts,
  extractOpenGraph,
  parsePriceAmount,
} from './htmlMeta'

describe('parsePriceAmount — VND / JSON-LD formats', () => {
  it('parses plain integers', () => {
    expect(parsePriceAmount('168500')).toBe(168_500)
    expect(parsePriceAmount('99')).toBe(99)
  })

  it('does NOT swallow .00 decimals into extra digits (JSON-LD bug)', () => {
    // Regression: "168500.00".replace(/[^\d]/g,'') → "16850000" (wrong)
    expect(parsePriceAmount('168500.00')).toBe(168_500)
    expect(parsePriceAmount('99.5')).toBe(100) // rounds
    expect(parsePriceAmount('99.49')).toBe(99)
  })

  it('parses Vietnamese thousand-dot format', () => {
    expect(parsePriceAmount('168.500')).toBe(168_500)
    expect(parsePriceAmount('1.234.567')).toBe(1_234_567)
  })

  it('parses European decimal comma', () => {
    expect(parsePriceAmount('168500,50')).toBe(168_501) // round
    expect(parsePriceAmount('1.234,56')).toBe(1_235)
  })

  it('returns null for empty', () => {
    expect(parsePriceAmount(null)).toBeNull()
    expect(parsePriceAmount('')).toBeNull()
  })
})

describe('extractJsonLdProducts — Shopee Product shape', () => {
  const html = `
<script type="application/ld+json">${JSON.stringify({
    '@context': 'http://schema.org',
    '@type': 'Product',
    name: 'Combo 20 chân gà',
    description: 'Mô tả dài',
    image: 'https://down-vn.img.susercontent.com/file/abc',
    offers: {
      '@type': 'Offer',
      price: '168500.00',
      priceCurrency: 'VND',
      seller: {
        '@type': 'Organization',
        name: 'Ăn Cùng Bà Tuyết',
      },
    },
    aggregateRating: {
      ratingValue: '4.89',
      ratingCount: '34988',
    },
  })}</script>`

  it('extracts price, name, image, seller as brand, and product rating', () => {
    const products = extractJsonLdProducts(html)
    expect(products).toHaveLength(1)
    expect(products[0]!.name).toBe('Combo 20 chân gà')
    expect(products[0]!.price).toBe(168_500)
    expect(products[0]!.currency).toBe('VND')
    expect(products[0]!.image).toContain('abc')
    expect(products[0]!.brand).toBe('Ăn Cùng Bà Tuyết')
    expect(products[0]!.description).toMatch(/Mô tả/)
    expect(products[0]!.rating).toBe(4.89)
    expect(products[0]!.rating_count).toBe(34_988)
  })
})

describe('extractOpenGraph', () => {
  it('reads content-before-property order (Shopee share HTML)', () => {
    const html = `
<meta content="SP Title | Shopee Việt Nam" property="og:title"/>
<meta content="https://img.example/x.jpg" property="og:image"/>
`
    const og = extractOpenGraph(html)
    expect(og.title).toBe('SP Title | Shopee Việt Nam')
    expect(og.image).toBe('https://img.example/x.jpg')
  })
})
