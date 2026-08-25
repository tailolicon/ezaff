import { gzipSync } from 'node:zlib'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyBundle,
  getBundleOwnerUrl,
  getBundleState,
} from '../db/repositories/ownerLinkBundleRepo'
import { createTestDb } from '../db/repositories/testDb'
import { importSeedBundle } from './bundleSeed'
import { syncOwnerLinkBundle } from './bundleSync'

let db: Database.Database

beforeEach(() => {
  db = createTestDb()
})

afterEach(() => {
  db.close()
})

function seed(version: number, rows: Array<[string, string, string]>): Buffer {
  const body = `v1 ${version} ${rows.length}\n${rows
    .map(([s, i, p]) => `${s},${i},${p}`)
    .join('\n')}\n`
  return gzipSync(Buffer.from(body, 'utf8'))
}

describe('importSeedBundle', () => {
  it('imports the shipped mappings on a fresh install', () => {
    const result = importSeedBundle(db, {
      readSeed: () => seed(7, [['1', '2', '0aaa'], ['3', '4', '0bbb']]),
      now: () => 1000,
    })

    expect(result).toMatchObject({ imported: 2, version: 7, reason: 'seeded' })
    expect(getBundleOwnerUrl(db, 'shopee:1:2')).toBe('https://s.shopee.vn/aaa')
  })

  /*
   * The failure this pins is silent: leaving version at 0 still "works", but
   * the first sync then asks ?since=0, gets the whole snapshot back, and every
   * install pays for a 2 MB transfer it did not need — forever, unnoticed.
   */
  it('records the seed version so the first sync asks for a delta', async () => {
    importSeedBundle(db, {
      readSeed: () => seed(7, [['1', '2', '0aaa']]),
    })
    expect(getBundleState(db).version).toBe(7)

    const fetchImpl = vi.fn(async () => ({
      status: 204,
      ok: false,
      headers: { get: () => null },
      text: async () => '',
    }))
    await syncOwnerLinkBundle(db, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      workerUrl: 'http://worker.test',
    })

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'http://worker.test/v1/bundle?since=7',
    )
  })

  it('never overwrites a database that has already synced', () => {
    applyBundle(
      db,
      [{ shopId: '9', itemId: '9', ownerUrl: 'https://s.shopee.vn/live' }],
      42,
    )

    const result = importSeedBundle(db, {
      readSeed: () => seed(7, [['1', '2', '0aaa']]),
    })

    expect(result.reason).toBe('already_synced')
    expect(getBundleState(db).version).toBe(42)
    expect(getBundleOwnerUrl(db, 'shopee:9:9')).toBe('https://s.shopee.vn/live')
    expect(getBundleOwnerUrl(db, 'shopee:1:2')).toBeNull()
  })

  it('is a no-op when no seed ships with the build', () => {
    const result = importSeedBundle(db, { readSeed: () => null })
    expect(result.reason).toBe('no_seed')
    expect(getBundleState(db).version).toBe(0)
  })

  it('survives a corrupt seed instead of taking the app down', () => {
    expect(
      importSeedBundle(db, { readSeed: () => Buffer.from('not gzip') }).reason,
    ).toBe('bad_gzip')
    expect(
      importSeedBundle(db, { readSeed: () => gzipSync('v9 1 0\n') }).reason,
    ).toBe('malformed')
    expect(getBundleState(db).version).toBe(0)
  })
})
