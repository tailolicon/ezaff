/**
 * Which pasted text counts as an affiliate link ezaff can add.
 *
 * Shared by the main process (clipboard read) and the renderer (add dialog)
 * so the two can never disagree about what "hợp lệ" means.
 */

/**
 * Registrable domains we accept, matched exactly or as a parent of the host.
 *
 * Includes the short-link domains Shopee hands out from the mobile share sheet
 * (`shp.ee`, `shope.ee`) — they carry no "shopee." substring, so a naive name
 * match silently rejects the links people paste most often.
 *
 * Matching is anchored on the domain boundary so a look-alike host such as
 * `shopee.vn.example.com` is NOT treated as Shopee.
 */
const SUPPORTED_DOMAINS = [
  'shopee.vn',
  'shopee.com',
  'shopee.sg',
  'shopee.ph',
  'shopee.tw',
  'shopee.co.id',
  'shopee.co.th',
  'shopee.com.my',
  'shopee.com.br',
  'shp.ee',
  'shope.ee',
  'lazada.vn',
  'lazada.sg',
  'lazada.co.id',
  'lazada.co.th',
  'lazada.com.my',
  'lazada.com.ph',
  'lzd.co',
  'tiktok.com',
  'tiki.vn',
  'sendo.vn',
] as const

function isSupportedHost(host: string): boolean {
  return SUPPORTED_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  )
}

/** Trailing characters people leave when copying a link out of a sentence. */
const TRAILING_JUNK = /[)\]}>,.;:!?"'…]+$/

/** Normalise one token into a candidate URL, or null when it is not one. */
function toCandidate(token: string): string | null {
  const raw = token.trim().replace(TRAILING_JUNK, '')
  if (!raw) return null
  if (!/^https?:\/\/\S+$/i.test(raw)) return null
  return raw
}

/** True when the URL points at a marketplace ezaff knows how to scrape. */
export function isSupportedLink(raw: string): boolean {
  const candidate = toCandidate(raw)
  if (!candidate) return false
  try {
    const host = new URL(candidate).hostname.toLowerCase().replace(/^www\./, '')
    return isSupportedHost(host)
  } catch {
    return false
  }
}

/**
 * Pull every supported link out of arbitrary text.
 *
 * Splits on any whitespace, so all of these yield both links:
 * - one per line
 * - two on the same line separated by a space
 * - links embedded in a sentence copied from chat
 *
 * Order is preserved and duplicates are dropped.
 */
export function extractLinks(text: string): string[] {
  if (!text) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of text.split(/\s+/)) {
    const candidate = toCandidate(token)
    if (!candidate || !isSupportedLink(candidate)) continue
    if (seen.has(candidate)) continue
    seen.add(candidate)
    out.push(candidate)
  }
  return out
}
