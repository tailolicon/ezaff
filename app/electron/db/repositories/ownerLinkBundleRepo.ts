/**
 * Local store for the owner-link bundle synced from the Worker.
 *
 * Lookups here are the fast path for the copy flow: a single indexed read
 * against a table the app already has, no network, no timeout budget.
 */

import type Database from 'better-sqlite3'
import { C_VAL, T_KV } from '../storeIds'
import {
  isPackedStoreValue,
  packStoreValue,
  unpackStoreValue,
} from '../../services/ownerLinkMask'

/**
 * Bundle wire format v1 carries Shopee mappings only — shopId/itemId with no
 * platform column, because a per-row platform tag on 130k rows buys nothing
 * while there is exactly one platform. Adding Lazada means a v2 format, not a
 * half-tagged v1.
 */
export const BUNDLE_PLATFORM = 'shopee'

export type BundleEntry = {
  shopId: string
  itemId: string
  ownerUrl: string
}

export type BundleState = {
  version: number
  syncedAt: number | null
  entryCount: number
}

/** "shopee:1016604648:23258487489" — must match products.canonical_key. */
export function bundleCanonicalKey(shopId: string, itemId: string): string {
  return `${BUNDLE_PLATFORM}:${shopId}:${itemId}`
}

export function getBundleState(db: Database.Database): BundleState {
  const row = db
    .prepare(
      `SELECT version, synced_at, entry_count FROM bundle_state WHERE id = 1`,
    )
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

/** Owner link for a product, or null when the bundle has no mapping. */
export function getBundleOwnerUrl(
  db: Database.Database,
  canonicalKey: string,
): string | null {
  const row = db
    .prepare(`SELECT ${C_VAL} AS v FROM ${T_KV} WHERE canonical_key = ?`)
    .get(canonicalKey) as { v: string } | undefined

  const url = unpackStoreValue(row?.v?.trim() ?? '')
  return url ? url : null
}

export type ApplyBundleOptions = {
  /** Full snapshots replace the table; deltas merge into it. */
  replace?: boolean
  nowMs?: number
}

/**
 * Apply a synced bundle.
 *
 * One transaction for the whole batch — 130k individual autocommits would
 * take minutes and leave the table half-written if the app quit mid-sync.
 */
export function applyBundle(
  db: Database.Database,
  entries: BundleEntry[],
  version: number,
  options: ApplyBundleOptions = {},
): number {
  const nowMs = options.nowMs ?? Date.now()

  const insert = db.prepare(
    `INSERT INTO ${T_KV} (canonical_key, ${C_VAL})
     VALUES (?, ?)
     ON CONFLICT(canonical_key) DO UPDATE SET ${C_VAL} = excluded.${C_VAL}`,
  )

  const run = db.transaction((rows: BundleEntry[]) => {
    if (options.replace) {
      db.prepare(`DELETE FROM ${T_KV}`).run()
    }
    for (const row of rows) {
      const url = row.ownerUrl?.trim()
      if (!url) continue
      insert.run(
        bundleCanonicalKey(row.shopId, row.itemId),
        packStoreValue(url),
      )
    }
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM ${T_KV}`)
      .get() as { n: number }

    db.prepare(
      `UPDATE bundle_state
         SET version = ?, synced_at = ?, entry_count = ?
       WHERE id = 1`,
    ).run(version, nowMs, count.n)

    return count.n
  })

  return run(entries)
}

/**
 * Rewrite leftover plaintext rows (pre-010 installs) so a DB browse
 * does not show raw shortlinks. Safe to call on every launch.
 */
export function packLegacyBundleRows(db: Database.Database): number {
  const rows = db
    .prepare(
      `SELECT canonical_key, ${C_VAL} AS v FROM ${T_KV} WHERE ${C_VAL} NOT LIKE 'b1:%'`,
    )
    .all() as Array<{ canonical_key: string; v: string }>

  if (rows.length === 0) return 0

  const upd = db.prepare(
    `UPDATE ${T_KV} SET ${C_VAL} = ? WHERE canonical_key = ?`,
  )
  const run = db.transaction(() => {
    let n = 0
    for (const row of rows) {
      const plain = row.v?.trim()
      if (!plain || isPackedStoreValue(plain)) continue
      upd.run(packStoreValue(plain), row.canonical_key)
      n += 1
    }
    return n
  })
  return run()
}
