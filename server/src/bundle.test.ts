import { describe, expect, it } from 'vitest'
import {
  BUNDLE_FULL_KEY,
  BUNDLE_META_KEY,
  buildBundleResponse,
  bundleSegmentKey,
  concatSegments,
  packBundle,
  packUrl,
  parseBundle,
  unpackUrl,
  type BundleEntry,
  type BundleMeta,
} from './bundle'

/** Minimal in-memory stand-in for the KV binding. */
function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    store,
  } as unknown as KVNamespace & { store: Map<string, string> }
}

const entry = (shopId: string, itemId: string, code: string): BundleEntry => ({
  shopId,
  itemId,
  url: `https://s.shopee.vn/${code}`,
})

describe('packUrl / unpackUrl', () => {
  it('round-trips every supported shortlink host', () => {
    for (const url of [
      'https://s.shopee.vn/7psIMS4q7W',
      'https://shope.ee/9zAbCd',
      'https://shp.ee/QqQq1',
    ]) {
      const packed = packUrl(url)
      expect(packed).not.toBeNull()
      expect(unpackUrl(packed!)).toBe(url)
    }
  })

  it('drops the host prefix — that is the whole point of packing', () => {
    expect(packUrl('https://s.shopee.vn/abc123')).toBe('0abc123')
  })

  it('refuses anything that is not a known shortlink', () => {
    expect(packUrl('https://shopee.vn/product/1/2')).toBeNull()
    expect(packUrl('http://s.shopee.vn/abc')).toBeNull() // plain http
    expect(packUrl('https://evil.com/abc')).toBeNull()
    expect(packUrl('https://s.shopee.vn.evil.com/abc')).toBeNull()
    expect(packUrl('not a url')).toBeNull()
  })

  it('rejects malformed packed values instead of guessing', () => {
    expect(unpackUrl('')).toBeNull()
    expect(unpackUrl('9abc')).toBeNull() // no such host index
    expect(unpackUrl('0')).toBeNull() // no code
    expect(unpackUrl('0abc/../x')).toBeNull()
  })
})

describe('packBundle / parseBundle', () => {
  it('round-trips entries with the version intact', () => {
    const entries = [
      entry('1016604648', '23258487489', '7psIMS4q7W'),
      entry('1654674476', '51401292730', '7fYsA95TSV'),
    ]
    const parsed = parseBundle(packBundle(entries, 42))
    expect(parsed?.version).toBe(42)
    expect(parsed?.entries).toEqual(entries)
  })

  it('header records the count actually written, not the count offered', () => {
    // second row has a junk url and must not be counted
    const text = packBundle(
      [entry('1', '2', 'ok'), { shopId: '3', itemId: '4', url: 'nope' }],
      7,
    )
    expect(text.split('\n')[0]).toBe('v1 7 1')
  })

  it('drops unpackable rows rather than emitting a guess', () => {
    const parsed = parseBundle(
      packBundle(
        [
          entry('1016604648', '23258487489', 'good'),
          { shopId: 'abc', itemId: '1', url: 'https://s.shopee.vn/x' },
          { shopId: '1', itemId: '2', url: 'https://evil.com/x' },
        ],
        1,
      ),
    )
    expect(parsed?.entries).toHaveLength(1)
  })

  it('skips corrupt lines so one bad row cannot void an entire sync', () => {
    const text = ['v1 3 3', '1,2,0abc', 'garbage line', '4,5,0def', ''].join('\n')
    const parsed = parseBundle(text)
    expect(parsed?.entries.map((e) => e.itemId)).toEqual(['2', '5'])
  })

  it('rejects a body with the wrong format marker', () => {
    expect(parseBundle('v2 1 0\n')).toBeNull()
    expect(parseBundle('no newline')).toBeNull()
    expect(parseBundle('v1 notanumber 0\n')).toBeNull()
  })
})

describe('concatSegments', () => {
  it('merges bodies and rewrites the header to the new total', () => {
    const a = packBundle([entry('1', '2', 'aaa')], 5)
    const b = packBundle([entry('3', '4', 'bbb'), entry('5', '6', 'ccc')], 6)
    const merged = concatSegments([a, b], 6)
    const parsed = parseBundle(merged)
    expect(merged.split('\n')[0]).toBe('v1 6 3')
    expect(parsed?.version).toBe(6)
    expect(parsed?.entries).toHaveLength(3)
  })
})

describe('buildBundleResponse', () => {
  const meta = (m: BundleMeta) => ({ [BUNDLE_META_KEY]: JSON.stringify(m) })

  it('reports empty when nothing has been published', async () => {
    const res = await buildBundleResponse(fakeKv(), 0)
    expect(res.kind).toBe('empty')
  })

  it('tells a current client there is nothing to do', async () => {
    const kv = fakeKv(meta({ version: 9, count: 3, segments: [9] }))
    const res = await buildBundleResponse(kv, 9)
    expect(res).toEqual({ kind: 'up_to_date', version: 9 })
  })

  it('serves a delta when the segment chain covers the gap', async () => {
    const kv = fakeKv({
      ...meta({ version: 7, count: 2, segments: [6, 7] }),
      [bundleSegmentKey(6)]: packBundle([entry('1', '2', 'aaa')], 6),
      [bundleSegmentKey(7)]: packBundle([entry('3', '4', 'bbb')], 7),
    })
    const res = await buildBundleResponse(kv, 5)
    expect(res.kind).toBe('delta')
    if (res.kind !== 'delta') throw new Error('expected delta')
    expect(parseBundle(res.body)?.entries).toHaveLength(2)
  })

  it('falls back to the snapshot when a needed segment was pruned', async () => {
    // Client is on 2 but the oldest surviving segment is 6 — versions 3..5
    // are gone. Handing over 6..7 would leave it permanently short.
    const kv = fakeKv({
      ...meta({ version: 7, count: 50, segments: [6, 7] }),
      [bundleSegmentKey(6)]: packBundle([entry('1', '2', 'aaa')], 6),
      [bundleSegmentKey(7)]: packBundle([entry('3', '4', 'bbb')], 7),
      [BUNDLE_FULL_KEY]: packBundle([entry('9', '9', 'full')], 7),
    })
    const res = await buildBundleResponse(kv, 2)
    expect(res.kind).toBe('full')
  })

  it('gives a fresh install the full snapshot, never a delta', async () => {
    const kv = fakeKv({
      ...meta({ version: 7, count: 1, segments: [7] }),
      [bundleSegmentKey(7)]: packBundle([entry('3', '4', 'bbb')], 7),
      [BUNDLE_FULL_KEY]: packBundle([entry('9', '9', 'full')], 7),
    })
    const res = await buildBundleResponse(kv, 0)
    expect(res.kind).toBe('full')
  })

  it('falls back to the snapshot when a segment body is missing', async () => {
    const kv = fakeKv({
      ...meta({ version: 7, count: 1, segments: [6, 7] }),
      [bundleSegmentKey(6)]: packBundle([entry('1', '2', 'aaa')], 6),
      // segment 7 body absent
      [BUNDLE_FULL_KEY]: packBundle([entry('9', '9', 'full')], 7),
    })
    const res = await buildBundleResponse(kv, 5)
    expect(res.kind).toBe('full')
  })

  it('survives corrupt meta rather than throwing', async () => {
    const kv = fakeKv({ [BUNDLE_META_KEY]: '{not json' })
    const res = await buildBundleResponse(kv, 0)
    expect(res.kind).toBe('empty')
  })
})
