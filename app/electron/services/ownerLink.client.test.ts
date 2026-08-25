/**
 * ownerLink.client — payload privacy + timeout + cache behaviour.
 */
import { describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../db/repositories/testDb'
import { getOwnerLinkCache } from '../db/repositories/ownerLinkCacheRepo'
import {
  assertOwnerLinkBodyKeys,
  buildOwnerLinkBody,
  fetchOwnerLinkFromWorker,
  OWNER_LINK_BODY_KEYS,
  resolveOwnerLink,
} from './ownerLink.client'

describe('buildOwnerLinkBody / assertOwnerLinkBodyKeys', () => {
  it('sends ONLY platform, shopId, itemId, installId', () => {
    const body = buildOwnerLinkBody({
      platform: 'shopee',
      shopId: 's1',
      itemId: 'i1',
      installId: 'inst-1',
    })

    const keys = Object.keys(body).sort()
    expect(keys).toEqual([...OWNER_LINK_BODY_KEYS].sort())
    expect(body).toEqual({
      platform: 'shopee',
      shopId: 's1',
      itemId: 'i1',
      installId: 'inst-1',
    })
    // No affiliate URL field possible
    expect(body).not.toHaveProperty('url')
    expect(body).not.toHaveProperty('original_url')
    expect(body).not.toHaveProperty('affiliateLink')
    assertOwnerLinkBodyKeys(body as unknown as Record<string, unknown>)
  })

  it('uses empty strings for null shop/item ids (still only four fields)', () => {
    const body = buildOwnerLinkBody({
      platform: 'lazada',
      shopId: null,
      itemId: undefined,
      installId: 'x',
    })
    expect(Object.keys(body).sort()).toEqual(
      [...OWNER_LINK_BODY_KEYS].sort(),
    )
    expect(body.shopId).toBe('')
    expect(body.itemId).toBe('')
  })

  it('assertOwnerLinkBodyKeys rejects extra fields', () => {
    expect(() =>
      assertOwnerLinkBodyKeys({
        platform: 'a',
        shopId: 'b',
        itemId: 'c',
        installId: 'd',
        original_url: 'https://evil',
      }),
    ).toThrow(/only/)
  })
})

describe('fetchOwnerLinkFromWorker', () => {
  it('POSTs JSON with exactly four fields and never includes user URL', async () => {
    let capturedBody: unknown = null
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body))
      return {
        ok: true,
        json: async () => ({
          ownerUrl: 'https://s.shopee.vn/owner',
          source: 'mapping_table',
        }),
      }
    })

    const result = await fetchOwnerLinkFromWorker(
      {
        platform: 'shopee',
        shopId: '10',
        itemId: '20',
        installId: 'inst',
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        workerUrl: 'http://localhost:8787',
      },
    )

    expect(result.ownerUrl).toBe('https://s.shopee.vn/owner')
    expect(capturedBody).toEqual({
      platform: 'shopee',
      shopId: '10',
      itemId: '20',
      installId: 'inst',
    })
    expect(Object.keys(capturedBody as object).sort()).toEqual(
      [...OWNER_LINK_BODY_KEYS].sort(),
    )
  })

  it('returns null on timeout/abort without throwing', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('Aborted')
            err.name = 'AbortError'
            reject(err)
          })
        }
      })
    })

    const result = await fetchOwnerLinkFromWorker(
      {
        platform: 'shopee',
        shopId: '1',
        itemId: '2',
        installId: 'i',
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 20,
        workerUrl: 'http://localhost:8787',
      },
    )

    expect(result.ownerUrl).toBeNull()
    expect(result.source).toBe('network_error')
  })

  it('returns null on malformed JSON / garbage ownerUrl', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ownerUrl: 12345, source: 'x' }),
    }))

    const result = await fetchOwnerLinkFromWorker(
      {
        platform: 'shopee',
        shopId: '1',
        itemId: '2',
        installId: 'i',
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    expect(result.ownerUrl).toBeNull()
    expect(result.source).toBe('malformed')
  })
})

describe('resolveOwnerLink cache', () => {
  it('caches positive results and serves from local cache on second call', async () => {
    const db = createTestDb()
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      return {
        ok: true,
        json: async () => ({
          ownerUrl: 'https://s.shopee.vn/cached-owner',
          source: 'mapping_table',
        }),
      }
    })

    const params = {
      platform: 'shopee',
      shopId: '1',
      itemId: '2',
      installId: 'i',
      canonicalKey: 'shopee:1:2',
    }

    const first = await resolveOwnerLink(db, params, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_000_000,
    })
    expect(first.ownerUrl).toBe('https://s.shopee.vn/cached-owner')
    expect(calls).toBe(1)

    const second = await resolveOwnerLink(db, params, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_000_000 + 1000,
    })
    expect(second.ownerUrl).toBe('https://s.shopee.vn/cached-owner')
    expect(second.source).toBe('local_cache')
    expect(calls).toBe(1)

    const cached = getOwnerLinkCache(db, 'shopee:1:2', 1_000_000 + 1000)
    expect(cached.hit).toBe(true)
  })

  it('caches negative results so missing products are not re-fetched immediately', async () => {
    const db = createTestDb()
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      return {
        ok: true,
        json: async () => ({ ownerUrl: null, source: 'passthrough' }),
      }
    })

    const params = {
      platform: 'shopee',
      shopId: '9',
      itemId: '9',
      installId: 'i',
      canonicalKey: 'shopee:9:9',
    }

    await resolveOwnerLink(db, params, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 5_000_000,
    })
    await resolveOwnerLink(db, params, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 5_000_000 + 1000,
    })
    expect(calls).toBe(1)
  })
})
