/**
 * Product metadata bundle — name, price, rating, sold count, commission.
 *
 * Separate from the link bundle on purpose. The link bundle is what the 5%
 * mechanism needs and is small enough to be mandatory; this one is roughly
 * eight times larger and only makes the app faster, so a client that fails to
 * fetch it still works — it just falls back to scraping, exactly as before.
 *
 * What it buys: adding a product that is already covered fills in instantly
 * with no network call. Scraping stays for everything else, and stays the
 * fallback whenever Shopee lists something new.
 *
 * ── Wire format ───────────────────────────────────────────────────────────
 *   m1 <version> <count>
 *   shopId⇥itemId⇥pct⇥price⇥sold⇥rating⇥shopName⇥productName
 *
 * Tab-separated rather than CSV: product titles are full of commas and quotes
 * and a quoting layer here is a parser bug waiting to happen on both ends.
 * Tabs and newlines are stripped from the two text fields when packing, so a
 * row can never span lines.
 *
 * `est_commission_vnd` from the harvest is deliberately dropped — it is just
 * price × pct, and recomputing on the client is cheaper than shipping it for
 * every one of 132k rows.
 */

export const META_FORMAT = 'm1'

export type MetaEntry = {
  shopId: string
  itemId: string
  /** Commission rate in percent, e.g. 15. */
  commissionPct: number
  /** Price in VND. 0 when the harvest captured none. */
  priceVnd: number
  historicalSold: number
  /** 0–5; 0 means unrated. */
  rating: number
  shopName: string
  name: string
}

const ID_RE = /^\d{1,20}$/

/** Tabs and newlines would break the row layout; nothing else is touched. */
function sanitise(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ').trim()
}

function num(value: unknown, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(Math.round(n), max)
}

export function packMeta(entries: MetaEntry[], version: number): string {
  const lines: string[] = []
  for (const e of entries) {
    if (!ID_RE.test(e.shopId) || !ID_RE.test(e.itemId)) continue
    lines.push(
      [
        e.shopId,
        e.itemId,
        num(e.commissionPct, 100),
        num(e.priceVnd, 1e12),
        num(e.historicalSold, 1e9),
        num(e.rating, 5),
        sanitise(e.shopName),
        sanitise(e.name),
      ].join('\t'),
    )
  }
  return `${META_FORMAT} ${version} ${lines.length}\n${lines.join('\n')}\n`
}

export type ParsedMeta = {
  version: number
  entries: MetaEntry[]
}

/** Bad rows are skipped, never guessed at — a wrong price is worse than none. */
export function parseMeta(text: string): ParsedMeta | null {
  const newline = text.indexOf('\n')
  if (newline === -1) return null

  const header = text.slice(0, newline).trim().split(/\s+/)
  if (header[0] !== META_FORMAT) return null
  const version = Number(header[1])
  if (!Number.isInteger(version) || version < 0) return null

  const entries: MetaEntry[] = []
  for (const line of text.slice(newline + 1).split('\n')) {
    if (line === '') continue
    const f = line.split('\t')
    if (f.length !== 8) continue
    const [shopId, itemId, pct, price, sold, rating, shopName, name] = f as [
      string, string, string, string, string, string, string, string,
    ]
    if (!ID_RE.test(shopId) || !ID_RE.test(itemId)) continue
    entries.push({
      shopId,
      itemId,
      commissionPct: num(pct, 100),
      priceVnd: num(price, 1e12),
      historicalSold: num(sold, 1e9),
      rating: num(rating, 5),
      shopName,
      name,
    })
  }
  return { version, entries }
}

/** Join packed segments, rewriting the header count. */
export function concatMetaSegments(
  segments: string[],
  version: number,
): string {
  const lines: string[] = []
  for (const seg of segments) {
    const newline = seg.indexOf('\n')
    if (newline === -1) continue
    for (const line of seg.slice(newline + 1).split('\n')) {
      if (line !== '') lines.push(line)
    }
  }
  return `${META_FORMAT} ${version} ${lines.length}\n${lines.join('\n')}\n`
}
