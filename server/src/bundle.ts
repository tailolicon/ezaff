/**
 * Owner-link bundle: the whole mapping table shipped to every client.
 *
 * Why a bundle instead of per-product lookups: with ~130k mappings, asking the
 * Worker once per product means millions of requests and KV reads for a few
 * thousand users. Shipping the table once and syncing daily deltas turns that
 * into one request per user per day, and every lookup becomes local — no
 * network on the copy path at all.
 *
 * ── Wire format ───────────────────────────────────────────────────────────
 * Plain text, one entry per line, so it streams and stays debuggable:
 *
 *   v1 <version> <count>
 *   <shopId>,<itemId>,<hostIndex><code>
 *   …
 *
 * `code` is only the shortlink's path segment and `hostIndex` indexes
 * SHORTLINK_HOSTS — a full "https://s.shopee.vn/" prefix on every one of
 * 130k rows is 20 wasted bytes each.
 *
 * Text rather than a packed binary layout: the shortlink codes are random
 * base62 and barely compress either way, so binary would save ~10% for a
 * hand-rolled parser on both ends. Not worth the bug surface. Cloudflare
 * gzips the response anyway.
 */

/** Index into this list is the leading char of the packed code. */
export const SHORTLINK_HOSTS = ['s.shopee.vn', 'shope.ee', 'shp.ee'] as const

export const BUNDLE_FORMAT = 'v1'

export type BundleEntry = {
  shopId: string
  itemId: string
  /** Full https URL. */
  url: string
}

export type ParsedBundle = {
  version: number
  entries: BundleEntry[]
}

/** KV keys. Segments hold one publish each; full holds the whole snapshot. */
export const BUNDLE_META_KEY = 'bundle:meta'
export const BUNDLE_FULL_KEY = 'bundle:full'
export const bundleSegmentKey = (version: number): string =>
  `bundle:seg:${version}`

export type BundleMeta = {
  /** Current published version — clients compare their own against this. */
  version: number
  /** Total entries in the full snapshot. */
  count: number
  /**
   * Versions with a stored delta segment, ascending. A client older than the
   * first one has to take the full snapshot.
   */
  segments: number[]
}

const CODE_RE = /^[A-Za-z0-9_-]{1,64}$/
const ID_RE = /^\d{1,20}$/

/** "https://s.shopee.vn/abc123" → "0abc123". Null when unrecognised. */
export function packUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  const hostIndex = SHORTLINK_HOSTS.indexOf(host as (typeof SHORTLINK_HOSTS)[number])
  if (hostIndex === -1) return null

  const code = parsed.pathname.replace(/^\//, '').replace(/\/$/, '')
  if (!CODE_RE.test(code)) return null

  return `${hostIndex}${code}`
}

/** "0abc123" → "https://s.shopee.vn/abc123". Null when malformed. */
export function unpackUrl(packed: string): string | null {
  if (packed.length < 2) return null
  const hostIndex = Number(packed[0])
  const host = SHORTLINK_HOSTS[hostIndex]
  if (!host) return null
  const code = packed.slice(1)
  if (!CODE_RE.test(code)) return null
  return `https://${host}/${code}`
}

/** Serialise entries. Rows that cannot be packed are dropped, not guessed. */
export function packBundle(entries: BundleEntry[], version: number): string {
  const lines: string[] = []
  for (const e of entries) {
    if (!ID_RE.test(e.shopId) || !ID_RE.test(e.itemId)) continue
    const packed = packUrl(e.url)
    if (!packed) continue
    lines.push(`${e.shopId},${e.itemId},${packed}`)
  }
  return `${BUNDLE_FORMAT} ${version} ${lines.length}\n${lines.join('\n')}\n`
}

/** Parse a packed bundle. Bad lines are skipped so one typo cannot void a sync. */
export function parseBundle(text: string): ParsedBundle | null {
  const newline = text.indexOf('\n')
  if (newline === -1) return null

  const header = text.slice(0, newline).trim().split(/\s+/)
  if (header[0] !== BUNDLE_FORMAT) return null
  const version = Number(header[1])
  if (!Number.isInteger(version) || version < 0) return null

  const entries: BundleEntry[] = []
  for (const line of text.slice(newline + 1).split('\n')) {
    if (line === '') continue
    const parts = line.split(',')
    if (parts.length !== 3) continue
    const [shopId, itemId, packed] = parts as [string, string, string]
    if (!ID_RE.test(shopId) || !ID_RE.test(itemId)) continue
    const url = unpackUrl(packed)
    if (!url) continue
    entries.push({ shopId, itemId, url })
  }

  return { version, entries }
}

/** Join several packed segments into one response body. */
export function concatSegments(segments: string[], version: number): string {
  const lines: string[] = []
  for (const seg of segments) {
    const newline = seg.indexOf('\n')
    if (newline === -1) continue
    const body = seg.slice(newline + 1)
    for (const line of body.split('\n')) {
      if (line !== '') lines.push(line)
    }
  }
  return `${BUNDLE_FORMAT} ${version} ${lines.length}\n${lines.join('\n')}\n`
}

export async function readBundleMeta(
  kv: KVNamespace,
  key: string = BUNDLE_META_KEY,
): Promise<BundleMeta> {
  const raw = await kv.get(key)
  if (!raw) return { version: 0, count: 0, segments: [] }
  try {
    const parsed = JSON.parse(raw) as Partial<BundleMeta>
    return {
      version: Number(parsed.version ?? 0),
      count: Number(parsed.count ?? 0),
      segments: Array.isArray(parsed.segments)
        ? parsed.segments.map(Number).filter(Number.isInteger).sort((a, b) => a - b)
        : [],
    }
  } catch {
    return { version: 0, count: 0, segments: [] }
  }
}

export type BundleResponse =
  | { kind: 'up_to_date'; version: number }
  | { kind: 'full'; version: number; body: string }
  | { kind: 'delta'; version: number; body: string }
  | { kind: 'empty'; version: number }

/**
 * Decide what a client on `since` should receive.
 *
 * Falls back to the full snapshot whenever the delta chain cannot cover the
 * gap — a client that has been offline for months must still end up correct,
 * and silently handing it a partial delta would leave it permanently missing
 * whatever fell out of the segment window.
 */
export async function buildBundleResponse(
  kv: KVNamespace,
  since: number,
): Promise<BundleResponse> {
  const meta = await readBundleMeta(kv)
  if (meta.version === 0) return { kind: 'empty', version: 0 }
  if (since >= meta.version) return { kind: 'up_to_date', version: meta.version }

  const needed = meta.segments.filter((v) => v > since)

  /*
   * Deltas are only safe when every version after the client's has a stored
   * segment. Publishes bump the version by exactly 1 and write one segment,
   * so the oldest surviving segment being <= since+1 proves nothing the
   * client still needs has been pruned. Any gap and it takes the snapshot —
   * handing over a partial delta would leave it permanently short of whatever
   * fell out of the window, with no way to notice.
   */
  const oldest = meta.segments[0]
  const canDelta =
    since > 0 &&
    needed.length > 0 &&
    oldest !== undefined &&
    oldest <= since + 1

  if (canDelta) {
    const bodies = await Promise.all(
      needed.map((v) => kv.get(bundleSegmentKey(v))),
    )
    if (bodies.every((b): b is string => typeof b === 'string')) {
      return {
        kind: 'delta',
        version: meta.version,
        body: concatSegments(bodies, meta.version),
      }
    }
  }

  const full = await kv.get(BUNDLE_FULL_KEY)
  if (full == null) return { kind: 'empty', version: meta.version }
  return { kind: 'full', version: meta.version, body: full }
}
