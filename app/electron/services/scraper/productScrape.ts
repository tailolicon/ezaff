/**
 * Orchestrates normalize → scrape → image cache → product create/update.
 * Scrape failure NEVER blocks saving: product is always persisted so the
 * user can fill title/image manually (status "Lỗi (nhập tay)").
 * Phase 12: partial fields are kept (status "partial" / "Thiếu ảnh"…).
 * Successful lookups are cached by canonical_key for instant re-paste.
 */

import type Database from 'better-sqlite3'
import {
  createProduct,
  getProductById,
  updateProduct,
  type Product,
} from '../../db/repositories/productRepo'
import {
  getProductMeta,
  type ProductMeta,
} from '../../db/repositories/productMetaRepo'
import {
  getProductLookupCache,
  putProductLookupCache,
  PRODUCT_LOOKUP_PARTIAL_TTL_MS,
} from '../../db/repositories/productLookupCacheRepo'
import { cacheImage } from './imageCache'

/** Keep a display name like "GOOJODOQ OFFICIAL SHOP" over a handle like "goojodoq". */
export function preferShopName(
  incoming: string | null | undefined,
  existing: string | null | undefined,
): string | null {
  const next = incoming?.trim() || null
  const prev = existing?.trim() || null
  if (!next) return prev
  if (!prev) return next
  const nextLooksHandle = /^[a-z0-9._-]+$/.test(next)
  const prevLooksDisplay = /\s/.test(prev) || /[A-ZÀ-Ỵ]/.test(prev)
  if (nextLooksHandle && prevLooksDisplay) return prev
  return next
}
import { scrapeUrl } from './registry'

function kickWantIfNeeded(db: Database.Database): void {
  void import('../wantReport')
    .then(({ nudgeWantReport }) => nudgeWantReport(db))
    .catch(() => {
      // Telemetry only.
    })
}
import {
  derivePartialErrorMessage,
  deriveScrapeStatus,
  gateScrapeResult,
  isUsableTitle,
} from './shopee.scraper'
import type { ScrapeResult } from './types'
import { normalizeUrl, type RedirectFollower } from './urlNormalizer'

export type CreateWithScrapeOptions = {
  /** Inject redirect follower (tests). */
  followRedirects?: RedirectFollower
  /** Skip network scrape (tests) — still saves product. */
  scrapeFn?: (url: string) => Promise<ScrapeResult>
  /** Skip image download (tests). */
  cacheImageFn?: (url: string) => Promise<string | null>
  /** Skip product lookup cache read/write (tests can force network). */
  skipLookupCache?: boolean
  /** Skip the synced metadata pre-fill (tests). */
  skipProductMeta?: boolean
}

/**
 * Cache is only used when it already has an image and/or price.
 * Title-only cache entries force a re-scrape (image/price often appear later).
 */
export function isCacheResultUseful(result: ScrapeResult): boolean {
  const hasImage = Boolean(result.image_url?.trim())
  const hasPrice =
    result.price != null && Number.isFinite(result.price) && result.price > 0
  return hasImage || hasPrice
}

/**
 * Map a ScrapeResult to DB scrape_status + scrape_error (Phase 12 partial).
 */
export function mapScrapeResultToStatus(result: ScrapeResult): {
  scrape_status: 'done' | 'partial' | 'error'
  scrape_error: string | null
  title: string | null
  image_url: string | null
  price: number | null
} {
  const gated = gateScrapeResult(result)
  const status = deriveScrapeStatus(gated)
  if (status === 'error') {
    return {
      scrape_status: 'error',
      scrape_error:
        gated.error ||
        result.error ||
        'Không quét được thông tin. Bạn có thể nhập tay tên và ảnh.',
      title: null,
      image_url: null,
      price: null,
    }
  }
  // Keep usable title only
  const title = isUsableTitle(gated.title, {
    shop_id: gated.shop_id,
    item_id: gated.item_id,
  })
    ? gated.title
    : null
  return {
    scrape_status: status,
    scrape_error: status === 'partial' ? derivePartialErrorMessage(gated) : null,
    title,
    image_url: gated.image_url,
    price: gated.price,
  }
}

/**
 * Create a product from an affiliate URL and run the scraper.
 * On scrape failure the product remains with scrape_status = 'error'.
 * Partial success keeps obtained fields with scrape_status = 'partial'.
 */
export async function createProductWithScrape(
  db: Database.Database,
  originalUrl: string,
  options: CreateWithScrapeOptions = {},
): Promise<Product> {
  const url = originalUrl.trim()

  // 1. Normalise (redirects + IDs + canonical_key)
  let platform: string | undefined
  let shop_id: string | null | undefined
  let item_id: string | null | undefined
  let scrapeTarget = url
  let resolvedUrl: string | undefined
  let canonicalKey: string | null = null

  try {
    const normalized = await normalizeUrl(url, options.followRedirects)
    platform = normalized.platform
    shop_id = normalized.shop_id
    item_id = normalized.item_id
    scrapeTarget = normalized.final_url || url
    resolvedUrl = normalized.final_url || undefined
    canonicalKey = normalized.canonical_key || null
  } catch {
    // Keep going — createProduct will validate URL itself.
  }

  // 2. Persist immediately with "Đang quét" so a crash mid-scrape still keeps the link
  const pending = createProduct(db, {
    original_url: url,
    resolved_url: resolvedUrl,
    platform,
    shop_id,
    item_id,
    scrape_status: 'scraping',
    scrape_error: null,
  })

  // Prefer key from the row (createProduct recomputes canonical_key)
  const cacheKey = pending.canonical_key || canonicalKey

  // 3. Lookup cache first (instant re-paste) — only when it has usable media
  // or price. Stale partial rows (title-only / no image) must not block a
  // fresh scrape that can fill image + price.
  let result: ScrapeResult | null = null
  if (cacheKey && !options.skipLookupCache) {
    try {
      const cached = getProductLookupCache(db, cacheKey)
      if (cached.hit && isCacheResultUseful(cached.result)) {
        result = cached.result
      }
    } catch {
      // ignore cache errors
    }
  }

  /*
   * 3b. Synced metadata — name, price, shop, rating, sold for anything the
   * harvest covers. Read before scraping so the card shows something real
   * straight away instead of an empty "Đang quét" placeholder.
   *
   * It does NOT replace the scrape: the bundle carries no image URL, and a
   * product with no picture looks broken. The scrape still runs for the
   * image and category — but if it fails, these values survive instead of
   * the whole add collapsing to "Lỗi — nhập tay". That matters, because
   * scrape failure is the normal outcome when Shopee's anti-bot wall trips.
   */
  let bundledMeta: ProductMeta | null = null
  if (cacheKey && !options.skipProductMeta) {
    try {
      bundledMeta = getProductMeta(db, cacheKey)
    } catch {
      // Metadata is an optimisation; never let it break an add.
    }
    if (bundledMeta) {
      try {
        updateProduct(db, {
          id: pending.id,
          title: bundledMeta.name,
          price: bundledMeta.priceVnd > 0 ? bundledMeta.priceVnd : null,
          shop_name: bundledMeta.shopName || null,
        })
      } catch {
        // ignore — the scrape below still writes the real row
      }
    }
  }

  // 4. Scrape when cache miss (never throws out of scrapeUrl)
  if (!result) {
    const scrapeFn = options.scrapeFn ?? scrapeUrl
    try {
      result = await scrapeFn(scrapeTarget)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result = {
        ok: false,
        platform: platform ?? pending.platform,
        title: null,
        image_url: null,
        price: null,
        currency: 'VND',
        category: null,
        category_path: null,
        shop_name: null,
        shop_id: shop_id ?? null,
        item_id: item_id ?? null,
        description: null,
        source: null,
        error: message,
      }
    }
  }

  /*
   * A failed scrape used to mean an unusable row. When the bundle knows the
   * product, fill the gaps from it rather than throwing that away.
   */
  if (bundledMeta) {
    if (!result.title?.trim()) result.title = bundledMeta.name
    if (result.price == null && bundledMeta.priceVnd > 0) {
      result.price = bundledMeta.priceVnd
    }
    if (!result.shop_name?.trim() && bundledMeta.shopName) {
      result.shop_name = bundledMeta.shopName
    }
  }

  const mapped = mapScrapeResultToStatus(result)

  // 5. Cache successful / partial product lookups
  if (
    cacheKey &&
    !options.skipLookupCache &&
    (mapped.scrape_status === 'done' || mapped.scrape_status === 'partial')
  ) {
    try {
      putProductLookupCache(db, cacheKey, {
        title: mapped.title,
        image_url: mapped.image_url,
        price: mapped.price,
        currency: result.currency || 'VND',
        category: result.category,
        category_path: result.category_path ?? null,
        shop_name: result.shop_name,
        shop_id: result.shop_id ?? shop_id ?? null,
        item_id: result.item_id ?? item_id ?? null,
        description: result.description,
        rating: result.rating ?? null,
        rating_count: result.rating_count ?? null,
        sold: result.sold ?? null,
        source: result.source,
      }, {
        ttlMs:
          mapped.scrape_status === 'done'
            ? undefined
            : PRODUCT_LOOKUP_PARTIAL_TTL_MS,
      })
    } catch {
      // ignore cache write errors
    }
  }

  // 6. Best-effort image cache
  let image_local: string | null = null
  if (mapped.image_url) {
    const cacheFn = options.cacheImageFn ?? cacheImage
    try {
      image_local = await cacheFn(mapped.image_url)
    } catch {
      image_local = null
    }
  }

  // 7. Apply scrape outcome — product already exists either way
  const saved = updateProduct(db, {
    id: pending.id,
    title: mapped.title,
    image_url: mapped.image_url,
    image_local,
    price: mapped.price,
    currency: result.currency || 'VND',
    category: result.category,
    category_path: result.category_path ?? null,
    shop_name: preferShopName(
      result.shop_name,
      bundledMeta?.shopName,
    ),
    rating: result.rating ?? null,
    rating_count: result.rating_count ?? null,
    sold: result.sold ?? null,
    shop_id: result.shop_id ?? shop_id ?? undefined,
    item_id: result.item_id ?? item_id ?? undefined,
    platform: result.platform || platform,
    scrape_status: mapped.scrape_status,
    scrape_error: mapped.scrape_error,
  })
  kickWantIfNeeded(db)
  return saved
}

/**
 * Re-run scraper for an existing product ("Quét lại").
 * Always keeps the product; updates scrape_status to done/partial/error.
 * Uses lookup cache when available (instant); pass skipLookupCache to force.
 */
export async function rescrapeProduct(
  db: Database.Database,
  productId: string,
  options: CreateWithScrapeOptions = {},
): Promise<Product> {
  const existing = getProductById(db, productId)
  if (!existing) {
    throw new Error('Không tìm thấy sản phẩm')
  }

  // Mark as scraping so UI can show "Đang quét"
  updateProduct(db, {
    id: productId,
    scrape_status: 'scraping',
    scrape_error: null,
  })

  let scrapeTarget = existing.original_url
  let cacheKey = existing.canonical_key
  try {
    const normalized = await normalizeUrl(
      existing.original_url,
      options.followRedirects,
    )
    scrapeTarget = normalized.final_url || existing.original_url
    cacheKey = normalized.canonical_key || existing.canonical_key
  } catch {
    // use original
  }

  let result: ScrapeResult | null = null
  if (cacheKey && !options.skipLookupCache) {
    try {
      const cached = getProductLookupCache(db, cacheKey)
      if (cached.hit && isCacheResultUseful(cached.result)) {
        result = cached.result
      }
    } catch {
      // ignore
    }
  }

  if (!result) {
    const scrapeFn = options.scrapeFn ?? scrapeUrl
    try {
      result = await scrapeFn(scrapeTarget)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result = {
        ok: false,
        platform: existing.platform,
        title: null,
        image_url: null,
        price: null,
        currency: existing.currency,
        category: null,
        category_path: null,
        shop_name: null,
        shop_id: existing.shop_id,
        item_id: existing.item_id,
        description: null,
        source: null,
        error: message,
      }
    }
  }

  if (result && !result.shop_name?.trim() && cacheKey) {
    try {
      const meta = getProductMeta(db, cacheKey)
      if (meta?.shopName?.trim()) result.shop_name = meta.shopName.trim()
    } catch {
      // meta is optional
    }
  }

  const mapped = mapScrapeResultToStatus(result)
  const keepOnError = mapped.scrape_status === 'error'

  if (
    cacheKey &&
    !options.skipLookupCache &&
    (mapped.scrape_status === 'done' || mapped.scrape_status === 'partial')
  ) {
    try {
      putProductLookupCache(db, cacheKey, {
        title: mapped.title,
        image_url: mapped.image_url,
        price: mapped.price,
        currency: result.currency || existing.currency || 'VND',
        category: result.category,
        category_path: result.category_path ?? null,
        shop_name: result.shop_name,
        shop_id: result.shop_id ?? existing.shop_id,
        item_id: result.item_id ?? existing.item_id,
        description: result.description,
        rating: result.rating ?? null,
        rating_count: result.rating_count ?? null,
        sold: result.sold ?? null,
        source: result.source,
      }, {
        ttlMs:
          mapped.scrape_status === 'done'
            ? undefined
            : PRODUCT_LOOKUP_PARTIAL_TTL_MS,
      })
    } catch {
      // ignore
    }
  }

  let image_local: string | null | undefined = undefined
  if (mapped.image_url && !keepOnError) {
    const cacheFn = options.cacheImageFn ?? cacheImage
    try {
      image_local = await cacheFn(mapped.image_url)
    } catch {
      image_local = undefined
    }
  }

  const saved = updateProduct(db, {
    id: productId,
    // On error keep manual edits; on done/partial apply obtained fields
    title: keepOnError ? existing.title : mapped.title,
    image_url: keepOnError ? existing.image_url : mapped.image_url,
    image_local:
      !keepOnError && image_local !== undefined
        ? image_local
        : existing.image_local,
    price: keepOnError ? existing.price : mapped.price,
    currency: keepOnError
      ? existing.currency
      : result.currency || existing.currency,
    category: keepOnError ? existing.category : result.category,
    category_path: keepOnError
      ? existing.category_path
      : (result.category_path ?? null),
    shop_name: keepOnError
      ? existing.shop_name
      : preferShopName(result.shop_name, existing.shop_name),
    rating: keepOnError ? existing.rating : (result.rating ?? null),
    rating_count: keepOnError
      ? existing.rating_count
      : (result.rating_count ?? null),
    sold: keepOnError ? existing.sold : (result.sold ?? null),
    shop_id: result.shop_id ?? existing.shop_id,
    item_id: result.item_id ?? existing.item_id,
    scrape_status: mapped.scrape_status,
    scrape_error: mapped.scrape_error,
  })
  kickWantIfNeeded(db)
  return saved
}
