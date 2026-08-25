import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

/**
 * In-memory SQLite with all migrations applied (for repository unit tests).
 * Migrations are discovered from disk and applied in filename order, so a new
 * migration never needs to be registered here by hand.
 */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')

  const migrationsDir = join(__dirname, '..', 'migrations')
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    db.exec(readFileSync(join(migrationsDir, file), 'utf-8'))
  }
  return db
}
