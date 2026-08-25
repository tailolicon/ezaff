import type Database from 'better-sqlite3'
import { C_VAL, T_LK } from '../storeIds'
import {
  openOwnerUrl,
  sealOwnerUrl,
} from '../../services/ownerLinkCrypto'

/** Positive hit cache: 30 days. */
export const OWNER_LINK_POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Negative (null / missing) cache: 1 hour.
 * Avoids re-hitting the worker on every copy for products with no owner link.
 */
export const OWNER_LINK_NEGATIVE_TTL_MS = 60 * 60 * 1000

/** Sentinel stored in owner_url for negative cache entries (column is NOT NULL). */
export const OWNER_LINK_NEGATIVE_SENTINEL = ''

export type OwnerLinkCacheRow = {
  canonical_key: string
  v: string
  fetched_at: number
  expires_at: number
}

export type CachedOwnerLink =
  | { hit: true; ownerUrl: string | null; expiresAt: number }
  | { hit: false }

export function getOwnerLinkCache(
  db: Database.Database,
  canonicalKey: string,
  nowMs: number = Date.now(),
): CachedOwnerLink {
  const row = db
    .prepare(
      `SELECT canonical_key, ${C_VAL} AS v, fetched_at, expires_at
       FROM ${T_LK}
       WHERE canonical_key = ?`,
    )
    .get(canonicalKey) as OwnerLinkCacheRow | undefined

  if (!row) {
    return { hit: false }
  }
  if (row.expires_at <= nowMs) {
    return { hit: false }
  }

  if (row.v === OWNER_LINK_NEGATIVE_SENTINEL || row.v.trim() === '') {
    return { hit: true, ownerUrl: null, expiresAt: row.expires_at }
  }

  // Sealed blob or legacy plaintext
  const ownerUrl = openOwnerUrl(row.v)
  if (ownerUrl == null || ownerUrl === '') {
    // Corrupt / unreadable seal — treat as miss so we re-fetch
    return { hit: false }
  }

  return { hit: true, ownerUrl, expiresAt: row.expires_at }
}

export function putOwnerLinkCache(
  db: Database.Database,
  canonicalKey: string,
  ownerUrl: string | null,
  options: { nowMs?: number; ttlMs?: number } = {},
): void {
  const nowMs = options.nowMs ?? Date.now()
  const ttlMs =
    options.ttlMs ??
    (ownerUrl
      ? OWNER_LINK_POSITIVE_TTL_MS
      : OWNER_LINK_NEGATIVE_TTL_MS)
  const expiresAt = nowMs + ttlMs
  // Seal positive URLs so casual SQLite browsing does not reveal author links
  const storedUrl =
    ownerUrl == null || ownerUrl === ''
      ? OWNER_LINK_NEGATIVE_SENTINEL
      : sealOwnerUrl(ownerUrl)

  db.prepare(
    `INSERT INTO ${T_LK} (canonical_key, ${C_VAL}, fetched_at, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(canonical_key) DO UPDATE SET
       ${C_VAL} = excluded.${C_VAL},
       fetched_at = excluded.fetched_at,
       expires_at = excluded.expires_at`,
  ).run(canonicalKey, storedUrl, nowMs, expiresAt)
}

export function deleteOwnerLinkCache(
  db: Database.Database,
  canonicalKey: string,
): void {
  db.prepare(`DELETE FROM ${T_LK} WHERE canonical_key = ?`).run(canonicalKey)
}
