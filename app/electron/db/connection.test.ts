import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from './migrations'

describe('001_init.sql migration', () => {
  const migrationPath = join(__dirname, 'migrations', '001_init.sql')

  it('exists on disk', () => {
    expect(existsSync(migrationPath)).toBe(true)
  })

  it('is registered in MIGRATIONS', () => {
    expect(MIGRATIONS.some((m) => m.id === '001_init.sql')).toBe(true)
    const body = MIGRATIONS.find((m) => m.id === '001_init.sql')?.sql ?? ''
    expect(body.length).toBeGreaterThan(100)
  })

  it('registers 002_fts_diacritics migration after 001', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids).toContain('002_fts_diacritics.sql')
    expect(ids.indexOf('002_fts_diacritics.sql')).toBeGreaterThan(
      ids.indexOf('001_init.sql'),
    )
    const body =
      MIGRATIONS.find((m) => m.id === '002_fts_diacritics.sql')?.sql ?? ''
    expect(body).toContain('remove_diacritics')
    expect(body).toContain('products_ai')
  })

  it('registers 003_copy_events_indexes after 002', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids).toContain('003_copy_events_indexes.sql')
    expect(ids.indexOf('003_copy_events_indexes.sql')).toBeGreaterThan(
      ids.indexOf('002_fts_diacritics.sql'),
    )
    const body =
      MIGRATIONS.find((m) => m.id === '003_copy_events_indexes.sql')?.sql ??
      ''
    expect(body).toContain('idx_copy_events_product_id')
    expect(body).toContain('idx_copy_events_reason')
  })

  it('registers 004_product_lookup_cache after 003', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids).toContain('004_product_lookup_cache.sql')
    expect(ids.indexOf('004_product_lookup_cache.sql')).toBeGreaterThan(
      ids.indexOf('003_copy_events_indexes.sql'),
    )
    const body =
      MIGRATIONS.find((m) => m.id === '004_product_lookup_cache.sql')?.sql ??
      ''
    expect(body).toContain('product_lookup_cache')
    expect(body).toContain('canonical_key')
  })

  it('registers 005_product_rating_sold after 004', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids).toContain('005_product_rating_sold.sql')
    expect(ids.indexOf('005_product_rating_sold.sql')).toBeGreaterThan(
      ids.indexOf('004_product_lookup_cache.sql'),
    )
    const body =
      MIGRATIONS.find((m) => m.id === '005_product_rating_sold.sql')?.sql ?? ''
    expect(body).toContain('rating_count')
    expect(body).toMatch(/\bsold\b/)
  })

  it('defines all required tables and FTS5', () => {
    const sql = readFileSync(migrationPath, 'utf-8')
    const required = [
      'CREATE TABLE IF NOT EXISTS products',
      'CREATE TABLE IF NOT EXISTS groups',
      'CREATE TABLE IF NOT EXISTS product_groups',
      'CREATE TABLE IF NOT EXISTS templates',
      'CREATE TABLE IF NOT EXISTS copy_events',
      'CREATE TABLE IF NOT EXISTS owner_link_cache',
      'CREATE TABLE IF NOT EXISTS settings',
      'CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5',
      'CREATE TRIGGER IF NOT EXISTS products_ai',
      'CREATE TRIGGER IF NOT EXISTS products_ad',
      'CREATE TRIGGER IF NOT EXISTS products_au',
    ]
    for (const fragment of required) {
      expect(sql).toContain(fragment)
    }
  })

  it('registers 010_opaque_store after 009', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids).toContain('010_opaque_store.sql')
    expect(ids.indexOf('010_opaque_store.sql')).toBeGreaterThan(
      ids.indexOf('009_product_meta.sql'),
    )
    const body =
      MIGRATIONS.find((m) => m.id === '010_opaque_store.sql')?.sql ?? ''
    expect(body).toContain('kv_idx')
    expect(body).toContain('lk_idx')
  })
})
