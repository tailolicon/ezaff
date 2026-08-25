import Database from 'better-sqlite3'
import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { MIGRATIONS } from './migrations'

export type DbStatus = {
  ok: boolean
  path: string
  tables: string[]
  error?: string
}

let db: Database.Database | null = null
let lastStatus: DbStatus | null = null

const EXPECTED_TABLES = [
  'products',
  'groups',
  'product_groups',
  'templates',
  'copy_events',
  'lk_idx',
  'product_lookup_cache',
  'settings',
  'products_fts',
] as const

function getDbPath(): string {
  const userData = app.getPath('userData')
  const dir = join(userData, 'data')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return join(dir, 'ezaff.db')
}

function ensureMigrationsTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `)
}

function applyMigrations(database: Database.Database): void {
  ensureMigrationsTable(database)

  const applied = new Set(
    database
      .prepare('SELECT id FROM schema_migrations')
      .all()
      .map((row) => (row as { id: string }).id),
  )

  const insertMigration = database.prepare(
    'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)',
  )

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) {
      continue
    }
    const run = database.transaction(() => {
      database.exec(migration.sql)
      insertMigration.run(migration.id, Date.now())
    })
    run()
  }
}

function listExpectedTables(database: Database.Database): string[] {
  const found: string[] = []
  const stmt = database.prepare(
    `SELECT name FROM sqlite_master
     WHERE name = ? AND type IN ('table', 'view')`,
  )
  for (const name of EXPECTED_TABLES) {
    const row = stmt.get(name) as { name: string } | undefined
    if (row) {
      found.push(row.name)
    }
  }
  return found
}

export function openDatabase(): DbStatus {
  try {
    const path = getDbPath()
    const database = new Database(path)
    database.pragma('journal_mode = WAL')
    database.pragma('foreign_keys = ON')
    applyMigrations(database)
    db = database

    const tables = listExpectedTables(database)
    const missing = EXPECTED_TABLES.filter((t) => !tables.includes(t))
    if (missing.length > 0) {
      lastStatus = {
        ok: false,
        path,
        tables,
        error: `Thiếu bảng: ${missing.join(', ')}`,
      }
      return lastStatus
    }

    lastStatus = { ok: true, path, tables }
    return lastStatus
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    lastStatus = {
      ok: false,
      path: '',
      tables: [],
      error: message,
    }
    return lastStatus
  }
}

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Cơ sở dữ liệu chưa được mở')
  }
  return db
}

export function getDbStatus(): DbStatus {
  if (lastStatus) {
    return lastStatus
  }
  return {
    ok: false,
    path: '',
    tables: [],
    error: 'Cơ sở dữ liệu chưa được khởi tạo',
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
