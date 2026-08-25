/**
 * URL normalisation + redirect following for affiliate links.
 * Produces a stable canonical_key so duplicate products can be detected
 * across Shopee URL shapes (slug, /product/, shortlinks, tracking params,
 * category, shop, search).
 */

import type { NormalizedUrl } from './types'

/** Realistic desktop Chrome UA — used when following redirects via Electron net. */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Tracking / affiliate query keys stripped before building url-based keys. */
const TRACKING_PARAMS = [
  'af_id',
  'smtt',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'pid',
  'sub_id',
  'sp_atk',
  'xptdk',
  'gclid',
  'fbclid',
  'is_from_share',
  // Affiliate / mobile / anti-bot tokens seen on live Shopee redirects
  'mmp_pid',
  'uls_trackid',
  'credential_token',
  'gads_t_sig',
  'exp_group',
  '__mobile__',
] as const

/**
 * Prefixes that mark tracking-ish query keys (case-insensitive).
 * Anything starting with these is dropped before building url-based keys.
 */
const TRACKING_PARAM_PREFIXES = [
  'utm_',
  'gads_',
  'mmp_',
  'uls_',
  'af_',
  'sp_',
  'fb_',
  'tt_',
  'mc_',
  'gcl',
  'credential_',
] as const

/** True when a query key is known tracking / affiliate noise. */
export function isTrackingQueryParam(key: string): boolean {
  const k = key.toLowerCase()
  for (const exact of TRACKING_PARAMS) {
    if (k === exact.toLowerCase()) return true
  }
  for (const prefix of TRACKING_PARAM_PREFIXES) {
    if (k.startsWith(prefix)) return true
  }
  // Common tracking suffixes
  if (k.endsWith('_trackid') || k.endsWith('_token') || k.endsWith('_sig')) {
    return true
  }
  return false
}

/** Reserved first path segments that are never a seller username. */
const SHOPEE_RESERVED_PATH_ROOTS = new Set([
  'product',
  'shop',
  'category',
  'search',
  'verify',
  'buyer',
  'cart',
  'mall',
  'flash_sale',
  'daily_discover',
  'portal',
  'user',
  'api',
  'seller',
  'account',
  'payment',
  'order',
  'checkout',
])

/**
 * Shopee link kinds. Affiliates routinely share category / shop / campaign
 * links, not only product pages (measured: s.shopee.vn shortlinks often 301
 * to -cat.CATID category pages).
 */
export type ShopeeLinkKind =
  | 'product'
  | 'category'
  | 'shop'
  | 'search'
  | 'unknown'

export type RedirectFollower = (url: string) => Promise<string>

/** Cap redirect hops and wall-clock time for shortlink resolution. */
const REDIRECT_FOLLOW_TIMEOUT_MS = 15_000
const REDIRECT_FOLLOW_MAX_HOPS = 20

/**
 * Follow HTTP redirects with Electron's Chromium network stack.
 *
 * Uses `net.request` with `redirect: 'manual'` (not `net.fetch`).
 * Live probe (2026-08): Shopee shortlinks (`s.shopee.vn/…`) respond with a
 * real HTTP 301 to the category/product page, but `net.fetch({ redirect:
 * 'follow' })` returns status 200 with an empty `response.url` and never
 * exposes the Location target. `net.request` fires a `redirect` event with
 * the final URL, which is what we need for canonical_key / link_kind.
 *
 * Falls back to the input URL if net is unavailable or the request fails.
 */
export async function followRedirectsWithElectronNet(
  url: string,
): Promise<string> {
  try {
    // Dynamic import keeps vitest (node) free of electron binding requirements
    // when callers inject a custom RedirectFollower.
    const { net } = await import('electron')

    return await new Promise<string>((resolve) => {
      let settled = false
      let currentUrl = url
      let hops = 0

      const finish = (finalUrl: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(finalUrl)
      }

      const timer = setTimeout(() => {
        try {
          req.abort()
        } catch {
          // ignore abort errors
        }
        finish(currentUrl || url)
      }, REDIRECT_FOLLOW_TIMEOUT_MS)

      const req = net.request({
        method: 'GET',
        url,
        redirect: 'manual',
      })

      req.setHeader('User-Agent', BROWSER_USER_AGENT)
      req.setHeader(
        'Accept',
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      )
      req.setHeader(
        'Accept-Language',
        'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
      )

      req.on(
        'redirect',
        (
          _statusCode: number,
          _method: string,
          redirectUrl: string,
        ) => {
          hops += 1
          if (redirectUrl) {
            currentUrl = redirectUrl
          }
          if (hops > REDIRECT_FOLLOW_MAX_HOPS) {
            try {
              req.abort()
            } catch {
              // ignore
            }
            finish(currentUrl || url)
            return
          }
          // Continue the redirect chain so cookies / intermediate hops work.
          req.followRedirect()
        },
      )

      req.on('response', (response) => {
        // Drain body to free the socket; content is unused.
        response.on('data', () => {
          /* discard */
        })
        response.on('end', () => {
          finish(currentUrl || url)
        })
        response.on('error', () => {
          finish(currentUrl || url)
        })
      })

      req.on('error', () => {
        finish(currentUrl || url)
      })

      req.end()
    })
  } catch {
    return url
  }
}

/** Detect marketplace platform from hostname. */
export function detectPlatform(url: string): string {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return 'other'
  }
  if (host.includes('shopee')) return 'shopee'
  if (host.includes('lazada')) return 'lazada'
  if (host.includes('tiki')) return 'tiki'
  if (host.includes('tiktok')) return 'tiktok'
  if (host.includes('sendo')) return 'sendo'
  return 'other'
}

/**
 * Extract Shopee shopId / itemId from common path forms:
 *   /product/<shopId>/<itemId>
 *   /<slug>-i.<shopId>.<itemId>
 *   /{sellerUsername}/{shopId}/{itemId}  (exactly 3 segments; username non-numeric)
 *
 * ID order matches Shopee PDP API: shop_id then item_id (same as /product/ and -i.).
 */
export function extractShopeeIds(
  url: string,
): { shop_id: string; item_id: string } | null {
  try {
    const { pathname } = new URL(url)
    const productMatch = pathname.match(/\/product\/(\d+)\/(\d+)/)
    if (productMatch) {
      return { shop_id: productMatch[1], item_id: productMatch[2] }
    }
    const slugMatch = pathname.match(/-i\.(\d+)\.(\d+)(?:\b|\/|$)/)
    if (slugMatch) {
      return { shop_id: slugMatch[1], item_id: slugMatch[2] }
    }
    // Third form: /opaanlp/502146001/26175826603
    // Require exactly two pure-numeric segments after a non-numeric username
    // so genuine shop paths like /shop/123 or bare /sellername are not mis-parsed.
    const segments = pathname.split('/').filter(Boolean)
    if (segments.length === 3) {
      const [username, shopId, itemId] = segments
      const user = username.trim()
      if (
        user &&
        !SHOPEE_RESERVED_PATH_ROOTS.has(user.toLowerCase()) &&
        !/^\d+$/.test(user) &&
        !user.includes('.') &&
        /^\d+$/.test(shopId) &&
        /^\d+$/.test(itemId)
      ) {
        return { shop_id: shopId, item_id: itemId }
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * Extract category id from Shopee category paths:
 *   /Fashion-Accessories-cat.11035853
 *   /category/11035853
 */
export function extractShopeeCategoryId(url: string): string | null {
  try {
    const { pathname } = new URL(url)
    const catSlug = pathname.match(/-cat\.(\d+)(?:\b|\/|$)/)
    if (catSlug) return catSlug[1]
    const catPath = pathname.match(/\/category\/(\d+)(?:\b|\/|$)/)
    if (catPath) return catPath[1]
  } catch {
    return null
  }
  return null
}

/**
 * Extract numeric shop id from /shop/<id> paths.
 * Bare seller username paths do not yield a numeric id (caller may still
 * classify them as kind 'shop').
 */
export function extractShopeeShopId(url: string): string | null {
  try {
    const { pathname } = new URL(url)
    const m = pathname.match(/\/shop\/(\d+)(?:\b|\/|$)/)
    if (m) return m[1]
  } catch {
    return null
  }
  return null
}

/**
 * Classify a Shopee URL into product / category / shop / search / unknown.
 * Order matters: product patterns win over category/shop.
 */
export function classifyShopeeLink(url: string): ShopeeLinkKind {
  try {
    const u = new URL(url)
    const path = u.pathname

    // All product forms (including /{username}/{shopId}/{itemId})
    if (extractShopeeIds(url)) {
      return 'product'
    }

    if (/-cat\.\d+(?:\b|\/|$)/.test(path) || /\/category\/\d+/.test(path)) {
      return 'category'
    }

    if (
      path === '/search' ||
      path.startsWith('/search/') ||
      path.includes('/search')
    ) {
      return 'search'
    }

    if (/\/shop\/\d+/.test(path)) {
      return 'shop'
    }

    // Bare seller username: single path segment without product/cat markers.
    // e.g. https://shopee.vn/some_shop_name
    // Must NOT match /{user}/{shopId}/{itemId} (that is product, handled above).
    const segments = path.split('/').filter(Boolean)
    if (segments.length === 1) {
      const seg = segments[0]
      if (
        !SHOPEE_RESERVED_PATH_ROOTS.has(seg.toLowerCase()) &&
        !seg.includes('.') &&
        !/^-?cat\./i.test(seg) &&
        !seg.startsWith('-i.')
      ) {
        return 'shop'
      }
    }

    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Strip tracking params, hash, www, trailing slash; sort remaining params.
 * Used for url-based canonical keys (non-ID platforms / unresolved shortlinks).
 *
 * Drops known tracking keys, tracking-ish prefixes (utm_*, gads_*, mmp_*, …),
 * and never retains credential_token / gads_t_sig style secrets in keys.
 */
export function stripTrackingParams(raw: string): string {
  const trimmed = raw.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`URL không hợp lệ: ${raw}`)
  }
  parsed.hash = ''
  for (const key of [...parsed.searchParams.keys()]) {
    if (isTrackingQueryParam(key)) {
      parsed.searchParams.delete(key)
    }
  }
  parsed.searchParams.sort()
  let path = parsed.pathname
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1)
  }
  parsed.pathname = path
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '')
  // Prefer https for shopee hosts
  if (parsed.hostname.includes('shopee') && parsed.protocol === 'http:') {
    parsed.protocol = 'https:'
  }
  return parsed.toString()
}

/**
 * Build unique canonical_key.
 * - product: platform:shopId:itemId (both IDs required)
 * - category: platform:cat:CATID
 * - shop: platform:shop:SHOPID
 * - else: platform:url:<stripped-url>
 */
export function buildCanonicalKey(input: {
  url: string
  platform: string
  shop_id?: string | null
  item_id?: string | null
  category_id?: string | null
  link_kind?: ShopeeLinkKind
}): string {
  const shop = input.shop_id?.trim() || null
  const item = input.item_id?.trim() || null
  if (shop && item) {
    return `${input.platform}:${shop}:${item}`
  }

  const kind =
    input.link_kind ??
    (input.platform === 'shopee' ? classifyShopeeLink(input.url) : 'unknown')

  const catId =
    input.category_id?.trim() ||
    (input.platform === 'shopee' ? extractShopeeCategoryId(input.url) : null)

  if ((kind === 'category' || catId) && catId) {
    return `${input.platform}:cat:${catId}`
  }

  const shopOnly =
    shop ||
    (input.platform === 'shopee' ? extractShopeeShopId(input.url) : null)
  if ((kind === 'shop' || (shopOnly && !item)) && shopOnly) {
    return `${input.platform}:shop:${shopOnly}`
  }

  // URL fallback: strip known tracking params for every platform.
  // For Shopee, drop the entire query string so affiliate tokens
  // (credential_token, utm_*, mmp_pid, …) never enter the local DB key
  // and differently-tracked copies of the same path collapse to one key.
  const stripped = stripTrackingParams(input.url)
  if (input.platform === 'shopee') {
    try {
      const u = new URL(stripped)
      u.search = ''
      return `${input.platform}:url:${u.toString()}`
    } catch {
      // fall through to stripped form
    }
  }
  return `${input.platform}:url:${stripped}`
}

/**
 * Human-readable fallback title from the URL slug when scrape yields nothing.
 * Vietnamese labels with diacritics.
 */
/**
 * Extract a human-readable product title from a Shopee URL slug.
 * Returns null for bare numeric paths (/product/SHOP/ITEM, /user/SHOP/ITEM)
 * so callers never treat an id as a product name (Phase 12).
 */
export function readableProductTitleFromShopeeSlug(
  url: string,
): string | null {
  try {
    const { pathname } = new URL(url)
    const segments = pathname.split('/').filter(Boolean)
    const last = segments[segments.length - 1] ?? ''

    // slug-i.SHOP.ITEM → human slug
    const m = last.match(/^(.+)-i\.\d+\.\d+$/i)
    if (m?.[1]) {
      const name = decodeURIComponent(m[1]).replace(/[-_]+/g, ' ').trim()
      if (name && !/^\d+$/.test(name) && name.length >= 3) return name
      return null
    }

    // Bare numeric last segment is the item id — never a product name
    if (/^\d+$/.test(last)) return null

    // /product/SHOP/ITEM — last is item id (already caught) or unknown
    if (segments[0]?.toLowerCase() === 'product') return null

    // /{username}/{shopId}/{itemId} — no product name in path
    if (
      segments.length >= 3 &&
      /^\d+$/.test(segments[segments.length - 1] ?? '') &&
      /^\d+$/.test(segments[segments.length - 2] ?? '')
    ) {
      return null
    }

    const name = decodeURIComponent(last).replace(/[-_]+/g, ' ').trim()
    if (!name || /^\d+$/.test(name) || name.length < 3) return null
    return name
  } catch {
    return null
  }
}

export function titleFromShopeeUrlSlug(
  url: string,
  kind: ShopeeLinkKind = classifyShopeeLink(url),
): string {
  try {
    const { pathname } = new URL(url)
    const segments = pathname.split('/').filter(Boolean)
    const last = segments[segments.length - 1] ?? ''

    if (kind === 'category') {
      // Fashion-Accessories-cat.11035853 → Fashion Accessories
      const m = last.match(/^(.+)-cat\.\d+$/i)
      const raw = m?.[1] ?? last
      const name = decodeURIComponent(raw).replace(/[-_]+/g, ' ').trim()
      return name ? `Danh mục: ${name}` : 'Danh mục Shopee'
    }

    if (kind === 'shop') {
      if (/^shop\/\d+/.test(segments.join('/')) || /^\/shop\/\d+/.test(pathname)) {
        const sid = extractShopeeShopId(url)
        return sid ? `Gian hàng #${sid}` : 'Gian hàng Shopee'
      }
      const name = decodeURIComponent(last).replace(/[-_]+/g, ' ').trim()
      return name ? `Gian hàng: ${name}` : 'Gian hàng Shopee'
    }

    if (kind === 'search') {
      try {
        const kw = new URL(url).searchParams.get('keyword')
        if (kw?.trim()) return `Tìm kiếm: ${kw.trim()}`
      } catch {
        // fall through
      }
      return 'Tìm kiếm Shopee'
    }

    if (kind === 'product') {
      // Prefer human-readable slug only (Phase 12). Bare numeric id → generic.
      const human = readableProductTitleFromShopeeSlug(url)
      return human ?? 'Sản phẩm Shopee'
    }

    const name = decodeURIComponent(last).replace(/[-_]+/g, ' ').trim()
    return name || 'Link Shopee'
  } catch {
    switch (kind) {
      case 'category':
        return 'Danh mục Shopee'
      case 'shop':
        return 'Gian hàng Shopee'
      case 'search':
        return 'Tìm kiếm Shopee'
      default:
        return 'Link Shopee'
    }
  }
}

/**
 * Normalise a product/affiliate URL into a stable key.
 * Follows redirects (shortlinks like s.shopee.vn) then extracts IDs.
 *
 * All of these map to the same key for shop=111 item=222:
 *   https://shopee.vn/slug-i.111.222
 *   https://shopee.vn/product/111/222
 *   https://s.shopee.vn/CODE  (after redirect)
 *   any of the above + af_id / smtt / utm_* / pid / sub_id
 *
 * Category shortlinks map to platform:cat:CATID after redirect.
 */
export async function normalizeUrl(
  raw: string,
  followRedirects: RedirectFollower = followRedirectsWithElectronNet,
): Promise<NormalizedUrl> {
  const original_url = raw.trim()
  if (!original_url) {
    throw new Error('Link không được để trống')
  }

  // Validate early
  try {
    void new URL(original_url)
  } catch {
    throw new Error(`URL không hợp lệ: ${raw}`)
  }

  let final_url = original_url
  const platformHint = detectPlatform(original_url)

  // Follow redirects for shortlinks / unresolved paths, or any Shopee URL
  // that does not yet expose product / category / shop identity.
  const earlyKind =
    platformHint === 'shopee' ? classifyShopeeLink(original_url) : 'unknown'
  const hasIdentity =
    earlyKind === 'product' ||
    earlyKind === 'category' ||
    (earlyKind === 'shop' && extractShopeeShopId(original_url) !== null)

  const needsRedirect =
    platformHint === 'shopee' &&
    (!hasIdentity || isShopeeShortlink(original_url))

  if (needsRedirect || isShopeeShortlink(original_url)) {
    final_url = await followRedirects(original_url)
  }

  // If still no IDs after shortlink, try once more on final
  let platform = detectPlatform(final_url)
  if (platform === 'other') {
    platform = platformHint
  }

  let shop_id: string | null = null
  let item_id: string | null = null
  let category_id: string | null = null
  let link_kind: ShopeeLinkKind = 'unknown'

  if (platform === 'shopee') {
    link_kind = classifyShopeeLink(final_url)
    if (link_kind === 'unknown') {
      link_kind = classifyShopeeLink(original_url)
    }

    const ids =
      extractShopeeIds(final_url) ?? extractShopeeIds(original_url)
    if (ids) {
      shop_id = ids.shop_id
      item_id = ids.item_id
      link_kind = 'product'
    }

    category_id =
      extractShopeeCategoryId(final_url) ??
      extractShopeeCategoryId(original_url)
    if (category_id && link_kind !== 'product') {
      link_kind = 'category'
    }

    if (link_kind === 'shop' || (!item_id && !category_id)) {
      const sid =
        extractShopeeShopId(final_url) ?? extractShopeeShopId(original_url)
      if (sid) {
        shop_id = shop_id ?? sid
        if (!item_id && !category_id) link_kind = 'shop'
      }
    }
  }

  const keySource = final_url

  const canonical_key = buildCanonicalKey({
    url: keySource,
    platform,
    shop_id,
    item_id,
    category_id,
    link_kind: platform === 'shopee' ? link_kind : undefined,
  })

  return {
    original_url,
    final_url,
    platform,
    shop_id,
    item_id,
    canonical_key,
    link_kind: platform === 'shopee' ? link_kind : undefined,
    category_id: platform === 'shopee' ? category_id : undefined,
  }
}

/** True for s.shopee.vn / shp.ee style short hosts. */
export function isShopeeShortlink(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
    return (
      host === 's.shopee.vn' ||
      host === 'shp.ee' ||
      host.startsWith('s.shopee.') ||
      host === 'shope.ee'
    )
  } catch {
    return false
  }
}
