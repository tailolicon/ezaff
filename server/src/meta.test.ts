import { describe, expect, it } from 'vitest'
import {
  chunkEntries,
  chunkKey,
  chunkCountKey,
  readChunked,
  splitIntoChunks,
} from './chunk'
import { concatMetaSegments, packMeta, parseMeta, type MetaEntry } from './meta'

function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    get: async (key: string) => store.get(key) ?? null,
    store,
  } as unknown as KVNamespace & { store: Map<string, string> }
}

const entry = (over: Partial<MetaEntry> = {}): MetaEntry => ({
  shopId: '1016604648',
  itemId: '23258487489',
  commissionPct: 12,
  priceVnd: 139000,
  historicalSold: 40000,
  rating: 5,
  shopName: 'TopGia HCM Store',
  name: 'Giấy vệ sinh treo tường Top Gia 1280 tờ',
  ...over,
})

describe('packMeta / parseMeta', () => {
  it('round-trips a full record', () => {
    const parsed = parseMeta(packMeta([entry()], 3))
    expect(parsed?.version).toBe(3)
    expect(parsed?.entries[0]).toEqual(entry())
  })

  /*
   * Product titles routinely contain commas and quotes, which is exactly why
   * this format is tab-separated. They must survive untouched.
   */
  it('keeps commas and quotes in titles intact', () => {
    const messy = entry({
      name: 'Robot hút bụi, lau nhà 2in1 "chính hãng", giá rẻ',
      shopName: 'Shop A, B & C',
    })
    const parsed = parseMeta(packMeta([messy], 1))
    expect(parsed?.entries[0]?.name).toBe(messy.name)
    expect(parsed?.entries[0]?.shopName).toBe(messy.shopName)
  })

  it('strips tabs and newlines so a row can never span lines', () => {
    const parsed = parseMeta(
      packMeta([entry({ name: 'Máy\tTriệt\nLông\r\n808nm' })], 1),
    )
    expect(parsed?.entries).toHaveLength(1)
    expect(parsed?.entries[0]?.name).toBe('Máy Triệt Lông 808nm')
  })

  it('keeps rows the harvest captured no metadata for', () => {
    // 4.7% of the real harvest looks like this — link is still useful.
    const bare = entry({
      commissionPct: 0,
      priceVnd: 0,
      historicalSold: 0,
      rating: 0,
      shopName: '',
      name: '',
    })
    const parsed = parseMeta(packMeta([bare], 1))
    expect(parsed?.entries[0]).toEqual(bare)
  })

  it('clamps nonsense numbers rather than storing them', () => {
    const parsed = parseMeta(
      packMeta(
        [entry({ rating: 9, commissionPct: 500, priceVnd: -5 })],
        1,
      ),
    )
    expect(parsed?.entries[0]).toMatchObject({
      rating: 5,
      commissionPct: 100,
      priceVnd: 0,
    })
  })

  it('drops rows with an unusable id instead of guessing', () => {
    const text = packMeta(
      [entry(), entry({ shopId: 'abc' }), entry({ itemId: '' })],
      1,
    )
    expect(parseMeta(text)?.entries).toHaveLength(1)
  })

  it('skips corrupt lines so one bad row cannot void the file', () => {
    const good = packMeta([entry()], 1)
    const broken = good.replace(/\n$/, '\nnot\ta\trow\n')
    expect(parseMeta(broken)?.entries).toHaveLength(1)
  })

  it('refuses a body in the link-bundle format', () => {
    // Feeding the wrong bundle in must fail loudly, not half-parse.
    expect(parseMeta('v1 1 1\n1,2,0abc\n')).toBeNull()
  })
})

describe('concatMetaSegments', () => {
  it('merges and rewrites the count', () => {
    const a = packMeta([entry()], 5)
    const b = packMeta([entry({ itemId: '999' }), entry({ itemId: '888' })], 6)
    const merged = concatMetaSegments([a, b], 6)
    expect(merged.split('\n')[0]).toBe('m1 6 3')
    expect(parseMeta(merged)?.entries).toHaveLength(3)
  })
})

describe('chunking past the 25 MB KV ceiling', () => {
  it('leaves a small payload as one chunk', () => {
    expect(splitIntoChunks('a\nb\nc\n', 1024)).toEqual(['a\nb\nc\n'])
  })

  it('splits only on line boundaries', () => {
    const text = ['aaaa', 'bbbb', 'cccc', 'dddd'].join('\n') + '\n'
    const chunks = splitIntoChunks(text, 12)
    expect(chunks.length).toBeGreaterThan(1)
    // Nothing may be cut mid-record.
    for (const c of chunks) expect(c.endsWith('\n')).toBe(true)
    expect(chunks.join('')).toBe(text)
  })

  it('keeps an over-long single line whole rather than truncating it', () => {
    const long = 'x'.repeat(100)
    const chunks = splitIntoChunks(`${long}\n`, 10)
    expect(chunks.join('')).toBe(`${long}\n`)
  })

  it('round-trips a real metadata body through KV', async () => {
    const body = packMeta(
      Array.from({ length: 500 }, (_, i) => entry({ itemId: String(i) })),
      1,
    )
    const kv = fakeKv(
      Object.fromEntries(
        chunkEntries('meta:full', body, 4096).map((e) => [e.key, e.value]),
      ),
    )
    const read = await readChunked(kv, 'meta:full')
    expect(read).toBe(body)
    expect(parseMeta(read!)?.entries).toHaveLength(500)
  })

  /*
   * A half-uploaded payload must read as absent. Serving the surviving parts
   * would look to every client like a complete, shorter bundle — and they
   * would record the version and stop asking.
   */
  it('reads as missing when a chunk did not upload', async () => {
    const body = packMeta(
      Array.from({ length: 200 }, (_, i) => entry({ itemId: String(i) })),
      1,
    )
    const entries = chunkEntries('meta:full', body, 2048)
    expect(entries.length).toBeGreaterThan(2)
    const seeded = Object.fromEntries(entries.map((e) => [e.key, e.value]))
    delete seeded[chunkKey('meta:full', 1)]

    expect(await readChunked(fakeKv(seeded), 'meta:full')).toBeNull()
  })

  it('reads as missing when the count key is absent', async () => {
    const kv = fakeKv({ [chunkKey('meta:full', 0)]: 'x' })
    expect(await readChunked(kv, 'meta:full')).toBeNull()
  })

  it('rejects an absurd count instead of fetching forever', async () => {
    const kv = fakeKv({ [chunkCountKey('meta:full')]: '999999' })
    expect(await readChunked(kv, 'meta:full')).toBeNull()
  })
})
