/**
 * Local store for the product-metadata bundle synced from the Worker.
 *
 * Read on the add path to fill a product without touching the network.
 */

import type Database from 'better-sqlite3'
import { BUNDLE_PLATFORM } from './ownerLinkBundleRepo'

export type ProductMeta = {
  name: string
  shopName: string
  priceVnd: number
  historicalSold: number
  rating: number
  commissionPct: number
}

export type MetaEntry = ProductMeta & {
  shopId: string
  itemId: string
}

export type MetaState = {
  version: number
  syncedAt: number | null
  entryCount: number
}

export function getMetaState(db: Database.Database): MetaState {
  const row = db
    .prepare(`SELECT version, synced_at, entry_count FROM meta_state WHERE id = 1`)
    .get() as
    | { version: number; synced_at: number | null; entry_count: number }
    | undefined

  if (!row) return { version: 0, syncedAt: null, entryCount: 0 }
  return {
    version: Number(row.version),
    syncedAt: row.synced_at == null ? null : Number(row.synced_at),
    entryCount: Number(row.entry_count),
  }
}

/**
 * Metadata for a product, or null when the bundle has none.
 *
 * Returns null for rows the harvest captured no fields for — 4.7% of the real
 * bundle looks like that. A row with an empty name is worse than no row: the
 * caller would skip scraping and end up with a nameless product.
 */
export function getProductMeta(
  db: Database.Database,
  canonicalKey: string,
): ProductMeta | null {
  const row = db
    .prepare(
      `SELECT name, shop_name, price_vnd, historical_sold, rating, commission_pct
         FROM product_meta WHERE canonical_key = ?`,
    )
    .get(canonicalKey) as
    | {
        name: string
        shop_name: string
        price_vnd: number
        historical_sold: number
        rating: number
        commission_pct: number
      }
    | undefined

  if (!row) return null
  const name = row.name?.trim() ?? ''
  if (name === '') return null

  return {
    name,
    shopName: row.shop_name?.trim() ?? '',
    priceVnd: Number(row.price_vnd),
    historicalSold: Number(row.historical_sold),
    rating: Number(row.rating),
    commissionPct: Number(row.commission_pct),
  }
}

export type ApplyMetaOptions = {
  replace?: boolean
  nowMs?: number
}

/** One transaction for the whole batch — 132k autocommits would take minutes. */
export function applyMetaBundle(
  db: Database.Database,
  entries: MetaEntry[],
  version: number,
  options: ApplyMetaOptions = {},
): number {
  const nowMs = options.nowMs ?? Date.now()

  const insert = db.prepare(
    `INSERT INTO product_meta
       (canonical_key, name, shop_name, price_vnd, historical_sold, rating, commission_pct)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(canonical_key) DO UPDATE SET
       name = excluded.name,
       shop_name = excluded.shop_name,
       price_vnd = excluded.price_vnd,
       historical_sold = excluded.historical_sold,
       rating = excluded.rating,
       commission_pct = excluded.commission_pct`,
  )

  const run = db.transaction((rows: MetaEntry[]) => {
    if (options.replace) db.prepare(`DELETE FROM product_meta`).run()
    for (const r of rows) {
      insert.run(
        `${BUNDLE_PLATFORM}:${r.shopId}:${r.itemId}`,
        r.name,
        r.shopName,
        r.priceVnd,
        r.historicalSold,
        r.rating,
        r.commissionPct,
      )
    }
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM product_meta`)
      .get() as { n: number }

    db.prepare(
      `UPDATE meta_state SET version = ?, synced_at = ?, entry_count = ? WHERE id = 1`,
    ).run(version, nowMs, count.n)

    return count.n
  })

  return run(entries)
}
