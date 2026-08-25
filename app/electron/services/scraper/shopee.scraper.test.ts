import { describe, expect, it } from 'vitest'
import {
  convertShopeePdpPrice,
  findCategoryInTree,
  gateScrapeResult,
  hasShopeeApiError,
  hasUsableScrapeContent,
  isShopeeChallengeTitle,
  isTrafficVerifyUrl,
  isUsableShopeeApiPayload,
  isUsableTitle,
  mapShopeeCategoryResponse,
  mapShopeePdpResponse,
  mapShopeeShopResponse,
  normalizeShopeePriceValue,
  pickPriceFromItem,
  selectScrapeTier,
  deriveScrapeStatus,
  isProductCardReady,
  pickShopNameFromPdp,
  derivePartialErrorMessage,
  shouldAttemptAuthenticatedProductPageTier,
  mergeScrapeFields,
  MANUAL_ENTRY_ERROR_VI,
  TRAFFIC_VERIFY_ERROR_VI,
  ANTIBOT_SIGNED_ERROR_VI,
  ANTIBOT_UNSIGNED_ERROR_VI,
  isShopeeAntiBotError,
  messageForProductLookupFailure,
  productLookupFailureResult,
  SHOPEE_SESSION_PARTITION,
  cleanShopeeOgTitle,
  mapShopeeSharePreviewHtml,
  extractCategoryFromShopeeHtml,
  isSpecLikeCategory,
  pickUsefulCategory,
  scoreShopeeSharePreviewHtml,
} from './shopee.scraper'
import { shopeePartitionWebPreferences } from './shopeeSession'
import type { ScrapeResult } from './types'
import { emptyScrapeResult, partialMissingLabel, scrapeStatusLabel } from './types'
import { readableProductTitleFromShopeeSlug } from './urlNormalizer'

function baseOk(partial: Partial<ScrapeResult> & { source: string }): ScrapeResult {
  return {
    ok: true,
    platform: 'shopee',
    title: 'SP',
    image_url: null,
    price: null,
    currency: 'VND',
    category: null,
    shop_name: null,
    shop_id: '1',
    item_id: '2',
    description: null,
    error: null,
    ...partial,
  }
}

describe('convertShopeePdpPrice', () => {
  it('divides micro-units by 100000 unconditionally', () => {
    // 150_000 VND stored as 15_000_000_000 micro-units
    expect(convertShopeePdpPrice(15_000_000_000)).toBe(150_000)
    // Cheap item 9_999 VND (below old 10M heuristic threshold when raw)
    expect(convertShopeePdpPrice(999_900_000)).toBe(9_999)
    // 1 VND edge
    expect(convertShopeePdpPrice(100_000)).toBe(1)
  })

  it('handles string micro-unit values', () => {
    expect(convertShopeePdpPrice('25000000000')).toBe(250_000)
  })

  it('returns null for non-positive or invalid input', () => {
    expect(convertShopeePdpPrice(0)).toBeNull()
    expect(convertShopeePdpPrice(-1)).toBeNull()
    expect(convertShopeePdpPrice(null)).toBeNull()
    expect(convertShopeePdpPrice(undefined)).toBeNull()
    expect(convertShopeePdpPrice('')).toBeNull()
    expect(convertShopeePdpPrice('abc')).toBeNull()
  })

  it('clamps implausible converted results', () => {
    // Rounds to 0 VND after division
    expect(convertShopeePdpPrice(1)).toBeNull()
    expect(convertShopeePdpPrice(49_999)).toBeNull()
    // Beyond 50 tỷ VND (max plausible) — micro-units still within safe integer range
    expect(convertShopeePdpPrice(50_000_000_000 * 100_000 + 100_000)).toBeNull()
    // Exactly at the cap is still accepted
    expect(convertShopeePdpPrice(50_000_000_000 * 100_000)).toBe(50_000_000_000)
  })
})

describe('pickPriceFromItem', () => {
  it('prefers price_min then price then price_max', () => {
    expect(
      pickPriceFromItem({
        price_min: 10_000_000_000,
        price: 12_000_000_000,
        price_max: 15_000_000_000,
      }),
    ).toBe(100_000)

    expect(
      pickPriceFromItem({
        price: 20_000_000_000,
        price_max: 30_000_000_000,
      }),
    ).toBe(200_000)
  })

  it('skips invalid candidates and uses the next', () => {
    expect(
      pickPriceFromItem({
        price_min: 0,
        price: 5_000_000_000,
      }),
    ).toBe(50_000)
  })

  it('falls back to models[] when top-level price is empty', () => {
    expect(
      pickPriceFromItem({
        price: 0,
        price_min: 0,
        models: [
          { price: 0 },
          { price_min: 16_850_000_000, price: 12_000_000_000 },
        ],
      }),
    ).toBe(168_500)
  })
})

describe('normalizeShopeePriceValue', () => {
  it('micro unit always divides by 100000', () => {
    expect(normalizeShopeePriceValue(16_850_000_000, 'micro')).toBe(168_500)
  })

  it('display unit keeps whole VND (DOM ₫ text)', () => {
    expect(normalizeShopeePriceValue(168_500, 'display')).toBe(168_500)
    expect(normalizeShopeePriceValue('168.500', 'display')).toBe(168_500)
    expect(normalizeShopeePriceValue('₫168.500', 'display')).toBe(168_500)
  })

  it('auto treats small values as VND and large as micro', () => {
    // Must NOT become 2 VND via blind ÷ 100000
    expect(normalizeShopeePriceValue(168_500, 'auto')).toBe(168_500)
    expect(normalizeShopeePriceValue(16_850_000_000, 'auto')).toBe(168_500)
  })
})

describe('hasShopeeApiError', () => {
  it('treats missing or zero error as success', () => {
    expect(hasShopeeApiError({})).toBe(false)
    expect(hasShopeeApiError({ error: 0 })).toBe(false)
    expect(hasShopeeApiError({ error: '0' })).toBe(false)
    expect(hasShopeeApiError({ error: null })).toBe(false)
    expect(hasShopeeApiError({ error: false })).toBe(false)
    expect(hasShopeeApiError({ error: '' })).toBe(false)
  })

  it('treats non-zero top-level error as failure', () => {
    expect(hasShopeeApiError({ error: 90309999 })).toBe(true)
    expect(hasShopeeApiError({ error: 1 })).toBe(true)
    expect(hasShopeeApiError({ error: 'error_auth' })).toBe(true)
    expect(hasShopeeApiError({ error: { code: 1 } })).toBe(true)
  })
})

describe('mapShopeePdpResponse', () => {
  const shopId = '111'
  const itemId = '222'

  it('maps a successful PDP body with micro-unit price', () => {
    const result = mapShopeePdpResponse(
      {
        error: 0,
        data: {
          item: {
            title: 'Áo thun basic',
            image: 'vn-111-abc',
            price: 15_000_000_000,
            price_min: 15_000_000_000,
            shop_name: 'Shop ABC',
            categories: [
              { display_name: 'Thời trang' },
              { display_name: 'Áo thun' },
            ],
            description: 'Mô tả SP',
          },
        },
      },
      shopId,
      itemId,
    )

    expect(result).not.toBeNull()
    expect(result!.ok).toBe(true)
    expect(result!.title).toBe('Áo thun basic')
    expect(result!.price).toBe(150_000)
    expect(result!.currency).toBe('VND')
    expect(result!.shop_id).toBe(shopId)
    expect(result!.item_id).toBe(itemId)
    expect(result!.shop_name).toBe('Shop ABC')
    expect(result!.category).toBe('Áo thun')
    expect(result!.source).toBe('api')
    expect(result!.image_url).toContain('vn-111-abc')
    expect(result!.description).toBe('Mô tả SP')
  })

  it('returns null when top-level error is non-zero (even if item present)', () => {
    const result = mapShopeePdpResponse(
      {
        error: 90309999,
        error_msg: 'Anti bot',
        data: {
          item: { title: 'Should not use', price: 1_000_000_000 },
        },
      },
      shopId,
      itemId,
    )
    expect(result).toBeNull()
  })

  it('keeps price-only as partial-usable (no title/name)', () => {
    const result = mapShopeePdpResponse(
      { error: 0, data: { item: { price: 1_000_000_000 } } },
      shopId,
      itemId,
    )
    expect(result).not.toBeNull()
    expect(result!.ok).toBe(true)
    expect(result!.title).toBeNull()
    expect(result!.price).toBe(10_000)
    expect(deriveScrapeStatus(result!)).toBe('partial')
  })

  it('accepts name field and images array', () => {
    const result = mapShopeePdpResponse(
      {
        data: {
          item: {
            name: 'Sản phẩm B',
            images: ['key-img-1', 'key-img-2'],
            price_min: 99_900_000_000,
          },
          shop: { name: 'Cửa hàng B' },
        },
      },
      shopId,
      itemId,
    )
    expect(result?.title).toBe('Sản phẩm B')
    expect(result?.price).toBe(999_000)
    expect(result?.shop_name).toBe('Cửa hàng B')
    expect(result?.image_url).toContain('key-img-1')
  })

  it('reads shop_detailed.name when item.shop_name is absent', () => {
    const result = mapShopeePdpResponse(
      {
        error: 0,
        data: {
          item: {
            title: 'Bình nước giữ nhiệt XCUP',
            image: 'vn-111-abc',
            price: 10_000_000_000,
          },
          shop_detailed: { name: 'LanMart Store' },
        },
      },
      shopId,
      itemId,
    )
    expect(result?.shop_name).toBe('LanMart Store')
    expect(deriveScrapeStatus(result!)).toBe('done')
    expect(isProductCardReady(result!)).toBe(true)
  })
})

describe('pickShopNameFromPdp / isProductCardReady', () => {
  it('prefers item.shop_name over nested shop objects', () => {
    expect(
      pickShopNameFromPdp(
        { shop: { name: 'Nested' } },
        { shop_name: 'Direct' },
      ),
    ).toBe('Direct')
  })

  it('title+image+price without shop is done but not card-ready', () => {
    const result = mapShopeePdpResponse(
      {
        error: 0,
        data: {
          item: {
            title: 'Bình nước giữ nhiệt XCUP',
            image: 'vn-111-abc',
            price: 10_000_000_000,
          },
        },
      },
      '1',
      '2',
    )
    expect(result?.shop_name).toBeNull()
    expect(deriveScrapeStatus(result!)).toBe('done')
    expect(isProductCardReady(result!)).toBe(false)
  })
})

describe('selectScrapeTier', () => {
  it('prefers API over browser when API ok', () => {
    expect(
      selectScrapeTier(
        baseOk({ source: 'api' }),
        baseOk({ source: 'browser' }),
      ),
    ).toBe('api')
  })

  it('falls back to browser when API missing or not ok', () => {
    expect(
      selectScrapeTier(null, baseOk({ source: 'browser' })),
    ).toBe('browser')
    expect(
      selectScrapeTier(
        emptyScrapeResult('shopee', 'fail'),
        baseOk({ source: 'browser' }),
      ),
    ).toBe('browser')
  })

  it('returns fail when neither tier succeeded', () => {
    expect(selectScrapeTier(null, null)).toBe('fail')
    expect(
      selectScrapeTier(
        emptyScrapeResult('shopee', 'a'),
        emptyScrapeResult('shopee', 'b'),
      ),
    ).toBe('fail')
  })
})

describe('isTrafficVerifyUrl — verify bounce detection (fact B)', () => {
  it('detects /verify/traffic paths', () => {
    expect(
      isTrafficVerifyUrl(
        'https://shopee.vn/verify/traffic/error?is_from_login=false&type=4',
      ),
    ).toBe(true)
    expect(
      isTrafficVerifyUrl('https://shopee.vn/verify/traffic?foo=1'),
    ).toBe(true)
  })

  it('detects /verify/captcha challenge pages', () => {
    expect(
      isTrafficVerifyUrl(
        'https://shopee.vn/verify/captcha?anti_bot_tracking_id=x&next=https%3A%2F%2Fshopee.vn%2Fproduct%2F1%2F2',
      ),
    ).toBe(true)
    expect(isShopeeChallengeTitle('Verify to Continue')).toBe(true)
    expect(isUsableTitle('Verify to Continue')).toBe(false)
  })

  it('rejects normal shopee pages', () => {
    expect(isTrafficVerifyUrl('https://shopee.vn/')).toBe(false)
    expect(
      isTrafficVerifyUrl(
        'https://shopee.vn/Fashion-Accessories-cat.11035853',
      ),
    ).toBe(false)
    expect(isTrafficVerifyUrl('')).toBe(false)
  })

  it('TRAFFIC_VERIFY_ERROR_VI is Vietnamese with diacritics', () => {
    expect(TRAFFIC_VERIFY_ERROR_VI).toMatch(/Shopee/)
    expect(TRAFFIC_VERIFY_ERROR_VI).toMatch(/nhập tay/)
    // Must contain diacritics (not ASCII-only)
    expect(/[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/i.test(
      TRAFFIC_VERIFY_ERROR_VI,
    )).toBe(true)
  })
})

describe('isUsableShopeeApiPayload — never trust HTTP 200 alone (fact D)', () => {
  it('rejects null / non-objects / empty payload', () => {
    expect(isUsableShopeeApiPayload(null)).toBe(false)
    expect(isUsableShopeeApiPayload(undefined)).toBe(false)
    expect(isUsableShopeeApiPayload([])).toBe(false)
    expect(isUsableShopeeApiPayload({})).toBe(false)
    expect(isUsableShopeeApiPayload({ error: 0 })).toBe(false)
  })

  it('rejects non-zero error field', () => {
    expect(
      isUsableShopeeApiPayload({
        error: 90309999,
        data: { item: { title: 'x' } },
      }),
    ).toBe(false)
  })

  it('rejects empty items array (soft block)', () => {
    expect(
      isUsableShopeeApiPayload({ error: 0, items: [] }),
    ).toBe(false)
    expect(
      isUsableShopeeApiPayload({ error: 0, data: { items: [] } }),
    ).toBe(false)
  })

  it('rejects data: null / empty data object', () => {
    expect(isUsableShopeeApiPayload({ error: 0, data: null })).toBe(false)
    expect(isUsableShopeeApiPayload({ error: 0, data: {} })).toBe(false)
  })

  it('rejects non-200 __http_status marker', () => {
    expect(
      isUsableShopeeApiPayload({
        __http_status: 403,
        data: { item: { title: 'x' } },
      }),
    ).toBe(false)
  })

  it('accepts a real-looking PDP payload', () => {
    expect(
      isUsableShopeeApiPayload({
        error: 0,
        data: { item: { title: 'Áo thun', price: 1 } },
      }),
    ).toBe(true)
  })
})

describe('mapShopeePdpResponse — payload validation', () => {
  it('returns null for empty items soft-block body', () => {
    expect(
      mapShopeePdpResponse(
        { error: 0, data: { items: [] } },
        '1',
        '2',
      ),
    ).toBeNull()
  })

  it('returns null when data is null despite error:0', () => {
    expect(
      mapShopeePdpResponse({ error: 0, data: null } as unknown as Record<
        string,
        unknown
      >, '1', '2'),
    ).toBeNull()
  })
})

describe('mapShopeeCategoryResponse', () => {
  const tree = {
    error: 0,
    data: {
      category_list: [
        {
          catid: 11035853,
          display_name: 'Thời Trang Phụ Kiện',
          image: 'vn-cat-img',
          children: [],
        },
        {
          catid: 100,
          name: 'Khác',
          children: [{ catid: 101, display_name: 'Con' }],
        },
      ],
    },
  }

  it('finds category by catid and builds Vietnamese title', () => {
    const result = mapShopeeCategoryResponse(
      tree,
      '11035853',
      'Danh mục: Fashion Accessories',
    )
    expect(result).not.toBeNull()
    expect(result!.ok).toBe(true)
    expect(result!.title).toBe('Danh mục: Thời Trang Phụ Kiện')
    expect(result!.category).toBe('Thời Trang Phụ Kiện')
    expect(result!.item_id).toBeNull()
    expect(result!.shop_id).toBeNull()
    expect(result!.image_url).toContain('vn-cat-img')
  })

  it('findCategoryInTree walks nested children', () => {
    const hit = findCategoryInTree(tree.data.category_list, '101')
    expect(hit?.name).toBe('Con')
  })

  it('rejects empty category_list', () => {
    expect(
      mapShopeeCategoryResponse(
        { error: 0, data: { category_list: [] } },
        '1',
        'fallback',
      ),
    ).toBeNull()
  })
})

describe('mapShopeeShopResponse', () => {
  it('maps shop base payload with Vietnamese title', () => {
    const result = mapShopeeShopResponse(
      {
        error: 0,
        data: {
          name: 'Shop Test ABC',
          shopid: 555,
          portrait: 'vn-shop-portrait',
        },
      },
      '555',
      'Gian hàng #555',
    )
    expect(result?.ok).toBe(true)
    expect(result?.title).toBe('Gian hàng: Shop Test ABC')
    expect(result?.shop_name).toBe('Shop Test ABC')
    expect(result?.shop_id).toBe('555')
    expect(result?.item_id).toBeNull()
    expect(result?.category).toBe('Gian hàng Shopee')
  })

  it('rejects error payload', () => {
    expect(
      mapShopeeShopResponse(
        { error: 1, data: { name: 'x' } },
        '1',
        'fb',
      ),
    ).toBeNull()
  })
})

describe('BUG 3 — junk title must not become scrape success', () => {
  const shopId = '502146001'
  const itemId = '26175826603'

  it('isUsableTitle rejects pure numeric / short / equal to ids', () => {
    expect(isUsableTitle(null)).toBe(false)
    expect(isUsableTitle('')).toBe(false)
    expect(isUsableTitle('ab')).toBe(false)
    expect(isUsableTitle(itemId, { shop_id: shopId, item_id: itemId })).toBe(
      false,
    )
    expect(isUsableTitle(shopId, { shop_id: shopId, item_id: itemId })).toBe(
      false,
    )
    expect(isUsableTitle('12345')).toBe(false)
    expect(isUsableTitle('Áo thun basic')).toBe(true)
    expect(
      isUsableTitle('Danh mục: Fashion Accessories'),
    ).toBe(true)
  })

  it('hasUsableScrapeContent requires title OR image', () => {
    expect(
      hasUsableScrapeContent({
        title: itemId,
        image_url: null,
        shop_id: shopId,
        item_id: itemId,
      }),
    ).toBe(false)
    expect(
      hasUsableScrapeContent({
        title: itemId,
        image_url: 'https://img.example/a.jpg',
        shop_id: shopId,
        item_id: itemId,
      }),
    ).toBe(true)
    expect(
      hasUsableScrapeContent({
        title: 'Áo thun',
        image_url: null,
        shop_id: shopId,
        item_id: itemId,
      }),
    ).toBe(true)
  })

  it('gateScrapeResult demotes bare item-id title + no image → error', () => {
    const junk: ScrapeResult = {
      ok: true,
      platform: 'shopee',
      title: itemId,
      image_url: null,
      price: null,
      currency: 'VND',
      category: null,
      shop_name: null,
      shop_id: shopId,
      item_id: itemId,
      description: null,
      source: 'url_slug',
      error: null,
    }
    const gated = gateScrapeResult(junk)
    expect(gated.ok).toBe(false)
    expect(gated.error).toBe(MANUAL_ENTRY_ERROR_VI)
    expect(gated.title).toBeNull()
    // Keep ids so the product row still has shop/item for re-scrape
    expect(gated.shop_id).toBe(shopId)
    expect(gated.item_id).toBe(itemId)
    // Vietnamese with diacritics
    expect(/[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/i.test(
      gated.error!,
    )).toBe(true)
  })

  it('gateScrapeResult keeps real title success', () => {
    const good = gateScrapeResult(
      baseOk({ source: 'api', title: 'Áo thun basic' }),
    )
    expect(good.ok).toBe(true)
    expect(good.title).toBe('Áo thun basic')
  })

  it('mapShopeePdpResponse drops pure-numeric name but keeps price', () => {
    const result = mapShopeePdpResponse(
      {
        error: 0,
        data: {
          item: {
            title: itemId,
            price: 1_000_000_000,
          },
        },
      },
      shopId,
      itemId,
    )
    expect(result).not.toBeNull()
    expect(result!.title).toBeNull()
    expect(result!.price).toBe(10_000)
  })

  it('mapShopeePdpResponse rejects pure-numeric name with nothing else', () => {
    expect(
      mapShopeePdpResponse(
        {
          error: 0,
          data: {
            item: {
              title: itemId,
            },
          },
        },
        shopId,
        itemId,
      ),
    ).toBeNull()
  })
})

describe('Phase 12 — partial status + slug title + auth DOM gate', () => {
  const shopId = '502146001'
  const itemId = '26175826603'

  it('deriveScrapeStatus: full → done, missing fields → partial, none → error', () => {
    expect(
      deriveScrapeStatus(
        baseOk({
          source: 'api',
          title: 'Áo thun basic',
          image_url: 'https://img.example/a.jpg',
          price: 99_000,
        }),
      ),
    ).toBe('done')

    expect(
      deriveScrapeStatus(
        baseOk({
          source: 'api',
          title: 'Áo thun basic',
          image_url: null,
          price: 99_000,
        }),
      ),
    ).toBe('partial')

    expect(
      deriveScrapeStatus(
        baseOk({
          source: 'api',
          title: 'Áo thun basic',
          image_url: null,
          price: null,
        }),
      ),
    ).toBe('partial')

    expect(
      deriveScrapeStatus(
        emptyScrapeResult('shopee', MANUAL_ENTRY_ERROR_VI),
      ),
    ).toBe('error')
  })

  it('partial labels are Vietnamese and distinct from Xong / Lỗi', () => {
    const titleOnly = baseOk({
      source: 'api',
      title: 'Áo thun basic',
      image_url: null,
      price: null,
    })
    expect(derivePartialErrorMessage(titleOnly)).toBe('Thiếu ảnh, giá')
    expect(partialMissingLabel(['ảnh'])).toBe('Thiếu ảnh')
    expect(partialMissingLabel(['tên'])).toBe('Thiếu tên')

    expect(scrapeStatusLabel('partial', 'Thiếu ảnh')).toBe('Thiếu ảnh')
    expect(scrapeStatusLabel('done')).toBe('Xong')
    expect(scrapeStatusLabel('error')).toBe('Lỗi (nhập tay)')
    expect(scrapeStatusLabel('partial', 'Thiếu ảnh')).not.toBe('Xong')
    expect(scrapeStatusLabel('partial', 'Thiếu ảnh')).not.toBe(
      'Lỗi (nhập tay)',
    )
  })

  it('gateScrapeResult keeps title without image as partial success', () => {
    const gated = gateScrapeResult(
      baseOk({
        source: 'api',
        title: 'Áo thun basic',
        image_url: null,
        price: null,
      }),
    )
    expect(gated.ok).toBe(true)
    expect(gated.title).toBe('Áo thun basic')
    expect(deriveScrapeStatus(gated)).toBe('partial')
  })

  it('slug-derived title accepted only when non-numeric / human-readable', () => {
    expect(
      readableProductTitleFromShopeeSlug(
        'https://shopee.vn/Ao-Thun-Basic-Cotton-i.111.222',
      ),
    ).toBe('Ao Thun Basic Cotton')

    expect(
      readableProductTitleFromShopeeSlug(
        'https://shopee.vn/product/502146001/26175826603',
      ),
    ).toBeNull()

    expect(
      readableProductTitleFromShopeeSlug(
        'https://shopee.vn/opaanlp/502146001/26175826603',
      ),
    ).toBeNull()

    // Pure numeric slug segment rejected
    expect(
      readableProductTitleFromShopeeSlug('https://shopee.vn/26175826603'),
    ).toBeNull()
  })

  it('authenticated DOM tier is NOT attempted when signed out', () => {
    expect(
      shouldAttemptAuthenticatedProductPageTier({
        signedIn: false,
        antiBot: true,
      }),
    ).toBe(false)
    expect(
      shouldAttemptAuthenticatedProductPageTier({
        signedIn: true,
        antiBot: true,
      }),
    ).toBe(true)
    expect(
      shouldAttemptAuthenticatedProductPageTier({
        signedIn: true,
        antiBot: false,
      }),
    ).toBe(false)
    // Missing price after OG/API — still try auth DOM when signed in
    expect(
      shouldAttemptAuthenticatedProductPageTier({
        signedIn: true,
        antiBot: false,
        priceMissing: true,
      }),
    ).toBe(true)
    expect(
      shouldAttemptAuthenticatedProductPageTier({
        signedIn: false,
        antiBot: false,
        priceMissing: true,
      }),
    ).toBe(false)
  })

  it('mergeScrapeFields keeps every obtained field', () => {
    const a = baseOk({
      source: 'api',
      title: 'Áo thun',
      image_url: null,
      price: null,
    })
    const b = baseOk({
      source: 'auth_dom',
      title: null,
      image_url: 'https://img.example/x.jpg',
      price: 50_000,
    })
    const merged = mergeScrapeFields(a, b)
    expect(merged.title).toBe('Áo thun')
    expect(merged.image_url).toContain('img.example')
    expect(merged.price).toBe(50_000)
    expect(deriveScrapeStatus(merged)).toBe('done')
  })

  it('junk numeric title alone is never done/partial success', () => {
    const junk = gateScrapeResult({
      ok: true,
      platform: 'shopee',
      title: itemId,
      image_url: null,
      price: null,
      currency: 'VND',
      category: null,
      shop_name: null,
      shop_id: shopId,
      item_id: itemId,
      description: null,
      source: 'url_slug',
      error: null,
    })
    expect(junk.ok).toBe(false)
    expect(deriveScrapeStatus(junk)).toBe('error')
  })
})

describe('share-preview Open Graph tier (no login)', () => {
  const shopId = '279658061'
  const itemId = '43508358436'

  const sampleHtml = `
<!doctype html><html><head>
<title data-rh="true">Combo 20 chân gà rút xương tê cay - ĂN CÀNG ĐÃ TUYỆT M28 | Shopee Việt Nam</title>
<meta data-rh="true" content="Combo 20 chân gà rút xương tê cay - ĂN CÀNG ĐÃ TUYỆT M28 | Shopee Việt Nam" property="og:title"/>
<meta data-rh="true" content="Mua Combo 20 chân gà rút xương tê cay giá tốt." property="og:description"/>
<meta data-rh="true" content="https://down-vn.img.susercontent.com/file/vn-11134207-81ztc-mo57bqj5k54y41" property="og:image"/>
<script data-rh="true" type="application/ld+json">{"@context":"http://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"item":{"@id":"https://shopee.vn/","name":"Shopee"}},{"@type":"ListItem","position":2,"item":{"@id":"https://shopee.vn/cat","name":"Bách Hóa Online"}},{"@type":"ListItem","position":3,"item":{"@id":"https://shopee.vn/cat2","name":"Đồ chế biến sẵn"}}]}</script>
</head><body></body></html>`

  it('cleanShopeeOgTitle strips marketplace suffix', () => {
    expect(
      cleanShopeeOgTitle(
        'Combo 20 chân gà | Shopee Việt Nam',
      ),
    ).toBe('Combo 20 chân gà')
    expect(cleanShopeeOgTitle('Áo thun - Shopee')).toBe('Áo thun')
    expect(cleanShopeeOgTitle('')).toBeNull()
  })

  it('scoreShopeeSharePreviewHtml prefers HTML with Product price', () => {
    const bareOg =
      '<meta property="og:title" content="Áo"/><meta property="og:image" content="https://x"/>'
    const withPrice = `${bareOg}<script type="application/ld+json">{"@type":"Product","offers":{"price":"168500.00"}}</script>`
    expect(scoreShopeeSharePreviewHtml(withPrice)).toBeGreaterThan(
      scoreShopeeSharePreviewHtml(bareOg),
    )
    expect(scoreShopeeSharePreviewHtml(withPrice)).toBeGreaterThanOrEqual(100)
  })

  it('mapShopeeSharePreviewHtml extracts title + image without login API', () => {
    const result = mapShopeeSharePreviewHtml(sampleHtml, shopId, itemId)
    expect(result?.ok).toBe(true)
    expect(result?.source).toBe('opengraph')
    expect(result?.title).toBe(
      'Combo 20 chân gà rút xương tê cay - ĂN CÀNG ĐÃ TUYỆT M28',
    )
    expect(result?.image_url).toContain('vn-11134207-81ztc-mo57bqj5k54y41')
    expect(result?.shop_id).toBe(shopId)
    expect(result?.item_id).toBe(itemId)
    // Price usually absent from bare OG meta → partial is fine
    expect(result?.price).toBeNull()
    expect(deriveScrapeStatus(result!)).toBe('partial')
  })

  it('mapShopeeSharePreviewHtml reads Product JSON-LD price + seller shop name', () => {
    const withProduct = `
<!doctype html><html><head>
<meta property="og:title" content="Combo 20 chân gà | Shopee Việt Nam"/>
<meta property="og:image" content="https://down-vn.img.susercontent.com/file/abc"/>
<script type="application/ld+json">${JSON.stringify({
      '@type': 'Product',
      name: 'Combo 20 chân gà',
      image: 'https://down-vn.img.susercontent.com/file/abc',
      description: 'COMBO 20 GÓI…',
      offers: {
        '@type': 'Offer',
        price: '168500.00',
        priceCurrency: 'VND',
        seller: { '@type': 'Organization', name: 'Ăn Cùng Bà Tuyết' },
      },
    })}</script>
</head></html>`
    const result = mapShopeeSharePreviewHtml(withProduct, shopId, itemId)
    expect(result?.ok).toBe(true)
    expect(result?.price).toBe(168_500)
    expect(result?.shop_name).toBe('Ăn Cùng Bà Tuyết')
    expect(result?.title).toMatch(/chân gà/i)
    expect(result?.rating).toBeNull() // no aggregateRating in this fixture
    expect(deriveScrapeStatus(result!)).toBe('done')
  })

  it('mapShopeeSharePreviewHtml extracts product rating (not shop)', () => {
    const withRating = `
<!doctype html><html><head>
<meta property="og:title" content="SP Test | Shopee Việt Nam"/>
<meta property="og:image" content="https://down-vn.img.susercontent.com/file/abc"/>
<script type="application/ld+json">${JSON.stringify({
      '@type': 'Product',
      name: 'SP Test',
      image: 'https://down-vn.img.susercontent.com/file/abc',
      offers: {
        '@type': 'Offer',
        price: '99000.00',
        priceCurrency: 'VND',
        seller: {
          '@type': 'Organization',
          name: 'Shop X',
          aggregateRating: { ratingValue: '4.1', ratingCount: '999999' },
        },
      },
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: '4.89',
        ratingCount: '34988',
      },
    })}</script>
</head></html>`
    const result = mapShopeeSharePreviewHtml(withRating, shopId, itemId)
    expect(result?.rating).toBe(4.89)
    expect(result?.rating_count).toBe(34_988)
    // Must NOT pick seller's inflated ratingCount
    expect(result?.rating_count).not.toBe(999_999)
  })

  it('extractCategoryFromShopeeHtml reads last non-product breadcrumb', () => {
    expect(extractCategoryFromShopeeHtml(sampleHtml)).toBe('Đồ chế biến sẵn')
    // When last crumb equals product title, use the previous category crumb
    const productTitle =
      'Combo 20 chân gà rút xương tê cay - ĂN CÀNG ĐÃ TUYẾT M28'
    const withProductCrumb = `
<script type="application/ld+json">${JSON.stringify({
      '@context': 'http://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, item: { name: 'Shopee' } },
        { '@type': 'ListItem', position: 2, item: { name: 'Bách Hóa Online' } },
        { '@type': 'ListItem', position: 3, item: { name: 'Đồ chế biến sẵn' } },
        { '@type': 'ListItem', position: 4, item: { name: productTitle } },
      ],
    })}</script>`
    expect(extractCategoryFromShopeeHtml(withProductCrumb, productTitle)).toBe(
      'Đồ chế biến sẵn',
    )
  })

  it('isSpecLikeCategory rejects Shopee filter facets, keeps real categories', () => {
    // Filter facets that Shopee exposes as the deepest breadcrumb
    expect(isSpecLikeCategory('Trên 20.000 mAh')).toBe(true)
    expect(isSpecLikeCategory('Dưới 500g')).toBe(true)
    expect(isSpecLikeCategory('Từ 6.5 inch')).toBe(true)
    expect(isSpecLikeCategory('5 - 10 kg')).toBe(true)
    expect(isSpecLikeCategory('128GB')).toBe(true)
    expect(isSpecLikeCategory('20000')).toBe(true)

    // Genuine categories must survive
    expect(isSpecLikeCategory('Pin dự phòng')).toBe(false)
    expect(isSpecLikeCategory('Nhà bếp')).toBe(false)
    expect(isSpecLikeCategory('Phụ kiện điện thoại')).toBe(false)
    expect(isSpecLikeCategory('Máy ảnh & Máy quay phim')).toBe(false)
  })

  it('pickUsefulCategory walks back past spec-like leaves', () => {
    expect(
      pickUsefulCategory([
        'Shopee',
        'Điện Thoại & Phụ Kiện',
        'Phụ kiện điện thoại',
        'Pin dự phòng',
        'Trên 20.000 mAh',
      ]),
    ).toBe('Pin dự phòng')

    // Product title crumb is never a category
    expect(
      pickUsefulCategory(
        ['Shopee', 'Nhà Cửa & Đời Sống', 'Nhà bếp', 'Nồi chiên Lock&Lock 5.5L'],
        'Nồi chiên Lock&Lock 5.5L',
      ),
    ).toBe('Nhà bếp')

    // Nothing usable at all
    expect(pickUsefulCategory(['Shopee', 'Khác'])).toBeNull()

    // Every level is spec-like -> keep the deepest rather than dropping it
    expect(pickUsefulCategory(['Trên 10 kg', 'Dưới 20 kg'])).toBe('Dưới 20 kg')
  })

  it('mapShopeePdpResponse skips a spec-like deepest category', () => {
    const payload = {
      item: {
        itemid: Number(itemId),
        shopid: Number(shopId),
        name: 'Sạc dự phòng 20000mAh',
        price: 356_000 * 100_000,
        categories: [
          { display_name: 'Điện Thoại & Phụ Kiện' },
          { display_name: 'Phụ kiện điện thoại' },
          { display_name: 'Pin dự phòng' },
          { display_name: 'Trên 20.000 mAh' },
        ],
      },
    }
    const result = mapShopeePdpResponse(payload, shopId, itemId)
    expect(result?.category).toBe('Pin dự phòng')
  })

  it('returns null for empty SPA shell without product meta', () => {
    const empty =
      '<html><head><title>Shopee</title></head><body></body></html>'
    expect(mapShopeeSharePreviewHtml(empty, shopId, itemId)).toBeNull()
  })

  it('selectScrapeTier prefers opengraph over browser when API fails', () => {
    expect(
      selectScrapeTier(
        null,
        baseOk({ source: 'browser' }),
        null,
        baseOk({ source: 'opengraph', title: 'OG product' }),
      ),
    ).toBe('opengraph')
  })
})

describe('Phase 11 — shared partition + anti-bot messages', () => {
  it('scraper webPreferences helper pins persist:shopee', () => {
    expect(SHOPEE_SESSION_PARTITION).toBe('persist:shopee')
    const prefs = shopeePartitionWebPreferences({ offscreen: true })
    expect(prefs.partition).toBe(SHOPEE_SESSION_PARTITION)
  })

  it('isShopeeAntiBotError matches 90309999', () => {
    expect(isShopeeAntiBotError({ error: 90309999 })).toBe(true)
    expect(isShopeeAntiBotError({ error: 0 })).toBe(false)
  })

  it('error message differs between signed-in and signed-out anti-bot failures', async () => {
    const unsigned = messageForProductLookupFailure({
      antiBot: true,
      signedIn: false,
    })
    const signed = messageForProductLookupFailure({
      antiBot: true,
      signedIn: true,
    })
    expect(unsigned).toBe(ANTIBOT_UNSIGNED_ERROR_VI)
    expect(signed).toBe(ANTIBOT_SIGNED_ERROR_VI)
    expect(unsigned).not.toBe(signed)
    expect(unsigned).toMatch(/Cài đặt/)
    expect(signed).toMatch(/đã đăng nhập/)

    const rOut = await productLookupFailureResult({
      antiBot: true,
      signedIn: false,
    })
    const rIn = await productLookupFailureResult({
      antiBot: true,
      signedIn: true,
    })
    expect(rOut.error).toBe(ANTIBOT_UNSIGNED_ERROR_VI)
    expect(rIn.error).toBe(ANTIBOT_SIGNED_ERROR_VI)
  })
})
