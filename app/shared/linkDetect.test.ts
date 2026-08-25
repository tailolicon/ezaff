import { describe, expect, it } from 'vitest'
import { extractLinks, isSupportedLink } from './linkDetect'

describe('isSupportedLink', () => {
  it('accepts the marketplaces ezaff scrapes', () => {
    expect(isSupportedLink('https://shopee.vn/product/111/222')).toBe(true)
    expect(isSupportedLink('https://s.shopee.vn/2q8xK1a9Zv')).toBe(true)
    expect(isSupportedLink('https://www.lazada.vn/products/i2938471.html')).toBe(true)
    expect(isSupportedLink('https://vt.tiktok.com/ZS8kFq2mA/')).toBe(true)
    expect(isSupportedLink('https://tiki.vn/p/12938471')).toBe(true)
    expect(isSupportedLink('https://sendo.vn/abc')).toBe(true)
  })

  it('accepts Shopee mobile share short-links', () => {
    // These carry no "shopee." substring — the previous name match dropped them
    expect(isSupportedLink('https://shp.ee/abc123')).toBe(true)
    expect(isSupportedLink('https://shope.ee/abc123')).toBe(true)
  })

  it('rejects non-marketplace and malformed input', () => {
    expect(isSupportedLink('https://example.com/abc')).toBe(false)
    expect(isSupportedLink('không phải link')).toBe(false)
    expect(isSupportedLink('shopee.vn/product/1/2')).toBe(false) // no scheme
    expect(isSupportedLink('')).toBe(false)
  })

  it('is not fooled by a marketplace name inside another domain', () => {
    expect(isSupportedLink('https://shopee.vn.evil.com/x')).toBe(false)
    expect(isSupportedLink('https://faketiki.vn/x')).toBe(false)
  })
})

describe('extractLinks', () => {
  it('reads many links, one per line', () => {
    const text = [
      'https://s.shopee.vn/aaa',
      'https://www.lazada.vn/products/i1.html',
      'https://tiki.vn/p/2',
    ].join('\n')
    expect(extractLinks(text)).toEqual([
      'https://s.shopee.vn/aaa',
      'https://www.lazada.vn/products/i1.html',
      'https://tiki.vn/p/2',
    ])
  })

  it('reads many links separated by spaces or tabs on one line', () => {
    const text = 'https://s.shopee.vn/aaa https://shp.ee/bbb\thttps://tiki.vn/p/2'
    expect(extractLinks(text)).toHaveLength(3)
  })

  it('finds links inside a sentence copied from chat', () => {
    const text =
      'mua cái này nè https://s.shopee.vn/aaa, hoặc https://shp.ee/bbb nha!'
    expect(extractLinks(text)).toEqual([
      'https://s.shopee.vn/aaa',
      'https://shp.ee/bbb',
    ])
  })

  it('strips trailing punctuation but keeps query strings', () => {
    expect(extractLinks('https://tiki.vn/p/1?spid=88213.')).toEqual([
      'https://tiki.vn/p/1?spid=88213',
    ])
  })

  it('drops duplicates and keeps the original order', () => {
    const text = 'https://tiki.vn/p/2\nhttps://s.shopee.vn/a\nhttps://tiki.vn/p/2'
    expect(extractLinks(text)).toEqual([
      'https://tiki.vn/p/2',
      'https://s.shopee.vn/a',
    ])
  })

  it('ignores unrelated clipboard content', () => {
    expect(extractLinks('mật khẩu: hunter2\nghi chú linh tinh')).toEqual([])
    expect(extractLinks('')).toEqual([])
  })
})
