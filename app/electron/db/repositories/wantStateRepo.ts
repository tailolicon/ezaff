import type Database from 'better-sqlite3'

export type WantState = {
  reportedAt: number | null
  reportedCount: number
}

export function getWantState(db: Database.Database): WantState {
  const row = db
    .prepare(`SELECT reported_at, reported_count FROM want_state WHERE id = 1`)
    .get() as
    | { reported_at: number | null; reported_count: number }
    | undefined

  if (!row) return { reportedAt: null, reportedCount: 0 }
  return {
    reportedAt: row.reported_at == null ? null : Number(row.reported_at),
    reportedCount: Number(row.reported_count),
  }
}

export function setWantState(db: Database.Database, state: WantState): void {
  db.prepare(
    `UPDATE want_state SET reported_at = ?, reported_count = ? WHERE id = 1`,
  ).run(state.reportedAt, state.reportedCount)
}
