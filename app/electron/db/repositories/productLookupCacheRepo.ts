/**
 * Local product lookup cache — Phase 12.
 * Successful (or partial) Shopee product scrapes are stored by canonical_key
 * so re-paste / re-scrape is instant without hitting the network again.
 */

import type Database from 'better-sqlite3'
import type { ScrapeResult } from '../../services/scraper/types'

/** Positive product lookup cache: 7 days. */
export const PRODUCT_LOOKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Incomplete lookups (missing price / image) are usually a transient Shopee
 * block, not the truth about the product. Cache them only briefly so a bad
 * minute does not hide the price for a week.
 */
export const PRODUCT_LOOKUP_PARTIAL_TTL_MS = 30 * 60 * 1000

export type ProductLookupCacheRow = {
  canonical_key: string
  title: string | null
  image_url: string | null
  price: number | null
  currency: string
  category: string | null
  category_path: string | null
  shop_name: string | null
  shop_id: string | null
  item_id: string | null
  description: string | null
  rating: number | null
  rating_count: number | null
  sold: number | null
  source: string | null
  scraped_at: number
  expires_at: number
}

export type CachedProductLookup =
  | { hit: true; result: ScrapeResult; expiresAt: number }
  | { hit: false }

export function getProductLookupCache(
  db: Database.Database,
  canonicalKey: string,
  nowMs: number = Date.now(),
): CachedProductLookup {
  const row = db
    .prepare(
      `SELECT canonical_key, title, image_url, price, currency, category, category_path,
              shop_name, shop_id, item_id, description,
              rating, rating_count, sold, source,
              scraped_at, expires_at
       FROM product_lookup_cache
       WHERE canonical_key = ?`,
    )
    .get(canonicalKey) as ProductLookupCacheRow | undefined

  if (!row) return { hit: false }
  if (row.expires_at <= nowMs) return { hit: false }

  const result: ScrapeResult = {
    ok: true,
    platform: 'shopee',
    title: row.title,
    image_url: row.image_url,
    price: row.price,
    currency: row.currency || 'VND',
    category: row.category,
    category_path: row.category_path,
    shop_name: row.shop_name,
    shop_id: row.shop_id,
    item_id: row.item_id,
    description: row.description,
    rating: row.rating ?? null,
    rating_count: row.rating_count ?? null,
    sold: row.sold ?? null,
    source: row.source ? `cache:${row.source}` : 'cache',
    error: null,
  }

  return { hit: true, result, expiresAt: row.expires_at }
}

export function putProductLookupCache(
  db: Database.Database,
  canonicalKey: string,
  result: Pick<
    ScrapeResult,
    | 'title'
    | 'image_url'
    | 'price'
    | 'currency'
    | 'category'
    | 'category_path'
    | 'shop_name'
    | 'shop_id'
    | 'item_id'
    | 'description'
    | 'rating'
    | 'rating_count'
    | 'sold'
    | 'source'
  >,
  options: { nowMs?: number; ttlMs?: number } = {},
): void {
  const nowMs = options.nowMs ?? Date.now()
  const ttlMs = options.ttlMs ?? PRODUCT_LOOKUP_TTL_MS
  const expiresAt = nowMs + ttlMs

  db.prepare(
    `INSERT INTO product_lookup_cache (
       canonical_key, title, image_url, price, currency, category, category_path,
       shop_name, shop_id, item_id, description,
       rating, rating_count, sold, source,
       scraped_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(canonical_key) DO UPDATE SET
       title = excluded.title,
       image_url = excluded.image_url,
       price = excluded.price,
       currency = excluded.currency,
       category = excluded.category,
       category_path = excluded.category_path,
       shop_name = excluded.shop_name,
       shop_id = excluded.shop_id,
       item_id = excluded.item_id,
       description = excluded.description,
       rating = excluded.rating,
       rating_count = excluded.rating_count,
       sold = excluded.sold,
       source = excluded.source,
       scraped_at = excluded.scraped_at,
       expires_at = excluded.expires_at`,
  ).run(
    canonicalKey,
    result.title ?? null,
    result.image_url ?? null,
    result.price ?? null,
    result.currency || 'VND',
    result.category ?? null,
    result.category_path ?? null,
    result.shop_name ?? null,
    result.shop_id ?? null,
    result.item_id ?? null,
    result.description ?? null,
    result.rating ?? null,
    result.rating_count ?? null,
    result.sold ?? null,
    result.source ?? null,
    nowMs,
    expiresAt,
  )
}

export function deleteProductLookupCache(
  db: Database.Database,
  canonicalKey: string,
): void {
  db.prepare(`DELETE FROM product_lookup_cache WHERE canonical_key = ?`).run(
    canonicalKey,
  )
}
