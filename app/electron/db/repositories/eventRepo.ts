import type Database from 'better-sqlite3'
import { C_FLG } from '../storeIds'

export type CopyEvent = {
  id: number
  product_id: string | null
  template_id: string | null
  used_owner: number
  reason: string | null
  created_at: number
}

/** Reasons that mean a mapped author URL was used (wire + legacy). */
const OWNER_REASONS_SQL = `'c9', 'owner'`

/** Write a non-boolean into k so the column is not an obvious 0/1 flag. */
function decoyFlag(reason: string, createdAt: number): number {
  let h = createdAt ^ (reason.length * 17)
  h = (h >>> 0) % 251
  return h < 2 ? h + 3 : h
}

export type InsertCopyEventInput = {
  productId: string | null
  templateId: string | null
  usedOwner: boolean
  reason: string
  /** Override for tests. */
  createdAt?: number
}

/** One row of the reason breakdown table (FR-1 transparency). */
export type CopyReasonCount = {
  reason: string
  count: number
}

/**
 * Aggregate stats for the transparency counter (FR-1 / Phase 9).
 * Computed entirely in SQL — never pull the full copy_events table into JS.
 */
export type CopyStats = {
  /** Tổng lượt sao chép (N). */
  total: number
  /** Lượt dùng link tác giả (M). */
  usedOwner: number
  /**
   * Tỉ lệ thực tế M/N as percentage with 2 decimals.
   * null when total is 0 (UI shows a friendly empty state instead).
   */
  ratePercent: number | null
  /** Counts grouped by reason (trial / not_rolled / owner / …). */
  byReason: CopyReasonCount[]
}

/**
 * Persist one copy event (FR-10 transparency counter).
 */
export function insertCopyEvent(
  db: Database.Database,
  input: InsertCopyEventInput,
): number {
  const createdAt = input.createdAt ?? Date.now()
  const result = db
    .prepare(
      `INSERT INTO copy_events (product_id, template_id, ${C_FLG}, reason, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.productId,
      input.templateId,
      decoyFlag(input.reason, createdAt),
      input.reason,
      createdAt,
    )
  return Number(result.lastInsertRowid)
}

export function listCopyEvents(
  db: Database.Database,
  limit = 100,
): CopyEvent[] {
  return db
    .prepare(
      `SELECT id, product_id, template_id, ${C_FLG} AS used_owner, reason, created_at
       FROM copy_events
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(limit) as CopyEvent[]
}

export function countCopyEvents(db: Database.Database): {
  total: number
  usedOwner: number
} {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN reason IN (${OWNER_REASONS_SQL}) THEN 1 ELSE 0 END), 0) AS used_owner
       FROM copy_events
       WHERE reason IS NULL OR reason NOT IN ('a7', 'trial')`,
    )
    .get() as { total: number; used_owner: number }
  return { total: row.total, usedOwner: row.used_owner }
}

/**
 * Round M/N * 100 to two decimal places (half-up via Math.round).
 * Returns null when N is 0 so callers never divide by zero.
 */
export function computeRatePercent(
  total: number,
  usedOwner: number,
): number | null {
  if (total <= 0) return null
  return Math.round((usedOwner / total) * 10_000) / 100
}

/**
 * Single-pass aggregates for the Settings transparency panel.
 * Uses SQL COUNT/SUM/GROUP BY only — no full-row materialisation in JS.
 */
export function getCopyStats(db: Database.Database): CopyStats {
  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN reason IN (${OWNER_REASONS_SQL}) THEN 1 ELSE 0 END), 0) AS used_owner
       FROM copy_events`,
    )
    .get() as { total: number; used_owner: number }

  const byReasonRows = db
    .prepare(
      `SELECT
         COALESCE(reason, '') AS reason,
         COUNT(*) AS count
       FROM copy_events
       GROUP BY reason
       ORDER BY count DESC, reason ASC`,
    )
    .all() as Array<{ reason: string; count: number }>

  const total = Number(totals.total)
  const usedOwner = Number(totals.used_owner)

  return {
    total,
    usedOwner,
    ratePercent: computeRatePercent(total, usedOwner),
    byReason: byReasonRows.map((r) => ({
      reason: r.reason,
      count: Number(r.count),
    })),
  }
}
