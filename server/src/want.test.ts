import { describe, expect, it, vi } from 'vitest'
import { WANT_MAX_IDS, wantRequestSchema } from './schema'
import { recordWant, wantDayStamp, wantKey, WANT_TTL_SECONDS } from './want'

function fakeKv() {
  const store = new Map<string, { value: string; ttl?: number }>()
  return {
    kv: {
      put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
        store.set(key, { value, ttl: opts?.expirationTtl })
      }),
    } as unknown as KVNamespace,
    store,
  }
}

const DAY = Date.UTC(2026, 7, 9, 13, 45, 0)

describe('want keys', () => {
  it('stamps the UTC day so clients in different timezones agree', () => {
    expect(wantDayStamp(DAY)).toBe('2026-08-09')
    // 23:30 UTC and 00:30 UTC next day must land on different stamps
    expect(wantDayStamp(Date.UTC(2026, 7, 9, 23, 30))).toBe('2026-08-09')
    expect(wantDayStamp(Date.UTC(2026, 7, 10, 0, 30))).toBe('2026-08-10')
  })

  it('one key per install per day — the whole point of the write budget', () => {
    expect(wantKey('abc', DAY)).toBe('want:2026-08-09:abc')
    expect(wantKey('abc', DAY + 60_000)).toBe(wantKey('abc', DAY))
  })
})

describe('recordWant', () => {
  it('stores the list under one key with a TTL', async () => {
    const { kv, store } = fakeKv()
    const result = await recordWant(kv, 'inst-1', ['1:2', '3:4'], DAY)

    expect(result).toEqual({ stored: 2, key: 'want:2026-08-09:inst-1' })
    expect(store.get('want:2026-08-09:inst-1')?.ttl).toBe(WANT_TTL_SECONDS)
    expect(JSON.parse(store.get('want:2026-08-09:inst-1')!.value)).toEqual([
      '1:2',
      '3:4',
    ])
  })

  it('collapses duplicates so one client cannot inflate a product rank', async () => {
    const { kv, store } = fakeKv()
    const result = await recordWant(kv, 'inst-1', ['1:2', '1:2', '1:2'], DAY)
    expect(result.stored).toBe(1)
    expect(JSON.parse(store.get(result.key)!.value)).toEqual(['1:2'])
  })

  it('a second report the same day overwrites — still one write', async () => {
    const { kv, store } = fakeKv()
    await recordWant(kv, 'inst-1', ['1:2'], DAY)
    await recordWant(kv, 'inst-1', ['5:6'], DAY + 3600_000)
    expect(store.size).toBe(1)
    expect(JSON.parse(store.get('want:2026-08-09:inst-1')!.value)).toEqual([
      '5:6',
    ])
  })
})

describe('wantRequestSchema', () => {
  it('accepts a well-formed report', () => {
    const parsed = wantRequestSchema.safeParse({
      installId: 'inst-1',
      missing: ['1016604648:23258487489'],
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects anything that is not a bare id pair — no urls, no titles', () => {
    for (const bad of [
      'https://shopee.vn/product/1/2',
      'Áo thun nữ',
      '1:2:3',
      'abc:def',
      '',
      ':',
    ]) {
      const parsed = wantRequestSchema.safeParse({
        installId: 'i',
        missing: [bad],
      })
      expect(parsed.success, `should reject ${JSON.stringify(bad)}`).toBe(false)
    }
  })

  it('caps the batch so one client cannot post an unbounded body', () => {
    const tooMany = Array.from({ length: WANT_MAX_IDS + 1 }, (_, i) => `1:${i}`)
    expect(
      wantRequestSchema.safeParse({ installId: 'i', missing: tooMany }).success,
    ).toBe(false)
    expect(
      wantRequestSchema.safeParse({
        installId: 'i',
        missing: tooMany.slice(0, WANT_MAX_IDS),
      }).success,
    ).toBe(true)
  })

  it('accepts an empty list', () => {
    expect(
      wantRequestSchema.safeParse({ installId: 'i', missing: [] }).success,
    ).toBe(true)
  })
})
