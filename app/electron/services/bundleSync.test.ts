import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyBundle,
  bundleCanonicalKey,
  getBundleOwnerUrl,
  getBundleState,
} from '../db/repositories/ownerLinkBundleRepo'
import { createTestDb } from '../db/repositories/testDb'
import {
  BUNDLE_SYNC_INTERVAL_MS,
  isBundleStale,
  parseBundleBody,
  syncOwnerLinkBundle,
  unpackUrl,
} from './bundleSync'
import { resolveOwnerLink } from './ownerLink.client'

let db: Database.Database

beforeEach(() => {
  db = createTestDb()
})

afterEach(() => {
  db.close()
})

/** Build the packed body the Worker sends. */
function body(
  version: number,
  rows: Array<[string, string, string]>,
): string {
  return `v1 ${version} ${rows.length}\n${rows
    .map(([s, i, p]) => `${s},${i},${p}`)
    .join('\n')}\n`
}

function response(
  status: number,
  text = '',
  headers: Record<string, string> = {},
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers[k] ?? null },
    text: async () => text,
  } as unknown as Response
}

describe('unpackUrl', () => {
  it('rebuilds each supported host from its index', () => {
    expect(unpackUrl('0abc123')).toBe('https://s.shopee.vn/abc123')
    expect(unpackUrl('1abc123')).toBe('https://shope.ee/abc123')
    expect(unpackUrl('2abc123')).toBe('https://shp.ee/abc123')
  })

  it('refuses malformed input instead of inventing a link', () => {
    expect(unpackUrl('')).toBeNull()
    expect(unpackUrl('9abc')).toBeNull()
    expect(unpackUrl('0')).toBeNull()
    expect(unpackUrl('0a/../b')).toBeNull()
  })
})

describe('parseBundleBody', () => {
  it('reads version and entries', () => {
    const parsed = parseBundleBody(
      body(12, [['1016604648', '23258487489', '0abc']]),
    )
    expect(parsed?.version).toBe(12)
    expect(parsed?.entries).toEqual([
      {
        shopId: '1016604648',
        itemId: '23258487489',
        ownerUrl: 'https://s.shopee.vn/abc',
      },
    ])
  })

  it('skips corrupt rows so one bad line cannot void the sync', () => {
    const text = ['v1 3 3', '1,2,0aaa', 'junk', 'x,y,0bbb', '4,5,0ccc', ''].join(
      '\n',
    )
    expect(parseBundleBody(text)?.entries.map((e) => e.itemId)).toEqual([
      '2',
      '5',
    ])
  })

  it('rejects an unknown format marker rather than guessing', () => {
    expect(parseBundleBody('v2 1 0\n')).toBeNull()
    expect(parseBundleBody('no newline')).toBeNull()
  })
})

describe('owner_links table', () => {
  it('keys match products.canonical_key so lookups line up', () => {
    expect(bundleCanonicalKey('1016604648', '23258487489')).toBe(
      'shopee:1016604648:23258487489',
    )
  })

  it('stores and reads back an owner link', () => {
    applyBundle(
      db,
      [{ shopId: '1', itemId: '2', ownerUrl: 'https://s.shopee.vn/aaa' }],
      5,
    )
    expect(getBundleOwnerUrl(db, 'shopee:1:2')).toBe('https://s.shopee.vn/aaa')
    expect(getBundleOwnerUrl(db, 'shopee:9:9')).toBeNull()
  })

  it('delta merges, snapshot replaces', () => {
    applyBundle(
      db,
      [{ shopId: '1', itemId: '2', ownerUrl: 'https://s.shopee.vn/old' }],
      1,
    )
    // delta keeps what was there
    applyBundle(
      db,
      [{ shopId: '3', itemId: '4', ownerUrl: 'https://s.shopee.vn/new' }],
      2,
    )
    expect(getBundleOwnerUrl(db, 'shopee:1:2')).toBe('https://s.shopee.vn/old')
    expect(getBundleOwnerUrl(db, 'shopee:3:4')).toBe('https://s.shopee.vn/new')

    // snapshot wipes first
    applyBundle(
      db,
      [{ shopId: '5', itemId: '6', ownerUrl: 'https://s.shopee.vn/only' }],
      3,
      { replace: true },
    )
    expect(getBundleOwnerUrl(db, 'shopee:1:2')).toBeNull()
    expect(getBundleOwnerUrl(db, 'shopee:5:6')).toBe('https://s.shopee.vn/only')
  })

  it('a later delta overwrites the url for a key it already had', () => {
    applyBundle(
      db,
      [{ shopId: '1', itemId: '2', ownerUrl: 'https://s.shopee.vn/old' }],
      1,
    )
    applyBundle(
      db,
      [{ shopId: '1', itemId: '2', ownerUrl: 'https://s.shopee.vn/fresh' }],
      2,
    )
    expect(getBundleOwnerUrl(db, 'shopee:1:2')).toBe('https://s.shopee.vn/fresh')
    expect(getBundleState(db).entryCount).toBe(1)
  })
})

describe('syncOwnerLinkBundle', () => {
  it('applies a full snapshot and records the version', async () => {
    const fetchImpl = vi.fn(async () =>
      response(200, body(7, [['1', '2', '0aaa']]), { 'X-Bundle-Kind': 'full' }),
    )
    const result = await syncOwnerLinkBundle(db, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      workerUrl: 'http://worker.test',
      now: () => 1000,
    })
    expect(result).toMatchObject({ ok: true, version: 7, reason: 'full' })
    expect(getBundleState(db)).toMatchObject({ version: 7, syncedAt: 1000 })
    expect(getBundleOwnerUrl(db, 'shopee:1:2')).toBe('https://s.shopee.vn/aaa')
  })

  it('sends its current version as ?since so the Worker can answer with a delta', async () => {
    applyBundle(db, [], 4)
    const fetchImpl = vi.fn(async () => response(204, '', {}))
    await syncOwnerLinkBundle(db, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      workerUrl: 'http://worker.test',
    })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'http://worker.test/v1/bundle?since=4',
    )
  })

  it('a delta must not wipe entries the client already had', async () => {
    applyBundle(
      db,
      [{ shopId: '1', itemId: '2', ownerUrl: 'https://s.shopee.vn/keep' }],
      4,
    )
    const fetchImpl = vi.fn(async () =>
      response(200, body(5, [['3', '4', '0new']]), {
        'X-Bundle-Kind': 'delta',
      }),
    )
    await syncOwnerLinkBundle(db, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      workerUrl: 'http://worker.test',
    })
    expect(getBundleOwnerUrl(db, 'shopee:1:2')).toBe('https://s.shopee.vn/keep')
    expect(getBundleOwnerUrl(db, 'shopee:3:4')).toBe('https://s.shopee.vn/new')
  })

  it('treats a missing kind header as a snapshot — the safe direction', async () => {
    applyBundle(
      db,
      [{ shopId: '1', itemId: '2', ownerUrl: 'https://s.shopee.vn/stale' }],
      4,
    )
    const fetchImpl = vi.fn(async () =>
      response(200, body(5, [['3', '4', '0new']]), {}),
    )
    await syncOwnerLinkBundle(db, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      workerUrl: 'http://worker.test',
    })
    expect(getBundleOwnerUrl(db, 'shopee:1:2')).toBeNull()
  })

  it('204 keeps the data and still stamps the clock', async () => {
    applyBundle(
      db,
      [{ shopId: '1', itemId: '2', ownerUrl: 'https://s.shopee.vn/keep' }],
      4,
      { nowMs: 500 },
    )
    const fetchImpl = vi.fn(async () => response(204))
    const result = await syncOwnerLinkBundle(db, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      workerUrl: 'http://worker.test',
      now: () => 9000,
    })
    expect(result.reason).toBe('up_to_date')
    expect(getBundleOwnerUrl(db, 'shopee:1:2')).toBe('https://s.shopee.vn/keep')
    expect(getBundleState(db)).toMatchObject({ version: 4, syncedAt: 9000 })
  })

  it('a failed sync leaves the existing table untouched', async () => {
    applyBundle(
      db,
      [{ shopId: '1', itemId: '2', ownerUrl: 'https://s.shopee.vn/keep' }],
      4,
    )
    for (const fetchImpl of [
      vi.fn(async () => response(500)),
      vi.fn(async () => response(200, 'garbage', { 'X-Bundle-Kind': 'full' })),
      vi.fn(async () => {
        throw new Error('offline')
      }),
    ]) {
      const result = await syncOwnerLinkBundle(db, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        workerUrl: 'http://worker.test',
      })
      expect(result.ok).toBe(false)
      expect(getBundleOwnerUrl(db, 'shopee:1:2')).toBe(
        'https://s.shopee.vn/keep',
      )
      expect(getBundleState(db).version).toBe(4)
    }
  })
})

describe('isBundleStale', () => {
  it('a never-synced install is stale', () => {
    expect(isBundleStale(db, 1_000)).toBe(true)
  })

  it('goes stale only after the interval', () => {
    applyBundle(db, [], 1, { nowMs: 1_000 })
    expect(isBundleStale(db, 1_000 + BUNDLE_SYNC_INTERVAL_MS - 1)).toBe(false)
    expect(isBundleStale(db, 1_000 + BUNDLE_SYNC_INTERVAL_MS)).toBe(true)
  })
})

describe('resolveOwnerLink with a bundle present', () => {
  const params = {
    platform: 'shopee',
    shopId: '1',
    itemId: '2',
    installId: 'install-1',
    canonicalKey: 'shopee:1:2',
  }

  it('answers from the bundle without calling the worker at all', async () => {
    applyBundle(
      db,
      [{ shopId: '1', itemId: '2', ownerUrl: 'https://s.shopee.vn/bundled' }],
      1,
    )
    const fetchImpl = vi.fn(async () => {
      throw new Error('worker must not be called on a bundle hit')
    })

    const result = await resolveOwnerLink(db, params, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      workerUrl: 'http://worker.test',
    })

    expect(result).toEqual({
      ownerUrl: 'https://s.shopee.vn/bundled',
      source: 'bundle',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('still falls through to the worker for a product the bundle lacks', async () => {
    applyBundle(
      db,
      [{ shopId: '9', itemId: '9', ownerUrl: 'https://s.shopee.vn/other' }],
      1,
    )
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ ownerUrl: 'https://s.shopee.vn/fromworker', source: 'kv' }),
    }))

    const result = await resolveOwnerLink(db, params, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      workerUrl: 'http://worker.test',
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result.ownerUrl).toBe('https://s.shopee.vn/fromworker')
  })
})
