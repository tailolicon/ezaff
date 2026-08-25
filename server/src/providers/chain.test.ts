/**
 * Provider chain tests with fakes — no network.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Env, OwnerLinkProvider, OwnerLinkRequest } from '../types'
import { runProviderChain } from './chain'
import { mappingKey, mappingTableProvider } from './mappingTable'
import { passthroughProvider } from './passthrough'
import {
  buildAuthorizationHeader,
  buildGenerateShortLinkPayload,
  buildShopeeOriginUrl,
  computeShopeeSignature,
  isShopeeOpenApiEnabled,
  shopeeOpenApiProvider,
} from './shopeeOpenApi'

/** Minimal in-memory KV for tests. */
function createMemoryKv(
  initial: Record<string, string> = {},
): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    OWNER_KV: createMemoryKv(),
    ...overrides,
  }
}

const baseReq: OwnerLinkRequest = {
  platform: 'shopee',
  shopId: '111',
  itemId: '222',
  installId: 'install-abc',
}

describe('isShopeeOpenApiEnabled', () => {
  it('is disabled when credentials are missing', () => {
    expect(isShopeeOpenApiEnabled({})).toBe(false)
    expect(isShopeeOpenApiEnabled({ SHOPEE_APP_ID: 'x' })).toBe(false)
    expect(isShopeeOpenApiEnabled({ SHOPEE_SECRET: 'y' })).toBe(false)
    expect(isShopeeOpenApiEnabled({ SHOPEE_APP_ID: '', SHOPEE_SECRET: '' })).toBe(
      false,
    )
  })

  it('is enabled only when both app id and secret are non-empty', () => {
    expect(
      isShopeeOpenApiEnabled({ SHOPEE_APP_ID: 'app', SHOPEE_SECRET: 'sec' }),
    ).toBe(true)
  })
})

describe('shopeeOpenApiProvider', () => {
  it('returns null without calling fetch when credentials are absent', async () => {
    const fetchImpl = vi.fn()
    const result = await shopeeOpenApiProvider.resolve(baseReq, {
      env: makeEnv(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('calls GraphQL and returns shortLink when credentials exist', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: { generateShortLink: { shortLink: 'https://s.shopee.vn/owner1' } },
      }),
    }))
    const result = await shopeeOpenApiProvider.resolve(baseReq, {
      env: makeEnv({
        SHOPEE_APP_ID: 'app123',
        SHOPEE_SECRET: 'secret456',
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_700_000_000_000,
    })
    expect(result).toEqual({
      ownerUrl: 'https://s.shopee.vn/owner1',
      source: 'shopee_open_api',
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const [url, init] = call
    expect(url).toContain('affiliate.shopee')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toMatch(/^SHA256 Credential=app123/)
  })

  it('returns null on network error so chain can fall through', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    })
    const result = await shopeeOpenApiProvider.resolve(baseReq, {
      env: makeEnv({ SHOPEE_APP_ID: 'a', SHOPEE_SECRET: 'b' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toBeNull()
  })
})

describe('mappingTableProvider', () => {
  it('returns mapped URL when KV key exists', async () => {
    const key = mappingKey(baseReq)
    const env = makeEnv({
      OWNER_KV: createMemoryKv({
        [key]: 'https://s.shopee.vn/mapped',
      }),
    })
    const result = await mappingTableProvider.resolve(baseReq, { env })
    expect(result).toEqual({
      ownerUrl: 'https://s.shopee.vn/mapped',
      source: 'mapping_table',
    })
  })

  it('returns null when key is missing', async () => {
    const result = await mappingTableProvider.resolve(baseReq, {
      env: makeEnv(),
    })
    expect(result).toBeNull()
  })
})

describe('runProviderChain', () => {
  it('uses first non-null provider (shopee wins over mapping)', async () => {
    const shopee: OwnerLinkProvider = {
      name: 'shopee_open_api',
      async resolve() {
        return { ownerUrl: 'https://s.shopee.vn/from-api', source: 'shopee_open_api' }
      },
    }
    const mapping: OwnerLinkProvider = {
      name: 'mapping_table',
      async resolve() {
        return { ownerUrl: 'https://s.shopee.vn/from-map', source: 'mapping_table' }
      },
    }
    const result = await runProviderChain(baseReq, { env: makeEnv() }, [
      shopee,
      mapping,
      passthroughProvider,
    ])
    expect(result.source).toBe('shopee_open_api')
    expect(result.ownerUrl).toBe('https://s.shopee.vn/from-api')
  })

  it('falls through to mapping when shopee is disabled/null', async () => {
    const key = mappingKey(baseReq)
    const env = makeEnv({
      OWNER_KV: createMemoryKv({ [key]: 'https://s.shopee.vn/mapped-only' }),
      // no SHOPEE credentials → open API disabled
    })
    const result = await runProviderChain(baseReq, { env }, [
      shopeeOpenApiProvider,
      mappingTableProvider,
      passthroughProvider,
    ])
    expect(result).toEqual({
      ownerUrl: 'https://s.shopee.vn/mapped-only',
      source: 'mapping_table',
    })
  })

  it('returns passthrough null when nothing matches', async () => {
    const result = await runProviderChain(baseReq, { env: makeEnv() }, [
      shopeeOpenApiProvider,
      mappingTableProvider,
      passthroughProvider,
    ])
    expect(result).toEqual({ ownerUrl: null, source: 'passthrough' })
  })

  it('skips provider that returns empty string and continues', async () => {
    const empty: OwnerLinkProvider = {
      name: 'empty',
      async resolve() {
        return { ownerUrl: '  ', source: 'empty' }
      },
    }
    const next: OwnerLinkProvider = {
      name: 'next',
      async resolve() {
        return { ownerUrl: 'https://ok.example/x', source: 'next' }
      },
    }
    const result = await runProviderChain(baseReq, { env: makeEnv() }, [
      empty,
      next,
      passthroughProvider,
    ])
    expect(result.ownerUrl).toBe('https://ok.example/x')
    expect(result.source).toBe('next')
  })
})

describe('signature helpers (unverified scheme)', () => {
  it('builds origin URL and GraphQL payload', () => {
    expect(buildShopeeOriginUrl(baseReq)).toBe(
      'https://shopee.vn/product/111/222',
    )
    const payload = buildGenerateShortLinkPayload(
      'https://shopee.vn/product/111/222',
    )
    expect(payload).toContain('generateShortLink')
    expect(payload).toContain('originUrl')
  })

  it('computes hex SHA256 signature from factor string', async () => {
    // factor = appId + timestamp + payload + secret
    const sig = await computeShopeeSignature('id', 'sec', 1000, '{"q":1}')
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
    // Deterministic
    const sig2 = await computeShopeeSignature('id', 'sec', 1000, '{"q":1}')
    expect(sig2).toBe(sig)
  })

  it('formats Authorization header', () => {
    expect(buildAuthorizationHeader('app', 99, 'abc')).toBe(
      'SHA256 Credential=app, Timestamp=99, Signature=abc',
    )
  })
})
