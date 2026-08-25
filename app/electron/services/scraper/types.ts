/** Shared scraper contracts for marketplace product extraction. */

export type ScrapeStatus = 'scraping' | 'done' | 'partial' | 'error' | 'manual'

export type ScrapeResult = {
  /** Whether extraction produced any usable product fields (title, image, or price). */
  ok: boolean
  platform: string
  title: string | null
  image_url: string | null
  price: number | null
  currency: string
  category: string | null
  /** Full marketplace chain, e.g. "A > B > C". Null when unknown. */
  category_path?: string | null
  shop_name: string | null
  shop_id: string | null
  item_id: string | null
  description: string | null
  /** Product star rating 0–5 (e.g. 4.89). Optional — not all tiers provide it. */
  rating?: number | null
  /** Number of product reviews. */
  rating_count?: number | null
  /** Units sold when known (often unavailable while product API is blocked). */
  sold?: number | null
  /** Source tier that produced the data (api | browser | opengraph | cache | url_slug). */
  source: string | null
  error: string | null
}

export interface Scraper {
  readonly name: string
  match(url: string): boolean
  scrape(url: string): Promise<ScrapeResult>
}

export type NormalizedUrl = {
  /** Original input URL (user affiliate link, preserved as-is). */
  original_url: string
  /** Final URL after following redirects. */
  final_url: string
  platform: string
  shop_id: string | null
  item_id: string | null
  /**
   * Unique key:
   * - product: platform:shopId:itemId
   * - category: platform:cat:CATID
   * - shop: platform:shop:SHOPID
   * - else: platform:url:<stripped-final-url>
   */
  canonical_key: string
  /** Shopee link kind when platform is shopee (product/category/shop/search/unknown). */
  link_kind?: 'product' | 'category' | 'shop' | 'search' | 'unknown'
  /** Category id when link_kind is category. */
  category_id?: string | null
}

/**
 * Which of title / image / price are still missing (usable title only).
 * Exported for partial-status labels and tests.
 */
export function missingProductFields(
  result: Pick<ScrapeResult, 'title' | 'image_url' | 'price' | 'shop_id' | 'item_id'>,
  isUsableTitleFn: (
    title: string | null | undefined,
    opts?: { shop_id?: string | null; item_id?: string | null },
  ) => boolean,
): Array<'tên' | 'ảnh' | 'giá'> {
  const missing: Array<'tên' | 'ảnh' | 'giá'> = []
  const titleOk = isUsableTitleFn(result.title, {
    shop_id: result.shop_id,
    item_id: result.item_id,
  })
  if (!titleOk) missing.push('tên')
  if (!result.image_url?.trim()) missing.push('ảnh')
  if (result.price == null || !Number.isFinite(result.price)) missing.push('giá')
  return missing
}

/**
 * Vietnamese label for partial scrape — e.g. "Thiếu ảnh", "Thiếu tên, ảnh".
 * Distinct from "Xong" and "Lỗi (nhập tay)".
 */
export function partialMissingLabel(missing: Array<'tên' | 'ảnh' | 'giá'>): string {
  if (missing.length === 0) return 'Thiếu thông tin'
  if (missing.length === 1) return `Thiếu ${missing[0]}`
  if (missing.length === 2) return `Thiếu ${missing[0]}, ${missing[1]}`
  return `Thiếu ${missing[0]}, ${missing[1]}, ${missing[2]}`
}

/** Vietnamese labels for scrape_status stored values. */
export function scrapeStatusLabel(
  status: string | null | undefined,
  scrapeError?: string | null,
): string {
  switch (status) {
    case 'scraping':
      return 'Đang quét'
    case 'done':
      return 'Xong'
    case 'partial':
      // Prefer concrete missing-field label stored in scrape_error
      if (scrapeError?.trim() && /^Thiếu\b/i.test(scrapeError.trim())) {
        return scrapeError.trim()
      }
      return 'Thiếu thông tin'
    case 'error':
      return 'Lỗi (nhập tay)'
    case 'manual':
      return 'Nhập tay'
    default:
      return status?.trim() || 'Chưa quét'
  }
}

export function emptyScrapeResult(
  platform: string,
  error: string | null = null,
): ScrapeResult {
  return {
    ok: false,
    platform,
    title: null,
    image_url: null,
    price: null,
    currency: 'VND',
    category: null,
    category_path: null,
    shop_name: null,
    shop_id: null,
    item_id: null,
    description: null,
    rating: null,
    rating_count: null,
    sold: null,
    source: null,
    error,
  }
}
