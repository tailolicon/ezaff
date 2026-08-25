import { describe, expect, it } from 'vitest'
import {
  isPackedStoreValue,
  packStoreValue,
  unpackStoreValue,
  unwrapResourceBytes,
  wrapResourceBytes,
} from './ownerLinkMask'

const SAMPLE = 'https://s.shopee.vn/secret-owner-aff'

describe('ownerLinkMask', () => {
  it('round-trips a shortlink', () => {
    const packed = packStoreValue(SAMPLE)
    expect(unpackStoreValue(packed)).toBe(SAMPLE)
  })

  it('does not keep the plaintext URL in the stored blob', () => {
    const packed = packStoreValue(SAMPLE)
    expect(packed).not.toContain('shopee')
    expect(packed).not.toContain('secret-owner')
    expect(packed).not.toContain('https://')
    expect(isPackedStoreValue(packed)).toBe(true)
  })

  it('is idempotent — packing twice does not double-wrap', () => {
    const once = packStoreValue(SAMPLE)
    expect(packStoreValue(once)).toBe(once)
  })

  it('still reads legacy plaintext rows', () => {
    expect(unpackStoreValue(SAMPLE)).toBe(SAMPLE)
    expect(unpackStoreValue('')).toBeNull()
    expect(unpackStoreValue(null)).toBeNull()
  })

  it('returns null for a truncated blob instead of throwing', () => {
    expect(unpackStoreValue('b1:???')).toBeNull()
  })
})

describe('resource wrap', () => {
  it('round-trips gzip and hides the gzip magic', async () => {
    const { gzipSync, gunzipSync } = await import('node:zlib')
    const gz = gzipSync(Buffer.from('v1 1 0\n'))
    const wrapped = wrapResourceBytes(gz)
    expect(wrapped[0]).not.toBe(0x1f)
    expect(wrapped[1]).not.toBe(0x8b)
    expect(gunzipSync(unwrapResourceBytes(wrapped)).toString()).toBe('v1 1 0\n')
  })

  it('still accepts a bare gzip buffer (tests / legacy)', async () => {
    const { gzipSync, gunzipSync } = await import('node:zlib')
    const gz = gzipSync(Buffer.from('ok'))
    expect(gunzipSync(unwrapResourceBytes(gz)).toString()).toBe('ok')
  })
})
