import { describe, expect, it } from 'vitest'
import {
  buildCanonicalKey,
  classifyShopeeLink,
  detectPlatform,
  extractShopeeCategoryId,
  extractShopeeIds,
  extractShopeeShopId,
  normalizeUrl,
  stripTrackingParams,
  titleFromShopeeUrlSlug,
  readableProductTitleFromShopeeSlug,
  type RedirectFollower,
} from './urlNormalizer'

const SHOP = '275295758'
const ITEM = '24680135790'
const EXPECTED_KEY = `shopee:${SHOP}:${ITEM}`
const REAL_CATEGORY_URL =
  'https://shopee.vn/Fashion-Accessories-cat.11035853?utm_medium=affiliates&utm_source=an_17341820026&utm_campaign=s-8V7uguLjwf'
const REAL_CATEGORY_ID = '11035853'

/** Simulated shortlink resolver → product URL (no real network in tests). */
const shortlinkFollow: RedirectFollower = async (url) => {
  if (url.includes('s.shopee.vn') || url.includes('shp.ee')) {
    return `https://shopee.vn/product/${SHOP}/${ITEM}`
  }
  return url
}

/** Real measured shortlink → category page (fact A). */
const categoryShortlinkFollow: RedirectFollower = async (url) => {
  if (url.includes('s.shopee.vn/8V7uguLjwf') || url.includes('8V7uguLjwf')) {
    return REAL_CATEGORY_URL
  }
  if (url.includes('s.shopee.vn') || url.includes('shp.ee')) {
    return `https://shopee.vn/product/${SHOP}/${ITEM}`
  }
  return url
}

describe('urlNormalizer', () => {
  describe('extractShopeeIds', () => {
    it('bóc shop/item từ /product/SHOP/ITEM', () => {
      expect(
        extractShopeeIds(`https://shopee.vn/product/${SHOP}/${ITEM}`),
      ).toEqual({ shop_id: SHOP, item_id: ITEM })
    })

    it('bóc shop/item từ slug-i.SHOP.ITEM', () => {
      expect(
        extractShopeeIds(
          `https://shopee.vn/Ao-thun-basic-i.${SHOP}.${ITEM}`,
        ),
      ).toEqual({ shop_id: SHOP, item_id: ITEM })
    })

    it('bóc shop/item từ /{username}/{shopId}/{itemId} (form 3)', () => {
      // Live measured: https://s.shopee.vn/2LXHbLfnc0 →
      // https://shopee.vn/opaanlp/502146001/26175826603
      expect(
        extractShopeeIds(
          'https://shopee.vn/opaanlp/502146001/26175826603',
        ),
      ).toEqual({ shop_id: '502146001', item_id: '26175826603' })

      expect(
        extractShopeeIds(
          `https://shopee.vn/seller_abc/${SHOP}/${ITEM}?utm_medium=affiliates`,
        ),
      ).toEqual({ shop_id: SHOP, item_id: ITEM })
    })

    it('không nhầm /shop/ID hoặc bare username thành product', () => {
      expect(extractShopeeIds('https://shopee.vn/shop/12345678')).toBeNull()
      expect(extractShopeeIds('https://shopee.vn/cool_shop_vn')).toBeNull()
      // Only two segments after root — not product form
      expect(
        extractShopeeIds('https://shopee.vn/opaanlp/502146001'),
      ).toBeNull()
      // First segment reserved
      expect(
        extractShopeeIds('https://shopee.vn/buyer/1/2'),
      ).toBeNull()
      // First segment pure numeric
      expect(
        extractShopeeIds('https://shopee.vn/123/456/789'),
      ).toBeNull()
    })
  })

  describe('8 dạng URL Shopee → cùng canonical_key', () => {
    const cases: { name: string; url: string; follow?: RedirectFollower }[] = [
      {
        name: '1. slug -i.SHOP.ITEM',
        url: `https://shopee.vn/Ao-thun-nam-basic-cotton-i.${SHOP}.${ITEM}`,
      },
      {
        name: '2. /product/SHOP/ITEM',
        url: `https://shopee.vn/product/${SHOP}/${ITEM}`,
      },
      {
        name: '3. shortlink s.shopee.vn',
        url: 'https://s.shopee.vn/5AbcXyZ12',
        follow: shortlinkFollow,
      },
      {
        name: '4. slug + af_id',
        url: `https://shopee.vn/Ao-thun-i.${SHOP}.${ITEM}?af_id=abc123xyz`,
      },
      {
        name: '5. product + smtt',
        url: `https://shopee.vn/product/${SHOP}/${ITEM}?smtt=9.abc.def`,
      },
      {
        name: '6. slug + utm_*',
        url: `https://shopee.vn/Ao-thun-i.${SHOP}.${ITEM}?utm_source=fb&utm_medium=cpc&utm_campaign=sale`,
      },
      {
        name: '7. product + pid + sub_id',
        url: `https://shopee.vn/product/${SHOP}/${ITEM}?pid=aff001&sub_id=creator99`,
      },
      {
        name: '8. shortlink + tracking params',
        url: 'https://s.shopee.vn/5AbcXyZ12?af_id=x&utm_source=ig&pid=p1&sub_id=s1&smtt=1',
        follow: shortlinkFollow,
      },
    ]

    it.each(cases)('$name', async ({ url, follow }) => {
      const result = await normalizeUrl(url, follow ?? (async (u) => u))
      expect(result.platform).toBe('shopee')
      expect(result.shop_id).toBe(SHOP)
      expect(result.item_id).toBe(ITEM)
      expect(result.canonical_key).toBe(EXPECTED_KEY)
      // original affiliate URL is preserved for the user
      expect(result.original_url).toBe(url.trim())
    })

    it('tất cả 8 dạng cho cùng một key', async () => {
      const keys = await Promise.all(
        cases.map(({ url, follow }) =>
          normalizeUrl(url, follow ?? (async (u) => u)).then(
            (r) => r.canonical_key,
          ),
        ),
      )
      expect(new Set(keys).size).toBe(1)
      expect(keys[0]).toBe(EXPECTED_KEY)
    })
  })

  describe('URL không phải Shopee', () => {
    it('Lazada → platform lazada, key dạng url:', async () => {
      const url =
        'https://www.lazada.vn/products/ao-thun-i123.html?utm_source=fb&af_id=1'
      const result = await normalizeUrl(url, async (u) => u)
      expect(result.platform).toBe('lazada')
      expect(result.shop_id).toBeNull()
      expect(result.item_id).toBeNull()
      expect(result.canonical_key.startsWith('lazada:url:')).toBe(true)
      // tracking stripped from key
      expect(result.canonical_key).not.toContain('utm_source')
      expect(result.canonical_key).not.toContain('af_id')
    })

    it('Tiki → platform tiki', async () => {
      const url = 'https://tiki.vn/san-pham-p123.html'
      const result = await normalizeUrl(url, async (u) => u)
      expect(result.platform).toBe('tiki')
      expect(result.canonical_key).toContain('tiki:url:')
    })

    it('domain lạ → platform other', async () => {
      const url = 'https://example.com/item/42?pid=x'
      const result = await normalizeUrl(url, async (u) => u)
      expect(result.platform).toBe('other')
      expect(result.canonical_key.startsWith('other:url:')).toBe(true)
      expect(result.canonical_key).not.toContain('pid=')
    })
  })

  describe('helpers', () => {
    it('detectPlatform nhận diện đúng host', () => {
      expect(detectPlatform('https://shopee.vn/x')).toBe('shopee')
      expect(detectPlatform('https://s.shopee.vn/x')).toBe('shopee')
      expect(detectPlatform('https://www.lazada.vn/x')).toBe('lazada')
      expect(detectPlatform('https://tiki.vn/x')).toBe('tiki')
      expect(detectPlatform('https://shop.tiktok.com/x')).toBe('tiktok')
      expect(detectPlatform('https://sendo.vn/x')).toBe('sendo')
      expect(detectPlatform('https://foo.bar/x')).toBe('other')
    })

    it('stripTrackingParams bỏ af_id smtt utm pid sub_id', () => {
      const raw = `https://shopee.vn/product/${SHOP}/${ITEM}?af_id=a&smtt=b&utm_source=c&pid=d&sub_id=e&keep=1`
      const stripped = stripTrackingParams(raw)
      expect(stripped).not.toMatch(/af_id|smtt|utm_source|pid=|sub_id/)
      expect(stripped).toContain('keep=1')
    })

    it('buildCanonicalKey ưu tiên shop:item', () => {
      expect(
        buildCanonicalKey({
          url: 'https://shopee.vn/x',
          platform: 'shopee',
          shop_id: '1',
          item_id: '2',
        }),
      ).toBe('shopee:1:2')
    })

    it('reject URL rỗng / không hợp lệ', async () => {
      await expect(normalizeUrl('')).rejects.toThrow(/trống|hợp lệ/i)
      await expect(normalizeUrl('not-a-url')).rejects.toThrow(/hợp lệ/i)
    })
  })

  describe('classifyShopeeLink — product / category / shop / search / unknown', () => {
    it('product: slug -i.SHOP.ITEM', () => {
      expect(
        classifyShopeeLink(
          `https://shopee.vn/Ao-thun-basic-i.${SHOP}.${ITEM}`,
        ),
      ).toBe('product')
    })

    it('product: /product/SHOP/ITEM', () => {
      expect(
        classifyShopeeLink(`https://shopee.vn/product/${SHOP}/${ITEM}`),
      ).toBe('product')
    })

    it('product: /{username}/{shopId}/{itemId} (form 3 — not shop)', () => {
      const url =
        'https://shopee.vn/opaanlp/502146001/26175826603?__mobile__=1&credential_token=secret'
      expect(classifyShopeeLink(url)).toBe('product')
      // Must never be mis-classified as shop
      expect(classifyShopeeLink(url)).not.toBe('shop')
    })

    it('category: real measured Fashion-Accessories-cat.11035853', () => {
      expect(classifyShopeeLink(REAL_CATEGORY_URL)).toBe('category')
      expect(extractShopeeCategoryId(REAL_CATEGORY_URL)).toBe(REAL_CATEGORY_ID)
      // Product ID extractor must not claim this is a product
      expect(extractShopeeIds(REAL_CATEGORY_URL)).toBeNull()
    })

    it('category: /category/ID', () => {
      expect(
        classifyShopeeLink('https://shopee.vn/category/11035853'),
      ).toBe('category')
    })

    it('shop: /shop/ID', () => {
      expect(classifyShopeeLink('https://shopee.vn/shop/12345678')).toBe(
        'shop',
      )
      expect(extractShopeeShopId('https://shopee.vn/shop/12345678')).toBe(
        '12345678',
      )
    })

    it('shop: bare seller username path', () => {
      expect(classifyShopeeLink('https://shopee.vn/cool_shop_vn')).toBe('shop')
    })

    it('search: /search?keyword=', () => {
      expect(
        classifyShopeeLink(
          'https://shopee.vn/search?keyword=ao%20thun',
        ),
      ).toBe('search')
    })

    it('unknown: homepage / other paths', () => {
      expect(classifyShopeeLink('https://shopee.vn/')).toBe('unknown')
      expect(classifyShopeeLink('https://shopee.vn/portal/sale')).toBe(
        'unknown',
      )
    })
  })

  describe('canonical_key stable per link kind', () => {
    it('category → platform:cat:CATID (stable across tracking params)', () => {
      const a = buildCanonicalKey({
        url: REAL_CATEGORY_URL,
        platform: 'shopee',
        link_kind: 'category',
        category_id: REAL_CATEGORY_ID,
      })
      const b = buildCanonicalKey({
        url: `https://shopee.vn/Fashion-Accessories-cat.${REAL_CATEGORY_ID}?af_id=x&utm_source=y`,
        platform: 'shopee',
      })
      expect(a).toBe(`shopee:cat:${REAL_CATEGORY_ID}`)
      expect(b).toBe(`shopee:cat:${REAL_CATEGORY_ID}`)
      expect(a).toBe(b)
    })

    it('shop → platform:shop:SHOPID', () => {
      expect(
        buildCanonicalKey({
          url: 'https://shopee.vn/shop/999',
          platform: 'shopee',
          shop_id: '999',
          link_kind: 'shop',
        }),
      ).toBe('shopee:shop:999')
      expect(
        buildCanonicalKey({
          url: 'https://shopee.vn/shop/999?utm_medium=affiliates',
          platform: 'shopee',
        }),
      ).toBe('shopee:shop:999')
    })

    it('product still platform:shop:item (unchanged)', () => {
      expect(
        buildCanonicalKey({
          url: `https://shopee.vn/x-i.${SHOP}.${ITEM}`,
          platform: 'shopee',
          shop_id: SHOP,
          item_id: ITEM,
        }),
      ).toBe(EXPECTED_KEY)
    })

    it('normalizeUrl category shortlink → cat key, no item_id', async () => {
      const result = await normalizeUrl(
        'https://s.shopee.vn/8V7uguLjwf',
        categoryShortlinkFollow,
      )
      expect(result.platform).toBe('shopee')
      expect(result.link_kind).toBe('category')
      expect(result.category_id).toBe(REAL_CATEGORY_ID)
      expect(result.item_id).toBeNull()
      expect(result.shop_id).toBeNull()
      expect(result.canonical_key).toBe(`shopee:cat:${REAL_CATEGORY_ID}`)
    })

    it('normalizeUrl direct category URL → cat key', async () => {
      const result = await normalizeUrl(REAL_CATEGORY_URL, async (u) => u)
      expect(result.canonical_key).toBe(`shopee:cat:${REAL_CATEGORY_ID}`)
      expect(result.link_kind).toBe('category')
    })

    it('titleFromShopeeUrlSlug category → Vietnamese prefix', () => {
      const title = titleFromShopeeUrlSlug(REAL_CATEGORY_URL, 'category')
      expect(title).toMatch(/^Danh mục:/)
      expect(title.toLowerCase()).toContain('fashion')
    })

    it('readableProductTitleFromShopeeSlug accepts human slug only', () => {
      expect(
        readableProductTitleFromShopeeSlug(
          'https://shopee.vn/Dep-Quai-Ngang-i.275295758.24680135790',
        ),
      ).toMatch(/Dep Quai Ngang/i)
      expect(
        readableProductTitleFromShopeeSlug(
          `https://shopee.vn/product/${SHOP}/${ITEM}`,
        ),
      ).toBeNull()
    })
  })

  describe('BUG 2 — canonical_key strips tracking / Shopee query entirely', () => {
    /**
     * Exact live redirect target for https://s.shopee.vn/2LXHbLfnc0
     * (credential_token truncated in comments only — full values used in test).
     */
    const LIVE_PRODUCT_URL =
      'https://shopee.vn/opaanlp/502146001/26175826603?__mobile__=1&credential_token=8wEwiDL7YDttCffqNoHuve8euJass9Mneb5ysxWZCz&exp_group=rollout&gads_t_sig=gqRjZGVrxHCFomtpsTE0MjUxOnRzc19zZGtfa2V5&mmp_pid=an_17330510625&uls_trackid=56al58tt00i7&utm_campaign=id_8K8Hva330q9&utm_content=----&utm_medium=affiliates&utm_source=an_17330510625&utm_term=fbzjj4w3ddeo'

    it('hai bản tracking khác nhau của cùng product → cùng canonical_key', async () => {
      const a = LIVE_PRODUCT_URL
      const b =
        'https://shopee.vn/opaanlp/502146001/26175826603?utm_medium=affiliates&utm_source=other&credential_token=DIFFERENT_TOKEN&mmp_pid=an_999&af_id=zzz'

      const ra = await normalizeUrl(a, async (u) => u)
      const rb = await normalizeUrl(b, async (u) => u)

      expect(ra.link_kind).toBe('product')
      expect(rb.link_kind).toBe('product')
      expect(ra.shop_id).toBe('502146001')
      expect(ra.item_id).toBe('26175826603')
      expect(ra.canonical_key).toBe('shopee:502146001:26175826603')
      expect(rb.canonical_key).toBe(ra.canonical_key)
      // Never store credential_token / tracking in the key
      expect(ra.canonical_key).not.toContain('credential_token')
      expect(ra.canonical_key).not.toContain('utm_')
      expect(ra.canonical_key).not.toContain('mmp_pid')
      expect(ra.canonical_key).not.toContain('gads_t_sig')
      expect(ra.canonical_key).not.toContain('__mobile__')
    })

    it('Shopee url fallback strips entire query string', () => {
      // Unresolved path without extractable IDs (unknown kind)
      const key = buildCanonicalKey({
        url: 'https://shopee.vn/some-unknown-path?credential_token=SECRET&utm_source=x&mmp_pid=y',
        platform: 'shopee',
        link_kind: 'unknown',
      })
      expect(key).toBe('shopee:url:https://shopee.vn/some-unknown-path')
      expect(key).not.toContain('credential_token')
      expect(key).not.toContain('?')
    })

    it('stripTrackingParams drops mmp_pid, credential_token, gads_t_sig, __mobile__', () => {
      const raw =
        'https://example.com/item?credential_token=sec&mmp_pid=an_1&uls_trackid=u1&gads_t_sig=sig&exp_group=r&__mobile__=1&utm_term=t&keep=yes'
      const stripped = stripTrackingParams(raw)
      expect(stripped).not.toMatch(
        /credential_token|mmp_pid|uls_trackid|gads_t_sig|exp_group|__mobile__|utm_term/,
      )
      expect(stripped).toContain('keep=yes')
    })

    it('form-3 product + shortlink-style resolve → shop:item key (not url:)', async () => {
      const follow: RedirectFollower = async (url) => {
        if (url.includes('2LXHbLfnc0')) return LIVE_PRODUCT_URL
        return url
      }
      const result = await normalizeUrl(
        'https://s.shopee.vn/2LXHbLfnc0',
        follow,
      )
      expect(result.canonical_key).toBe('shopee:502146001:26175826603')
      expect(result.link_kind).toBe('product')
      expect(result.shop_id).toBe('502146001')
      expect(result.item_id).toBe('26175826603')
    })
  })
})
