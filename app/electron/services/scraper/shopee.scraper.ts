/**
 * Shopee deep scraper — homepage-origin + same-origin in-page API.
 *
 * Strategy (Phase 3.2, measured against live shopee.vn):
 *   1. Load ONLY https://shopee.vn/ in a hidden BrowserWindow
 *   2. Perform every lookup as same-origin in-page fetch with ids parsed
 *      from the (redirect-resolved) affiliate URL
 *   3. Never call loadURL with a product / category / deep link
 *
 * WHY homepage only (fact B): navigating a clean automated Chromium DIRECTLY
 * to a deep category/product URL gets bounced to
 *   https://shopee.vn/verify/traffic/error?...&type=4
 * even after first loading the homepage successfully. Deep-link navigation
 * is exactly what trips Shopee's traffic verification. Same-origin API
 * calls from a page already on the shopee.vn origin still return HTTP 200
 * with real JSON (fact C) — including while the document is on the verify
 * page. So we stay on the origin homepage and fetch APIs in-page.
 *
 * WHY payload validation (fact D): under repeated automated access some
 * endpoints return HTTP 200 with an empty payload (soft block). A 200
 * status alone must never be treated as success.
 */

import {
  extractJsonLdProducts,
  extractOpenGraph,
  parsePriceAmount,
} from './htmlMeta'
import {
  ANTIBOT_SIGNED_ERROR_VI,
  ANTIBOT_UNSIGNED_ERROR_VI,
  isShopeeAntiBotError,
  messageForProductLookupFailure,
  probeShopeeSignedIn,
  SHOPEE_SESSION_PARTITION,
  shopeePartitionWebPreferences,
} from './shopeeSession'
import { buildCategoryPath } from '../categoryPath'
import type { ScrapeResult, Scraper } from './types'
import {
  emptyScrapeResult,
  missingProductFields,
  partialMissingLabel,
} from './types'
import {
  BROWSER_USER_AGENT,
  classifyShopeeLink,
  extractShopeeCategoryId,
  extractShopeeIds,
  extractShopeeShopId,
  isShopeeShortlink,
  readableProductTitleFromShopeeSlug,
  titleFromShopeeUrlSlug,
  type ShopeeLinkKind,
} from './urlNormalizer'
import { logWarn } from '../../services/log'

// Re-export auth error strings so existing importers / tests can use them
export {
  ANTIBOT_SIGNED_ERROR_VI,
  ANTIBOT_UNSIGNED_ERROR_VI,
  isShopeeAntiBotError,
  messageForProductLookupFailure,
  SHOPEE_SESSION_PARTITION,
}

/** Hard cap for the whole scrape session (load + API lookups). */
const TOTAL_TIMEOUT_MS = 30_000

/** Single retry delay when bounced to /verify/traffic (not a tight loop). */
const VERIFY_RETRY_DELAY_MS = 2_500

/** Homepage only — never deep product/category URLs (fact B). */
const SHOPEE_HOMEPAGE = 'https://shopee.vn/'

/** Vietnamese message when Shopee traffic verification blocks automation. */
export const TRAFFIC_VERIFY_ERROR_VI =
  'Shopee đang tạm chặn tra cứu tự động. Vui lòng nhập tay tên, ảnh và thông tin chi tiết.'

/** Vietnamese manual-entry message when scrape yields no usable name/image. */
export const MANUAL_ENTRY_ERROR_VI =
  'Không quét được thông tin Shopee. Bạn có thể nhập tay tên và ảnh.'

/** Shopee PDP prices are VND × 100_000 (micro-units). */
const SHOPEE_PRICE_MICRO = 100_000

/** Reject converted prices outside a plausible VND retail range. */
const MIN_PLAUSIBLE_VND = 1
/** 50 tỷ VND — upper bound stays inside Number.MAX_SAFE_INTEGER as micro-units. */
const MAX_PLAUSIBLE_VND = 50_000_000_000

function shopeeHostsMatch(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host.includes('shopee') || host === 'shp.ee' || host === 'shope.ee'
  } catch {
    return false
  }
}

function toImageUrl(path: string | null | undefined): string | null {
  if (!path) return null
  const trimmed = path.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed
  }
  const key = trimmed.replace(/^\/+/, '')
  return `https://down-vn.img.susercontent.com/file/${key}`
}

/**
 * Convert a Shopee PDP API price (micro-units) to whole VND.
 * Always divides by 100_000 — do not use a heuristic threshold.
 * Returns null for non-positive or implausible results after conversion.
 */
export function convertShopeePdpPrice(raw: unknown): number | null {
  let n: number | null = null
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    n = raw
  } else if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number.parseInt(raw.replace(/[^\d-]/g, ''), 10)
    if (Number.isFinite(parsed)) n = parsed
  }
  if (n === null || n <= 0) return null

  const vnd = Math.round(n / SHOPEE_PRICE_MICRO)
  if (vnd < MIN_PLAUSIBLE_VND || vnd > MAX_PLAUSIBLE_VND) return null
  return vnd
}

/**
 * Normalize a price that may already be whole VND (DOM / JSON-LD display)
 * or Shopee micro-units (API / INITIAL_STATE).
 *
 * - `micro`: always ÷ 100_000 (PDP API contract)
 * - `display`: treat as whole VND (₫ text, product:price:amount)
 * - `auto`: values ≥ 100_000_000 look like micro-units (≥ ~1_000 ₫);
 *   smaller values are treated as whole VND so DOM "168500" is not
 *   mis-converted to 2 ₫ via ÷ 100_000
 */
export function normalizeShopeePriceValue(
  raw: unknown,
  unit: 'micro' | 'display' | 'auto' = 'auto',
): number | null {
  if (unit === 'micro') return convertShopeePdpPrice(raw)

  let n: number | null = null
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    n = raw
  } else if (typeof raw === 'string' && raw.trim()) {
    // Prefer shared display parser for "168.500", "168500.00", "₫168.500"
    const fromDisplay = parsePriceAmount(raw.replace(/[₫đ]/gi, '').trim())
    if (fromDisplay != null) n = fromDisplay
    else {
      const parsed = Number.parseInt(raw.replace(/[^\d-]/g, ''), 10)
      if (Number.isFinite(parsed)) n = parsed
    }
  }
  if (n === null || n <= 0) return null

  if (unit === 'display') {
    const vnd = Math.round(n)
    if (vnd < MIN_PLAUSIBLE_VND || vnd > MAX_PLAUSIBLE_VND) return null
    return vnd
  }

  // auto: micro-units for real items are typically ≥ 1_000 VND × 100_000
  if (n >= 100_000_000) {
    return convertShopeePdpPrice(n)
  }
  const vnd = Math.round(n)
  if (vnd < MIN_PLAUSIBLE_VND || vnd > MAX_PLAUSIBLE_VND) return null
  return vnd
}

/**
 * Pick price from a PDP item object (micro-units → VND).
 * Also walks `models[]` when top-level price fields are empty.
 */
export function pickPriceFromItem(item: Record<string, unknown>): number | null {
  const candidates = [
    item.price_min,
    item.price,
    item.price_max,
    item.price_before_discount,
    item.price_min_before_discount,
  ]
  for (const c of candidates) {
    const vnd = convertShopeePdpPrice(c)
    if (vnd !== null) return vnd
  }
  // Variant models often hold the only non-zero price when the parent is 0
  if (Array.isArray(item.models)) {
    for (const model of item.models) {
      if (!model || typeof model !== 'object' || Array.isArray(model)) continue
      const nested = pickPriceFromItem(model as Record<string, unknown>)
      if (nested !== null) return nested
    }
  }
  return null
}

/**
 * Shopee success bodies use top-level `error: 0` (or missing).
 * Any other truthy / non-zero error means the payload is not usable.
 */
export function hasShopeeApiError(data: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(data, 'error')) return false
  const err = data.error
  if (err === null || err === undefined) return false
  if (err === 0 || err === '0' || err === false || err === '') return false
  return true
}

/**
 * Detect Shopee traffic / captcha challenge bounce (fact B).
 * Includes /verify/traffic and /verify/captcha (measured 2026-08: product
 * deep-links land on captcha even when session is "signed in").
 */
export function isTrafficVerifyUrl(href: string): boolean {
  if (!href || typeof href !== 'string') return false
  const lower = href.toLowerCase()
  return (
    lower.includes('/verify/traffic') ||
    lower.includes('/verify/captcha') ||
    /shopee\.[^/]+\/verify\//i.test(lower)
  )
}

/** Titles that indicate a challenge page, not a product. */
export function isShopeeChallengeTitle(
  title: string | null | undefined,
): boolean {
  if (!title) return false
  const t = title.trim()
  if (!t) return false
  return (
    /^verify\b/i.test(t) ||
    /verify to continue/i.test(t) ||
    /traffic verification/i.test(t) ||
    /something is missing/i.test(t) ||
    /access denied/i.test(t) ||
    /\bcaptcha\b/i.test(t)
  )
}

/**
 * Payload validation (fact D): never trust HTTP 200 alone.
 * Rejects empty payloads, empty items arrays, missing data objects,
 * and non-zero top-level error fields.
 */
export function isUsableShopeeApiPayload(data: unknown): data is Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  const d = data as Record<string, unknown>

  // Transport-level marker from in-page fetch helper
  if (typeof d.__http_status === 'number' && d.__http_status !== 200) {
    return false
  }

  if (hasShopeeApiError(d)) return false

  // Soft-block: empty top-level payload (only error:0 or nothing useful)
  const keys = Object.keys(d).filter(
    (k) => k !== 'error' && k !== 'error_msg' && k !== '__http_status',
  )
  if (keys.length === 0) return false

  // Explicit empty items array at top level
  if (Array.isArray(d.items) && d.items.length === 0) return false

  // data: null / empty array = soft block
  if (Object.prototype.hasOwnProperty.call(d, 'data')) {
    if (d.data === null || d.data === undefined) return false
    if (Array.isArray(d.data) && d.data.length === 0) return false
    if (typeof d.data === 'object' && !Array.isArray(d.data)) {
      const dataObj = d.data as Record<string, unknown>
      if (Array.isArray(dataObj.items) && dataObj.items.length === 0) {
        return false
      }
      // Completely empty data object with no known content keys
      const dataKeys = Object.keys(dataObj)
      if (dataKeys.length === 0) return false
    }
  }

  return true
}

/**
 * Which scrape tier produced a usable result (pure helper for tests).
 * Prefer API → share-preview OG → authenticated product-page DOM → browser DOM → fail.
 */
export function selectScrapeTier(
  apiResult: ScrapeResult | null,
  browserResult: ScrapeResult | null,
  authDomResult?: ScrapeResult | null,
  opengraphResult?: ScrapeResult | null,
): 'api' | 'opengraph' | 'auth_dom' | 'browser' | 'fail' {
  if (apiResult?.ok) return 'api'
  if (opengraphResult?.ok) return 'opengraph'
  if (authDomResult?.ok) return 'auth_dom'
  if (browserResult?.ok) return 'browser'
  return 'fail'
}

/**
 * User agents that Shopee serves Open Graph meta for (link-preview bots).
 * Measured live 2026-08: facebookexternalhit + WhatsApp get og:title / og:image
 * on /product/SHOP/ITEM; regular Chrome SPA shell has no OG; Googlebot gets 404.
 * This is the same data messengers show when a user pastes a Shopee link.
 */
export const SHOPEE_SHARE_PREVIEW_USER_AGENTS = [
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'WhatsApp/2.23.20.0',
  // Measured 2026-08: still get og:title/image; occasionally Product JSON-LD w/ price
  'Twitterbot/1.0',
  'TelegramBot (like TwitterBot)',
] as const

/** Extra share-preview attempts when price is still missing (Shopee is intermittent). */
const SHARE_PREVIEW_PRICE_RETRIES = 2
const SHARE_PREVIEW_RETRY_DELAY_MS = 450

/** Strip marketplace suffix from Shopee OG titles. */
export function cleanShopeeOgTitle(raw: string | null | undefined): string | null {
  if (raw == null) return null
  let t = raw.trim()
  if (!t) return null
  t = t
    .replace(/\s*[|–—-]\s*Shopee\s*Việt\s*Nam\s*$/iu, '')
    .replace(/\s*[|–—-]\s*Shopee\s*$/iu, '')
    .trim()
  // Bare marketplace name is not a product title
  if (!t || /^Shopee(?:\s*Việt\s*Nam)?$/iu.test(t)) return null
  return t
}

/**
 * Shopee's deepest breadcrumb is often a filter facet rather than a real
 * category — "Trên 20.000 mAh", "Từ 6.5 inch", "Dưới 500g", "128GB".
 * Those are useless as a library category, so we skip them and fall back to
 * the nearest meaningful parent ("Pin dự phòng").
 */
export function isSpecLikeCategory(name: string): boolean {
  const n = name.trim()
  if (!n) return true

  // "Trên/Dưới/Từ/Trước … <số>" and numeric ranges: "5 - 10 kg", "20.000+"
  if (/^(trên|duoi|dưới|từ|tu|hơn|hon|trong khoảng)\b/iu.test(n)) return true
  if (/^\d[\d.,\s]*\s*[-–—]\s*\d/u.test(n)) return true

  // A measurement unit anywhere next to a number is a spec, not a category
  const UNIT =
    /\d\s*(mah|mm|cm|m|ml|l|lít|lit|kg|g|gam|gb|tb|mb|inch|"|w|kw|v|hz|k|px|mp|core|nhân|chiếc|cái|miếng|viên|người|tuổi|độ|°c)\b/iu
  if (UNIT.test(n)) return true

  // Pure number / number with separators
  if (/^[\d.,+\s]+$/u.test(n)) return true

  return false
}

/**
 * Pick the deepest breadcrumb that reads like a category.
 * Falls back to the deepest crumb when every level looks spec-like.
 */
export function pickUsefulCategory(
  names: string[],
  productTitle?: string | null,
): string | null {
  const titleNorm = productTitle?.trim().toLowerCase() ?? ''

  /**
   * A crumb is the product name, not a category, when it matches the title
   * (or all but a word of it). A short crumb that merely appears inside the
   * title stays — "Áo thun" is a real category for "Áo thun basic".
   */
  const isProductTitle = (n: string): boolean => {
    if (!titleNorm) return false
    const c = n.toLowerCase()
    if (c === titleNorm) return true
    if (c.includes(titleNorm)) return true
    return titleNorm.includes(c) && c.length >= titleNorm.length * 0.8
  }

  const usable = names
    .map((n) => n.trim())
    .filter(
      (n) =>
        n.length > 0 &&
        n.length <= 60 &&
        !/^Shopee(\s*Việt\s*Nam)?$/iu.test(n) &&
        !/^(Others|Khác|Other|Sản phẩm khác)$/iu.test(n) &&
        !isProductTitle(n),
    )

  if (usable.length === 0) return null

  for (let i = usable.length - 1; i >= 0; i--) {
    if (!isSpecLikeCategory(usable[i]!)) return usable[i]!
  }
  // Everything looked like a spec — better a rough label than nothing
  return usable[usable.length - 1]!
}

/**
 * Every breadcrumb name from the first JSON-LD BreadcrumbList in the page,
 * in order. Site root and the product-name crumb are left in — callers decide.
 */
export function extractBreadcrumbNames(html: string): string[] {
  const re =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) {
    const raw = match[1]?.trim()
    if (!raw || !/BreadcrumbList/i.test(raw)) continue
    try {
      const parsed: unknown = JSON.parse(raw)
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? [parsed]
          : []
      for (const node of list) {
        if (!node || typeof node !== 'object') continue
        const obj = node as Record<string, unknown>
        if (!/BreadcrumbList/i.test(String(obj['@type'] ?? ''))) continue
        const elements = obj.itemListElement
        if (!Array.isArray(elements) || elements.length === 0) continue

        const names: string[] = []
        for (const el of elements) {
          if (!el || typeof el !== 'object') continue
          const entry = el as Record<string, unknown>
          const item =
            entry.item && typeof entry.item === 'object'
              ? (entry.item as Record<string, unknown>)
              : entry
          const name =
            (item && typeof item.name === 'string' && item.name.trim()) ||
            (typeof entry.name === 'string' && entry.name.trim()) ||
            null
          if (name) names.push(name)
        }
        if (names.length > 0) return names
      }
    } catch {
      // ignore malformed JSON-LD
    }
  }
  return []
}

/**
 * Full category chain from the page breadcrumbs, minus the site root and the
 * product-title crumb: "Điện Thoại & Phụ Kiện > Phụ kiện điện thoại > …".
 */
export function extractCategoryPathFromShopeeHtml(
  html: string,
  productTitle?: string | null,
): string | null {
  const names = extractBreadcrumbNames(html)
  if (names.length === 0) return null
  const titleNorm = productTitle?.trim().toLowerCase() ?? ''
  return buildCategoryPath(
    names.filter((n) => !titleNorm || n.trim().toLowerCase() !== titleNorm),
  )
}

/**
 * Extract a category hint from JSON-LD BreadcrumbList.
 * Prefer the last non-product breadcrumb (skip site root "Shopee" and the
 * final crumb when it looks like the product name itself).
 */
export function extractCategoryFromShopeeHtml(
  html: string,
  productTitle?: string | null,
): string | null {
  const re =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) {
    const raw = match[1]?.trim()
    if (!raw || !/BreadcrumbList/i.test(raw)) continue
    try {
      const parsed: unknown = JSON.parse(raw)
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? [parsed]
          : []
      for (const node of list) {
        if (!node || typeof node !== 'object') continue
        const obj = node as Record<string, unknown>
        const type = String(obj['@type'] ?? '')
        if (!/BreadcrumbList/i.test(type)) continue
        const elements = obj.itemListElement
        if (!Array.isArray(elements) || elements.length === 0) continue

        const names: string[] = []
        for (const el of elements) {
          if (!el || typeof el !== 'object') continue
          const entry = el as Record<string, unknown>
          const item =
            entry.item && typeof entry.item === 'object'
              ? (entry.item as Record<string, unknown>)
              : entry
          const name =
            (item && typeof item.name === 'string' && item.name.trim()) ||
            (typeof entry.name === 'string' && entry.name.trim()) ||
            null
          if (name) names.push(name)
        }

        const picked = pickUsefulCategory(names, productTitle)
        if (picked) return picked
      }
    } catch {
      // ignore malformed JSON-LD
    }
  }
  return null
}

/**
 * Map share-preview HTML (OG / Twitter / title) into a product ScrapeResult.
 * Pure helper — no network. Partial success (title and/or image) is OK.
 */
export function mapShopeeSharePreviewHtml(
  html: string,
  shopId: string,
  itemId: string,
): ScrapeResult | null {
  if (!html || typeof html !== 'string') return null

  const og = extractOpenGraph(html)
  const products = extractJsonLdProducts(html)
  const product = products[0]

  const title = cleanShopeeOgTitle(
    og.title ?? product?.name ?? extractHtmlDocumentTitle(html),
  )
  const image =
    toImageUrl(og.image ?? product?.image ?? null) ??
    (og.image?.startsWith('http') ? og.image : null)
  const price =
    parsePriceAmount(og.priceAmount) ?? product?.price ?? null
  const currency = og.priceCurrency ?? product?.currency ?? 'VND'
  const description = og.description ?? product?.description ?? null
  const rawCategory =
    product?.category ?? extractCategoryFromShopeeHtml(html, title)
  // Never store product title as category
  const category =
    rawCategory &&
    (!title ||
      rawCategory.trim().toLowerCase() !== title.trim().toLowerCase())
      ? rawCategory
      : null
  const category_path = extractCategoryPathFromShopeeHtml(html, title)
  const shopName = product?.brand ?? null
  const rating =
    product?.rating != null &&
    Number.isFinite(product.rating) &&
    product.rating > 0 &&
    product.rating <= 5
      ? product.rating
      : null
  const rating_count =
    product?.rating_count != null &&
    Number.isFinite(product.rating_count) &&
    product.rating_count >= 0
      ? product.rating_count
      : null
  const sold =
    product?.sold != null && Number.isFinite(product.sold) && product.sold >= 0
      ? product.sold
      : null

  const titleUsable = isUsableTitle(title, {
    shop_id: shopId,
    item_id: itemId,
  })
  const imageOk = Boolean(image?.trim())
  const priceOk = price != null && Number.isFinite(price) && price > 0

  if (!titleUsable && !imageOk && !priceOk) return null

  return {
    ok: true,
    platform: 'shopee',
    title: titleUsable ? title : null,
    image_url: imageOk ? image : null,
    price: priceOk ? price : null,
    currency: currency || 'VND',
    category,
    category_path,
    shop_name: shopName,
    shop_id: shopId,
    item_id: itemId,
    description,
    rating,
    rating_count,
    sold,
    source: 'opengraph',
    error: null,
  }
}

function extractHtmlDocumentTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!m?.[1]) return null
  const text = m[1]
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text || null
}

/**
 * Score share-preview HTML — prefer responses that include product price.
 *
 * Shopee intermittently serves full Product JSON-LD (price, rating, shop) to
 * some bot UAs and only bare og:title/image to others (measured 2026-08:
 * same item returned price=168500 via Product LD, later only title+image).
 * Returning the first UA with og:title would skip a later UA that has price.
 */
export function scoreShopeeSharePreviewHtml(html: string): number {
  if (!html) return 0
  let score = 0
  if (/property=["']og:title["']/i.test(html) || /name=["']twitter:title["']/i.test(html)) {
    score += 10
  }
  if (/property=["']og:image["']/i.test(html) || /name=["']twitter:image["']/i.test(html)) {
    score += 10
  }
  // Strong signals for retail price
  if (/product:price:amount/i.test(html) || /og:price:amount/i.test(html)) {
    score += 100
  }
  if (
    /@type["']?\s*:\s*["']Product["']/i.test(html) ||
    /"@type"\s*:\s*"Product"/i.test(html)
  ) {
    score += 40
  }
  if (/"price"\s*:\s*"?\d/i.test(html) || /"lowPrice"\s*:\s*"?\d/i.test(html)) {
    score += 80
  }
  if (/aggregateRating/i.test(html)) score += 15
  if (/"offers"\s*:/i.test(html)) score += 20
  return score
}

function isAcceptableSharePreviewHtml(html: string): boolean {
  if (
    /property=["']og:title["']/i.test(html) ||
    /property=["']og:image["']/i.test(html) ||
    /name=["']twitter:title["']/i.test(html)
  ) {
    return true
  }
  const title = extractHtmlDocumentTitle(html)
  return Boolean(
    title &&
      !/something is missing/i.test(title) &&
      !/^Shopee$/i.test(title.trim()) &&
      !isShopeeChallengeTitle(title),
  )
}

/**
 * Fetch product share-preview HTML using link-preview bot UAs.
 * Tries all bot UAs and returns the richest HTML (price-bearing preferred).
 * Prefer Electron net when available; fall back to global fetch.
 */
export async function fetchShopeeSharePreviewHtml(
  productUrl: string,
  timeoutMs = 12_000,
): Promise<string | null> {
  let best: { html: string; score: number } | null = null
  // Per-UA budget so trying several bots stays within timeoutMs
  const perUaMs = Math.max(
    2_500,
    Math.floor(timeoutMs / Math.max(1, SHOPEE_SHARE_PREVIEW_USER_AGENTS.length)),
  )

  for (const userAgent of SHOPEE_SHARE_PREVIEW_USER_AGENTS) {
    const html = await fetchHtmlWithUserAgent(productUrl, userAgent, perUaMs)
    if (!html || !isAcceptableSharePreviewHtml(html)) continue
    const score = scoreShopeeSharePreviewHtml(html)
    if (!best || score > best.score) {
      best = { html, score }
    }
    // Perfect hit — Product LD / price amount present; no need for more UAs
    if (score >= 100) break
  }
  return best?.html ?? null
}

async function fetchHtmlWithUserAgent(
  url: string,
  userAgent: string,
  timeoutMs: number,
): Promise<string | null> {
  const headers: Record<string, string> = {
    'User-Agent': userAgent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  }

  const controller =
    typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller
    ? setTimeout(() => {
        try {
          controller.abort()
        } catch {
          // ignore
        }
      }, timeoutMs)
    : null

  try {
    let response: Response
    try {
      const { net } = await import('electron')
      response = await net.fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers,
        signal: controller?.signal,
      } as RequestInit)
    } catch {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers,
        signal: controller?.signal,
      })
    }
    if (!response.ok) return null
    const contentType = response.headers.get('content-type') ?? ''
    if (
      contentType &&
      !contentType.includes('text') &&
      !contentType.includes('html') &&
      !contentType.includes('xml')
    ) {
      return null
    }
    return await response.text()
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * One share-preview pass: product URL → optional SEO slug hop for price.
 */
async function scrapeProductViaSharePreviewOnce(
  shopId: string,
  itemId: string,
  timeoutMs: number,
): Promise<ScrapeResult | null> {
  const productUrl = buildShopeeProductPageUrl(shopId, itemId)
  const html = await fetchShopeeSharePreviewHtml(productUrl, timeoutMs)
  if (!html) return null
  let mapped = mapShopeeSharePreviewHtml(html, shopId, itemId)
  if (!mapped) return null

  // Second hop: SEO slug from og:url when price is still missing.
  // Some items only expose Product JSON-LD (with price) on the slug form,
  // or only intermittently.
  if (mapped.price == null) {
    const ogUrl = extractOgUrl(html)
    if (
      ogUrl &&
      ogUrl !== productUrl &&
      ogUrl.includes(shopId) &&
      ogUrl.includes(itemId)
    ) {
      const html2 = await fetchShopeeSharePreviewHtml(
        ogUrl.split('?')[0] || ogUrl,
        Math.min(timeoutMs, 10_000),
      )
      if (html2) {
        const mapped2 = mapShopeeSharePreviewHtml(html2, shopId, itemId)
        if (mapped2) {
          mapped = mergeScrapeFields(mapped, mapped2)
        }
      }
    }
  }

  return gateScrapeResult(mapped)
}

/**
 * Tier: share-preview Open Graph / JSON-LD for a product (no login required).
 * Loads /product/SHOP/ITEM with bot UAs — never the user's affiliate shortlink.
 *
 * Retries when price is missing: Shopee intermittently omits product:price /
 * JSON-LD Offer on bot responses (measured 2026-08: same item sometimes
 * returns price, sometimes only title+image).
 */
export async function scrapeProductViaSharePreview(
  shopId: string,
  itemId: string,
  timeoutMs = 12_000,
): Promise<ScrapeResult | null> {
  try {
    let best: ScrapeResult | null = null
    const attempts = 1 + SHARE_PREVIEW_PRICE_RETRIES
    for (let i = 0; i < attempts; i++) {
      if (i > 0) {
        await new Promise((r) => setTimeout(r, SHARE_PREVIEW_RETRY_DELAY_MS))
      }
      const mapped = await scrapeProductViaSharePreviewOnce(
        shopId,
        itemId,
        // Slightly shorter budget on retries so total stays bounded
        i === 0 ? timeoutMs : Math.min(timeoutMs, 8_000),
      )
      if (!mapped) continue
      best = best ? mergeScrapeFields(best, mapped) : mapped
      if (best.price != null && Number.isFinite(best.price) && best.price > 0) {
        return gateScrapeResult(best)
      }
    }
    return best ? gateScrapeResult(best) : null
  } catch (err) {
    logWarn('[ezaff] Shopee share-preview scrape failed:', err)
    return null
  }
}

/** Extract og:url (content before or after property). */
function extractOgUrl(html: string): string | null {
  const patterns = [
    /property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
    /content=["']([^"']+)["'][^>]+property=["']og:url["']/i,
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m?.[1]?.trim()) return m[1].trim()
  }
  return null
}

/**
 * Authenticated product-page DOM tier (Phase 12): only when signed in.
 *
 * Run when:
 * - PDP API returned anti-bot, OR
 * - we still lack price after API/OG (Shopee often strips price from OG now)
 *
 * Never when signed out (anonymous deep-link loads bounce to verify/traffic).
 */
export function shouldAttemptAuthenticatedProductPageTier(opts: {
  signedIn: boolean
  antiBot: boolean
  /** True when title/image may exist but price is still null. */
  priceMissing?: boolean
}): boolean {
  if (!opts.signedIn) return false
  return Boolean(opts.antiBot || opts.priceMissing)
}

/**
 * Build a product PDP URL for the authenticated DOM tier.
 * Uses /product/SHOP/ITEM — never forges headers or stealth.
 */
export function buildShopeeProductPageUrl(
  shopId: string,
  itemId: string,
): string {
  return `https://shopee.vn/product/${encodeURIComponent(shopId)}/${encodeURIComponent(itemId)}`
}

/**
 * A title is usable only when it is a real human-readable name — not a bare
 * id, pure number, or too-short placeholder.
 *
 * Rejects:
 *   - empty / whitespace
 *   - length &lt; 3
 *   - purely numeric (e.g. item id "26175826603")
 *   - equal to shop_id or item_id
 */
export function isUsableTitle(
  title: string | null | undefined,
  opts?: { shop_id?: string | null; item_id?: string | null },
): boolean {
  if (title == null) return false
  const t = title.trim()
  if (t.length < 3) return false
  if (/^\d+$/.test(t)) return false
  const shop = opts?.shop_id?.trim()
  const item = opts?.item_id?.trim()
  if (shop && t === shop) return false
  if (item && t === item) return false
  // Generic placeholders are not product names
  if (t === 'Sản phẩm Shopee' || t === 'Link Shopee') return false
  // Captcha / traffic challenge pages must never win over real OG titles
  if (isShopeeChallengeTitle(t)) return false
  return true
}

/**
 * Success / partial requires usable title OR image OR price.
 * Never claim success when only junk titles remain.
 */
export function hasUsableScrapeContent(
  result: Pick<
    ScrapeResult,
    'title' | 'image_url' | 'price' | 'shop_id' | 'item_id'
  >,
): boolean {
  const titleOk = isUsableTitle(result.title, {
    shop_id: result.shop_id,
    item_id: result.item_id,
  })
  const imageOk = Boolean(result.image_url?.trim())
  const priceOk =
    result.price != null && Number.isFinite(result.price) && result.price > 0
  return titleOk || imageOk || priceOk
}

/**
 * Derive scrape_status from a gated ScrapeResult.
 * - done: title + image + price all present
 * - partial: some but not all of title/image/price
 * - error: nothing usable
 */
export function deriveScrapeStatus(
  result: ScrapeResult,
): 'done' | 'partial' | 'error' {
  if (!result.ok || !hasUsableScrapeContent(result)) return 'error'
  const missing = missingProductFields(result, isUsableTitle)
  if (missing.length === 0) return 'done'
  return 'partial'
}

/** Title + image + price AND a shop name — safe to skip further tiers. */
export function isProductCardReady(result: ScrapeResult): boolean {
  return (
    deriveScrapeStatus(result) === 'done' && Boolean(result.shop_name?.trim())
  )
}

function shopNameFromUnknown(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (!value || typeof value !== 'object') return null
  const rec = value as Record<string, unknown>
  for (const key of ['name', 'shop_name', 'shopname']) {
    const v = rec[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

/** Shop display name from a get_pc / item payload. Username is not used. */
export function pickShopNameFromPdp(
  root: Record<string, unknown>,
  item: Record<string, unknown>,
): string | null {
  return (
    shopNameFromUnknown(item.shop_name) ??
    shopNameFromUnknown(item.shop) ??
    shopNameFromUnknown(item.shop_info) ??
    shopNameFromUnknown(root.shop) ??
    shopNameFromUnknown(root.shop_detailed) ??
    shopNameFromUnknown(root.shop_info) ??
    shopNameFromUnknown(item.seller_name)
  )
}

/**
 * Vietnamese scrape_error for partial results (e.g. "Thiếu ảnh").
 */
export function derivePartialErrorMessage(result: ScrapeResult): string {
  const missing = missingProductFields(result, isUsableTitle)
  return partialMissingLabel(missing)
}

/**
 * Gate a would-be-success result: demote junk-only payloads to error with
 * the Vietnamese manual-entry message. Clears junk titles so they are not
 * persisted as product names. Keeps every usable field (partial OK).
 */
export function gateScrapeResult(result: ScrapeResult): ScrapeResult {
  if (!result.ok) {
    // Even on failure, keep any usable partial fields that slipped in
    const cleanedTitle = isUsableTitle(result.title, {
      shop_id: result.shop_id,
      item_id: result.item_id,
    })
      ? result.title
      : null
    const imageOk = Boolean(result.image_url?.trim())
    const priceOk =
      result.price != null && Number.isFinite(result.price) && result.price > 0
    if (cleanedTitle || imageOk || priceOk) {
      return {
        ...result,
        ok: true,
        title: cleanedTitle,
        image_url: imageOk ? result.image_url : null,
        price: priceOk ? result.price : null,
        error: null,
      }
    }
    return result
  }

  const titleOk = isUsableTitle(result.title, {
    shop_id: result.shop_id,
    item_id: result.item_id,
  })
  const imageOk = Boolean(result.image_url?.trim())
  const priceOk =
    result.price != null && Number.isFinite(result.price) && result.price > 0

  if (!titleOk && !imageOk && !priceOk) {
    return {
      ...emptyScrapeResult(result.platform, MANUAL_ENTRY_ERROR_VI),
      shop_id: result.shop_id,
      item_id: result.item_id,
      source: result.source,
    }
  }

  return {
    ...result,
    title: titleOk ? result.title : null,
    image_url: imageOk ? result.image_url : null,
    price: priceOk ? result.price : null,
    error: null,
  }
}

/**
 * Merge partial scrape fields — later non-null values win.
 * Used when combining API / DOM / slug tiers.
 */
export function mergeScrapeFields(
  base: ScrapeResult,
  extra: Partial<ScrapeResult> | null | undefined,
): ScrapeResult {
  if (!extra) return base
  const title: string | null =
    isUsableTitle(extra.title, {
      shop_id: extra.shop_id ?? base.shop_id,
      item_id: extra.item_id ?? base.item_id,
    })
      ? (extra.title as string)
      : isUsableTitle(base.title, {
            shop_id: base.shop_id,
            item_id: base.item_id,
          })
        ? base.title
        : null
  const image_url: string | null = extra.image_url?.trim()
    ? extra.image_url
    : (base.image_url ?? null)
  const price: number | null =
    extra.price != null && Number.isFinite(extra.price)
      ? extra.price
      : (base.price ?? null)
  const rating: number | null =
    extra.rating != null && Number.isFinite(extra.rating)
      ? extra.rating
      : (base.rating ?? null)
  const rating_count: number | null =
    extra.rating_count != null && Number.isFinite(extra.rating_count)
      ? extra.rating_count
      : (base.rating_count ?? null)
  const sold: number | null =
    extra.sold != null && Number.isFinite(extra.sold)
      ? extra.sold
      : (base.sold ?? null)
  const merged: ScrapeResult = {
    ...base,
    ...extra,
    title,
    image_url,
    price,
    rating,
    rating_count,
    sold,
    shop_id: extra.shop_id ?? base.shop_id,
    item_id: extra.item_id ?? base.item_id,
    platform: extra.platform || base.platform,
    currency: extra.currency || base.currency || 'VND',
    category: extra.category ?? base.category,
    category_path: extra.category_path ?? base.category_path,
    shop_name: extra.shop_name ?? base.shop_name,
    description: extra.description ?? base.description,
    source: extra.source ?? base.source,
    error: null,
    ok: false,
  }
  merged.ok = hasUsableScrapeContent(merged)
  return merged
}

/**
 * Map a parsed PDP get_pc JSON body into ScrapeResult, or null on failure.
 * Validates payload strictly (fact D). Phase 12: keep every field obtained
 * (title-only / image-only / price-only → partial success).
 */
export function mapShopeePdpResponse(
  data: Record<string, unknown>,
  shopId: string,
  itemId: string,
): ScrapeResult | null {
  if (!isUsableShopeeApiPayload(data)) return null
  if (hasShopeeApiError(data)) return null

  const root = (data.data ?? data) as Record<string, unknown>
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null

  // Empty items array is a soft-block failure (fact D)
  if (Array.isArray(root.items) && root.items.length === 0) return null

  const item = (root.item ??
    root.item_rich ??
    root) as Record<string, unknown>
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null

  const rawName =
    (typeof item.title === 'string' && item.title) ||
    (typeof item.name === 'string' && item.name) ||
    null

  const name = rawName?.trim() || null
  const image =
    toImageUrl(
      (typeof item.image === 'string' && item.image) ||
        (Array.isArray(item.images) &&
          typeof item.images[0] === 'string' &&
          item.images[0]) ||
        null,
    ) ?? null

  const price = pickPriceFromItem(item)

  const titleUsable = isUsableTitle(name, {
    shop_id: shopId,
    item_id: itemId,
  })

  // Need at least one usable field (title / image / price)
  if (!titleUsable && !image && price == null) {
    return null
  }

  const shopName = pickShopNameFromPdp(root, item)

  // Shopee returns the whole chain; keep every level for classification and
  // pick a readable leaf (skipping filter facets) for the chip.
  let categoryNames: string[] = []
  if (Array.isArray(item.categories)) {
    categoryNames = (item.categories as Array<Record<string, unknown>>)
      .map((c) =>
        typeof c?.display_name === 'string'
          ? c.display_name
          : typeof c?.name === 'string'
            ? c.name
            : '',
      )
      .filter((n): n is string => n.length > 0)
  } else if (typeof item.category === 'string') {
    categoryNames = [item.category]
  }

  const productName = titleUsable ? name : null
  const category = pickUsefulCategory(categoryNames, productName)
  const category_path = buildCategoryPath(
    categoryNames.filter(
      (n) =>
        !productName ||
        n.trim().toLowerCase() !== productName.trim().toLowerCase(),
    ),
  )

  return {
    ok: true,
    platform: 'shopee',
    title: titleUsable ? name : null,
    image_url: image,
    price,
    currency: 'VND',
    category,
    category_path,
    shop_name: shopName,
    shop_id: shopId,
    item_id: itemId,
    description: typeof item.description === 'string' ? item.description : null,
    source: 'api',
    error: null,
  }
}

/**
 * Walk a category_tree payload and find display name + image for catId.
 */
export function findCategoryInTree(
  node: unknown,
  catId: string,
): { name: string; image: string | null } | null {
  if (!node) return null

  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findCategoryInTree(child, catId)
      if (hit) return hit
    }
    return null
  }

  if (typeof node !== 'object') return null
  const obj = node as Record<string, unknown>

  const idRaw = obj.catid ?? obj.cat_id ?? obj.category_id ?? obj.id
  const idStr = idRaw != null ? String(idRaw) : null
  if (idStr === catId) {
    const name =
      (typeof obj.display_name === 'string' && obj.display_name.trim()) ||
      (typeof obj.name === 'string' && obj.name.trim()) ||
      null
    if (name) {
      const image =
        toImageUrl(
          (typeof obj.image === 'string' && obj.image) ||
            (typeof obj.image_url === 'string' && obj.image_url) ||
            null,
        ) ?? null
      return { name, image }
    }
  }

  // Recurse common nest keys
  for (const key of [
    'children',
    'child',
    'category_list',
    'categories',
    'sub_categories',
    'nodes',
  ]) {
    if (obj[key]) {
      const hit = findCategoryInTree(obj[key], catId)
      if (hit) return hit
    }
  }

  return null
}

/**
 * Map category-tree API response + target catId into ScrapeResult.
 */
export function mapShopeeCategoryResponse(
  data: Record<string, unknown>,
  catId: string,
  fallbackTitle: string,
): ScrapeResult | null {
  if (!isUsableShopeeApiPayload(data)) return null

  const root = (data.data ?? data) as Record<string, unknown>
  if (!root || typeof root !== 'object') return null

  const list =
    root.category_list ??
    root.categories ??
    (Array.isArray(root) ? root : null)

  // Empty category_list = soft-block failure
  if (Array.isArray(list) && list.length === 0) return null

  const found =
    findCategoryInTree(list ?? root, catId) ?? findCategoryInTree(root, catId)

  const name = found?.name ?? null
  const title = name ? `Danh mục: ${name}` : fallbackTitle
  // Mark as category so UI can distinguish from a product
  const categoryLabel = name ? name : 'Danh mục Shopee'

  // Success if we have any usable title (API name or URL slug fallback)
  if (!title.trim()) return null

  return {
    ok: true,
    platform: 'shopee',
    title,
    image_url: found?.image ?? null,
    price: null,
    currency: 'VND',
    category: categoryLabel,
    shop_name: null,
    shop_id: null,
    item_id: null,
    description: name
      ? `Liên kết danh mục Shopee (cat ${catId}): ${name}`
      : `Liên kết danh mục Shopee (cat ${catId})`,
    source: 'api',
    error: null,
  }
}

/**
 * Map shop base / shop info API response into ScrapeResult.
 */
export function mapShopeeShopResponse(
  data: Record<string, unknown>,
  shopId: string | null,
  fallbackTitle: string,
): ScrapeResult | null {
  if (!isUsableShopeeApiPayload(data)) return null

  const root = (data.data ?? data) as Record<string, unknown>
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null

  const shop = (root.shop ?? root.account ?? root) as Record<string, unknown>
  if (!shop || typeof shop !== 'object') return null

  const account =
    shop.account && typeof shop.account === 'object'
      ? (shop.account as Record<string, unknown>)
      : null

  const name =
    (typeof shop.name === 'string' && shop.name.trim()) ||
    (typeof shop.shop_name === 'string' && shop.shop_name.trim()) ||
    (account && typeof account.username === 'string' && account.username.trim()) ||
    (typeof root.name === 'string' && root.name.trim()) ||
    null

  const image =
    toImageUrl(
      (typeof shop.portrait === 'string' && shop.portrait) ||
        (typeof shop.image === 'string' && shop.image) ||
        (account && typeof account.portrait === 'string' && account.portrait) ||
        null,
    ) ?? null

  const resolvedShopId =
    shopId ||
    (shop.shopid != null
      ? String(shop.shopid)
      : shop.shop_id != null
        ? String(shop.shop_id)
        : null)

  const title = name ? `Gian hàng: ${name}` : fallbackTitle
  if (!title.trim()) return null

  return {
    ok: true,
    platform: 'shopee',
    title,
    image_url: image,
    price: null,
    currency: 'VND',
    category: 'Gian hàng Shopee',
    shop_name: name,
    shop_id: resolvedShopId,
    item_id: null,
    description: name
      ? `Liên kết gian hàng Shopee: ${name}`
      : 'Liên kết gian hàng Shopee',
    source: 'api',
    error: null,
  }
}

type DomScrapePayload = {
  title: string | null
  image: string | null
  price: number | null
  /** True when price came from visible ₫ text (whole VND), not API micro-units. */
  priceFromDomText?: boolean | null
  description: string | null
  shop_name: string | null
  html: string | null
  href: string | null
}

async function getPageHref(webContents: Electron.WebContents): Promise<string> {
  try {
    const href: unknown = await webContents.executeJavaScript(
      'String(location.href || "")',
      true,
    )
    return typeof href === 'string' ? href : ''
  } catch {
    return ''
  }
}

/**
 * In-page same-origin fetch helper.
 * Returns parsed JSON or a marker object with __http_status / error.
 */
async function inPageFetchJson(
  webContents: Electron.WebContents,
  pathAndQuery: string,
): Promise<Record<string, unknown> | null> {
  const script = `
    (async () => {
      try {
        const res = await fetch(
          ${JSON.stringify(pathAndQuery)},
          {
            method: 'GET',
            credentials: 'include',
            headers: {
              'x-api-source': 'pc',
              'Accept': 'application/json, text/plain, */*',
            },
          },
        );
        if (!res.ok) {
          return { __http_status: res.status, error: res.status };
        }
        const body = await res.json();
        if (body && typeof body === 'object') {
          body.__http_status = res.status;
        }
        return body;
      } catch (e) {
        return { error: -1, error_msg: String(e && e.message ? e.message : e) };
      }
    })()
  `

  try {
    const raw: unknown = await webContents.executeJavaScript(script, true)
    if (!raw || typeof raw !== 'object') return null
    return raw as Record<string, unknown>
  } catch (err) {
    logWarn('[ezaff] Shopee in-page fetch failed:', err)
    return null
  }
}

/** Outcome of a product PDP in-page lookup (maps anti-bot separately). */
export type ProductApiAttempt = {
  result: ScrapeResult | null
  /** True when Shopee returned anti-bot error 90309999 (or equivalent). */
  antiBot: boolean
}

/**
 * Tier 1 product — in-page same-origin fetch of /api/v4/pdp/get_pc.
 *
 * WHY in-page (not net.fetch / plain HTTP from the main process):
 * Live probes against shopee.vn showed GET .../api/v4/pdp/get_pc from a
 * plain HTTP client with full browser headers always returns HTTP 403
 * Forbidden. The identical path, run via executeJavaScript inside a page
 * already loaded on the shopee.vn origin (credentials: 'include', header
 * x-api-source: pc), returns HTTP 200 with a real JSON body.
 *
 * Window MUST use SHOPEE_SESSION_PARTITION so an optional user sign-in
 * (Phase 11) is visible to this fetch via credentials: 'include'.
 */
async function scrapeProductViaInPageApi(
  webContents: Electron.WebContents,
  shopId: string,
  itemId: string,
): Promise<ProductApiAttempt> {
  const data = await inPageFetchJson(
    webContents,
    `/api/v4/pdp/get_pc?shop_id=${encodeURIComponent(shopId)}&item_id=${encodeURIComponent(itemId)}`,
  )
  if (!data) return { result: null, antiBot: false }
  if (isShopeeAntiBotError(data)) {
    return { result: null, antiBot: true }
  }
  return {
    result: mapShopeePdpResponse(data, shopId, itemId),
    antiBot: false,
  }
}

/**
 * Build the Vietnamese product-failure result after an anti-bot or empty lookup.
 * Probes signed-in status only when anti-bot was observed (lightweight).
 */
export async function productLookupFailureResult(opts: {
  antiBot: boolean
  shopId?: string | null
  itemId?: string | null
  source?: string | null
  /** Inject for tests — skips real partition probe. */
  signedIn?: boolean
}): Promise<ScrapeResult> {
  let signedIn = opts.signedIn
  if (signedIn === undefined && opts.antiBot) {
    try {
      signedIn = await probeShopeeSignedIn()
    } catch {
      signedIn = false
    }
  }
  const message = messageForProductLookupFailure({
    antiBot: opts.antiBot,
    signedIn: Boolean(signedIn),
    fallback: MANUAL_ENTRY_ERROR_VI,
  })
  return {
    ...emptyScrapeResult('shopee', message),
    shop_id: opts.shopId ?? null,
    item_id: opts.itemId ?? null,
    source: opts.source ?? null,
  }
}

async function scrapeCategoryViaInPageApi(
  webContents: Electron.WebContents,
  catId: string,
  fallbackTitle: string,
): Promise<ScrapeResult | null> {
  // Verified live: /api/v4/pages/get_category_tree returns real category_list
  const data = await inPageFetchJson(
    webContents,
    '/api/v4/pages/get_category_tree',
  )
  if (!data) return null
  return mapShopeeCategoryResponse(data, catId, fallbackTitle)
}

async function scrapeShopViaInPageApi(
  webContents: Electron.WebContents,
  shopId: string | null,
  fallbackTitle: string,
): Promise<ScrapeResult | null> {
  if (!shopId) return null
  // Prefer get_shop_base; fall back to get_shop_info style path
  const paths = [
    `/api/v4/shop/get_shop_base?shopid=${encodeURIComponent(shopId)}`,
    `/api/v4/product/get_shop_info?shopid=${encodeURIComponent(shopId)}`,
  ]
  for (const path of paths) {
    const data = await inPageFetchJson(webContents, path)
    if (!data) continue
    const mapped = mapShopeeShopResponse(data, shopId, fallbackTitle)
    if (mapped?.ok) return mapped
  }
  return null
}

/**
 * Optional DOM pass — only useful if the page somehow already has product
 * fields; with homepage-only load this usually returns null.
 */
async function scrapeViaDomFromPage(
  webContents: Electron.WebContents,
  ids: { shop_id: string; item_id: string } | null,
): Promise<ScrapeResult | null> {
  const script = `
    (() => {
      const out = {
        title: null,
        image: null,
        price: null,
        priceFromDomText: false,
        description: null,
        shop_name: null,
        html: null,
        href: String(location.href || ''),
      };

      function str(v) {
        return typeof v === 'string' && v.trim() ? v.trim() : null;
      }

      function firstImage(v) {
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (Array.isArray(v)) {
          for (const x of v) {
            const f = firstImage(x);
            if (f) return f;
          }
        }
        if (v && typeof v === 'object' && typeof v.url === 'string') return v.url;
        return null;
      }

      function walkState(node, depth) {
        if (!node || depth > 8) return;
        if (Array.isArray(node)) {
          for (const x of node) walkState(x, depth + 1);
          return;
        }
        if (typeof node !== 'object') return;

        const title =
          str(node.title) || str(node.name) || str(node.item_name);
        const image =
          firstImage(node.image) ||
          firstImage(node.images) ||
          firstImage(node.image_url);
        const priceRaw =
          node.price_min ?? node.price ?? node.price_max ??
          node.price_before_discount ?? null;

        if (title && !out.title) out.title = title;
        if (image && !out.image) out.image = image;
        if (priceRaw != null && out.price == null) {
          const n = typeof priceRaw === 'number'
            ? priceRaw
            : parseInt(String(priceRaw).replace(/[^\\d]/g, ''), 10);
          // Keep raw numeric (micro or VND); TS side normalizes with auto unit
          if (Number.isFinite(n) && n > 0) out.price = n;
        }
        // models[] may hold the only non-zero price
        if (out.price == null && Array.isArray(node.models)) {
          for (const m of node.models) {
            if (!m || typeof m !== 'object') continue;
            const pr = m.price_min ?? m.price ?? m.price_max ?? null;
            if (pr == null) continue;
            const n = typeof pr === 'number'
              ? pr
              : parseInt(String(pr).replace(/[^\\d]/g, ''), 10);
            if (Number.isFinite(n) && n > 0) { out.price = n; break; }
          }
        }
        if (str(node.shop_name) && !out.shop_name) out.shop_name = str(node.shop_name);
        if (node.shop && typeof node.shop === 'object' && str(node.shop.name) && !out.shop_name) {
          out.shop_name = str(node.shop.name);
        }
        if (str(node.description) && !out.description) out.description = str(node.description);

        if (node.item) walkState(node.item, depth + 1);
        if (node.product) walkState(node.product, depth + 1);
        if (node.data) walkState(node.data, depth + 1);
        if (node.INITIAL_STATE) walkState(node.INITIAL_STATE, depth + 1);
      }

      try {
        if (window.__INITIAL_STATE__) walkState(window.__INITIAL_STATE__, 0);
      } catch (_) {}
      try {
        if (window.__NEXT_DATA__) walkState(window.__NEXT_DATA__, 0);
      } catch (_) {}

      try {
        const h1 = document.querySelector('h1');
        if (h1 && str(h1.textContent) && !out.title) out.title = str(h1.textContent);

        const nameEl =
          document.querySelector('[class*="product-briefing"] h1') ||
          document.querySelector('[data-sqe="name"]') ||
          document.querySelector('div[class*="WBVL_7"]') ||
          document.querySelector('div[class*="product-name"]');
        if (nameEl && str(nameEl.textContent) && !out.title) {
          out.title = str(nameEl.textContent);
        }

        const imgEl =
          document.querySelector('img[class*="product"]') ||
          document.querySelector('[class*="image-carousel"] img') ||
          document.querySelector('picture img') ||
          document.querySelector('img[src*="susercontent.com"]');
        if (imgEl) {
          const src = imgEl.getAttribute('src') || imgEl.getAttribute('data-src');
          if (str(src) && !out.image) out.image = str(src);
        }

        if (out.price == null) {
          const priceSelectors = [
            '[data-sqe="price"]',
            '.pqTWkA',
            '[class*="product-price"]',
            '[class*="ProductPrice"]',
            'div[class*="price"] span',
            'section[class*="product"] [class*="price"]',
          ];
          for (const sel of priceSelectors) {
            const priceEl = document.querySelector(sel);
            if (!priceEl) continue;
            const text = String(priceEl.textContent || '').trim();
            // "₫168.500" / "168.500" / "168500đ" — strip currency, keep digits
            const digits = text.replace(/[^\\d]/g, '');
            if (digits.length >= 3 && digits.length <= 12) {
              const n = parseInt(digits, 10);
              if (Number.isFinite(n) && n > 0) {
                out.price = n;
                out.priceFromDomText = true;
                break;
              }
            }
          }
        }
      } catch (_) {}

      try {
        const ogTitle = document.querySelector('meta[property="og:title"]');
        const ogImage = document.querySelector('meta[property="og:image"]');
        const ogDesc = document.querySelector('meta[property="og:description"]');
        if (ogTitle && str(ogTitle.getAttribute('content')) && !out.title) {
          out.title = str(ogTitle.getAttribute('content'));
        }
        if (ogImage && str(ogImage.getAttribute('content')) && !out.image) {
          out.image = str(ogImage.getAttribute('content'));
        }
        if (ogDesc && str(ogDesc.getAttribute('content')) && !out.description) {
          out.description = str(ogDesc.getAttribute('content'));
        }
      } catch (_) {}

      try {
        out.html = document.documentElement.outerHTML;
      } catch (_) {
        out.html = null;
      }

      return out;
    })()
  `

  try {
    const raw: unknown = await webContents.executeJavaScript(script, true)
    if (!raw || typeof raw !== 'object') return null
    const payload = raw as DomScrapePayload

    // Homepage / verify page DOM is not product data
    if (payload.href && isTrafficVerifyUrl(payload.href)) {
      return null
    }
    if (payload.href) {
      try {
        const u = new URL(payload.href)
        if (u.pathname === '/' || u.pathname === '') return null
      } catch {
        // continue
      }
    }

    let title = payload.title
    let image = payload.image ? toImageUrl(payload.image) : null
    let price: number | null = null
    let description = payload.description
    let shopName = payload.shop_name
    let category: string | null = null

    if (payload.price != null && Number.isFinite(payload.price)) {
      // DOM ₫ text is whole VND; INITIAL_STATE / API fields are micro-units.
      price = normalizeShopeePriceValue(
        payload.price,
        payload.priceFromDomText ? 'display' : 'auto',
      )
    }

    if (payload.html && (!title || !image || price === null)) {
      const og = extractOpenGraph(payload.html)
      const products = extractJsonLdProducts(payload.html)
      const product = products[0]
      title = title ?? og.title ?? product?.name ?? null
      image = image ?? og.image ?? product?.image ?? null
      if (price === null) {
        price = parsePriceAmount(og.priceAmount) ?? product?.price ?? null
      }
      description = description ?? og.description ?? product?.description ?? null
      shopName = shopName ?? product?.brand ?? null
      category = product?.category ?? null
    }

    const shopId = ids?.shop_id ?? null
    const itemId = ids?.item_id ?? null
    const titleUsable = isUsableTitle(title, {
      shop_id: shopId,
      item_id: itemId,
    })
    const cleanTitle = titleUsable ? title : null
    const priceOk = price != null && Number.isFinite(price) && price > 0

    if (!cleanTitle && !image && !priceOk) {
      return null
    }

    return {
      ok: true,
      platform: 'shopee',
      title: cleanTitle,
      image_url: image,
      price: priceOk ? price : null,
      currency: 'VND',
      category,
      shop_name: shopName,
      shop_id: shopId,
      item_id: itemId,
      description,
      source: 'browser',
      error: null,
    }
  } catch (err) {
    logWarn('[ezaff] Shopee DOM scrape failed:', err)
    return null
  }
}

/**
 * Load a product URL in a hidden window on the authenticated partition and
 * scrape DOM + window.__INITIAL_STATE__. Phase 12: only when signed in.
 * This is the user's own browser session viewing a page they may open — not evasion.
 */
async function scrapeProductPageAuthenticated(
  productUrl: string,
  ids: { shop_id: string; item_id: string },
  remainingMs: number,
): Promise<ScrapeResult | null> {
  let BrowserWindow: typeof import('electron').BrowserWindow
  try {
    ;({ BrowserWindow } = await import('electron'))
  } catch {
    return null
  }

  const budget = Math.max(3_000, Math.min(remainingMs, 20_000))
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: shopeePartitionWebPreferences({
      offscreen: true,
    }),
  })

  try {
    win.webContents.setUserAgent(BROWSER_USER_AGENT)

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Hết thời gian chờ trang sản phẩm'))
      }, budget)

      const cleanup = (): void => {
        clearTimeout(timer)
        win.webContents.removeListener('did-finish-load', onLoad)
        win.webContents.removeListener('did-fail-load', onFail)
      }

      const onLoad = (): void => {
        cleanup()
        // SPA hydrate — allow price nodes / XHR to settle
        setTimeout(() => resolve(), 2_800)
      }

      const onFail = (
        _e: Electron.Event,
        code: number,
        desc: string,
      ): void => {
        cleanup()
        reject(new Error(`Tải trang sản phẩm thất bại (${code}): ${desc}`))
      }

      win.webContents.once('did-finish-load', onLoad)
      win.webContents.once('did-fail-load', onFail)

      void win.loadURL(productUrl, {
        userAgent: BROWSER_USER_AGENT,
        httpReferrer: SHOPEE_HOMEPAGE,
      })
    })

    const href = await getPageHref(win.webContents)
    if (isTrafficVerifyUrl(href)) {
      return null
    }

    // Prefer same-origin get_pc from the product-page context (has full
    // document cookies / referrer). Homepage in-page fetch is often anti-bot
    // while this path still works when the PDP shell loaded.
    let apiMapped: ScrapeResult | null = null
    try {
      const attempt = await scrapeProductViaInPageApi(
        win.webContents,
        ids.shop_id,
        ids.item_id,
      )
      if (attempt.result?.ok) {
        apiMapped = gateScrapeResult({
          ...attempt.result,
          shop_id: ids.shop_id,
          item_id: ids.item_id,
          source: 'auth_dom',
        })
        if (apiMapped.ok && isProductCardReady(apiMapped)) {
          return apiMapped
        }
      }
    } catch {
      // fall through to DOM
    }

    const dom = await scrapeViaDomFromPage(win.webContents, ids)
    if (!dom && !apiMapped) return null
    const merged = dom
      ? apiMapped
        ? mergeScrapeFields(apiMapped, {
            ...dom,
            source: 'auth_dom',
          })
        : gateScrapeResult({
            ...dom,
            shop_id: dom.shop_id ?? ids.shop_id,
            item_id: dom.item_id ?? ids.item_id,
            source: 'auth_dom',
          })
      : apiMapped
    if (!merged) return null
    return gateScrapeResult({
      ...merged,
      shop_id: merged.shop_id ?? ids.shop_id,
      item_id: merged.item_id ?? ids.item_id,
      source: 'auth_dom',
    })
  } catch (err) {
    logWarn('[ezaff] Authenticated product page scrape failed:', err)
    return null
  } finally {
    if (!win.isDestroyed()) {
      win.destroy()
    }
  }
}

/**
 * Open a VISIBLE product page on the authenticated partition so the user
 * can view and copy name/image without leaving the app (Phase 12 Part 3).
 */
export async function openShopeeProductPage(
  productUrl: string,
): Promise<{ opened: boolean; message: string }> {
  const trimmed = productUrl?.trim()
  if (!trimmed) {
    return { opened: false, message: 'Thiếu link sản phẩm' }
  }
  try {
    void new URL(trimmed)
  } catch {
    return { opened: false, message: 'Link sản phẩm không hợp lệ' }
  }

  let BrowserWindow: typeof import('electron').BrowserWindow
  try {
    ;({ BrowserWindow } = await import('electron'))
  } catch (err) {
    return {
      opened: false,
      message: err instanceof Error ? err.message : String(err),
    }
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    show: true,
    title: 'Trang sản phẩm Shopee — ezaff',
    autoHideMenuBar: true,
    webPreferences: shopeePartitionWebPreferences({}),
  })

  win.setMenuBarVisibility(false)
  try {
    win.webContents.setUserAgent(BROWSER_USER_AGENT)
  } catch {
    // ignore
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  void win.loadURL(trimmed, {
    userAgent: BROWSER_USER_AGENT,
    httpReferrer: SHOPEE_HOMEPAGE,
  })

  return { opened: true, message: 'Đã mở trang sản phẩm' }
}

async function loadShopeeHomepage(
  win: Electron.BrowserWindow,
  remainingMs: number,
): Promise<void> {
  const budget = Math.max(3_000, Math.min(remainingMs, 25_000))
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Hết thời gian chờ trang Shopee'))
    }, budget)

    const cleanup = (): void => {
      clearTimeout(timer)
      win.webContents.removeListener('did-finish-load', onLoad)
      win.webContents.removeListener('did-fail-load', onFail)
    }

    const onLoad = (): void => {
      cleanup()
      // Brief settle for SPA hydration / anti-bot cookies
      setTimeout(() => resolve(), 1_200)
    }

    const onFail = (
      _e: Electron.Event,
      code: number,
      desc: string,
    ): void => {
      cleanup()
      reject(new Error(`Tải trang thất bại (${code}): ${desc}`))
    }

    win.webContents.once('did-finish-load', onLoad)
    win.webContents.once('did-fail-load', onFail)

    // FACT B: never load deep product/category URLs — only the homepage.
    void win.loadURL(SHOPEE_HOMEPAGE, {
      userAgent: BROWSER_USER_AGENT,
      httpReferrer: SHOPEE_HOMEPAGE,
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Open one offscreen window on the Shopee homepage, then run in-page API
 * lookups. Never navigates to product/category deep links (fact B).
 *
 * MUST use SHOPEE_SESSION_PARTITION so optional user login benefits scrapes.
 */
async function scrapeWithHomepageWindow(
  finalUrl: string,
  kind: ShopeeLinkKind,
  ids: { shop_id: string; item_id: string } | null,
  categoryId: string | null,
  shopIdOnly: string | null,
): Promise<ScrapeResult | null> {
  let BrowserWindow: typeof import('electron').BrowserWindow
  try {
    ;({ BrowserWindow } = await import('electron'))
  } catch {
    return null
  }

  const started = Date.now()
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: shopeePartitionWebPreferences({
      offscreen: true,
    }),
  })

  const fallbackTitle = titleFromShopeeUrlSlug(finalUrl, kind)

  try {
    win.webContents.setUserAgent(BROWSER_USER_AGENT)

    const remainingForLoad = TOTAL_TIMEOUT_MS - (Date.now() - started)
    if (remainingForLoad < 2_000) return null
    await loadShopeeHomepage(win, remainingForLoad)

    let href = await getPageHref(win.webContents)
    let onVerify = isTrafficVerifyUrl(href)

    // One retry after a short delay — not a tight loop (requirement 3)
    if (onVerify) {
      const remaining = TOTAL_TIMEOUT_MS - (Date.now() - started)
      if (remaining > VERIFY_RETRY_DELAY_MS + 3_000) {
        await sleep(VERIFY_RETRY_DELAY_MS)
        await loadShopeeHomepage(
          win,
          TOTAL_TIMEOUT_MS - (Date.now() - started),
        )
        href = await getPageHref(win.webContents)
        onVerify = isTrafficVerifyUrl(href)
      }
    }

    // Even on verify page, same-origin APIs may still work (fact C).
    // Try API once; if it fails while on verify, surface the verify message.
    const remainingForApi = TOTAL_TIMEOUT_MS - (Date.now() - started)
    if (remainingForApi < 1_000) {
      if (onVerify) {
        return emptyScrapeResult('shopee', TRAFFIC_VERIFY_ERROR_VI)
      }
      return null
    }

    let apiResult: ScrapeResult | null = null
    let productAntiBot = false

    if (kind === 'product' && ids) {
      const attempt = await scrapeProductViaInPageApi(
        win.webContents,
        ids.shop_id,
        ids.item_id,
      )
      apiResult = attempt.result
      productAntiBot = attempt.antiBot
    } else if (kind === 'category' && categoryId) {
      apiResult = await scrapeCategoryViaInPageApi(
        win.webContents,
        categoryId,
        fallbackTitle,
      )
    } else if (kind === 'shop') {
      apiResult = await scrapeShopViaInPageApi(
        win.webContents,
        shopIdOnly,
        fallbackTitle,
      )
    }

    let accumulated: ScrapeResult | null = null

    if (apiResult?.ok) {
      const gated = gateScrapeResult(apiResult)
      if (gated.ok) {
        accumulated = gated
      }
    }

    // Share-preview OG is attempted in shopeeScraper.scrape() (before this window)
    // so anti-bot API failures still get title/image without a second network hit here.

    // Shop base enrichment: get_shop_base often works even when product PDP is
    // anti-bot blocked (measured 2026-08). Fills shop_name for product cards.
    if (kind === 'product' && ids && !accumulated?.shop_name?.trim()) {
      const remainingForShop = TOTAL_TIMEOUT_MS - (Date.now() - started)
      if (remainingForShop > 1_500) {
        const shopHit = await scrapeShopViaInPageApi(
          win.webContents,
          ids.shop_id,
          `Gian hàng #${ids.shop_id}`,
        )
        if (shopHit?.shop_name?.trim()) {
          accumulated = mergeScrapeFields(
            accumulated ?? {
              ...emptyScrapeResult('shopee'),
              ok: true,
              shop_id: ids.shop_id,
              item_id: ids.item_id,
              source: 'api',
              error: null,
            },
            {
              shop_name: shopHit.shop_name,
              // Do not overwrite product image with shop portrait
              shop_id: ids.shop_id,
              source: accumulated?.source ?? 'api',
            },
          )
        }
      }
    }

    if (accumulated && isProductCardReady(accumulated)) {
      return gateScrapeResult(accumulated)
    }

    // Phase 12: signed-in + (anti-bot OR missing price) → product page on same partition
    if (kind === 'product' && ids) {
      const priceMissing =
        accumulated?.price == null ||
        !Number.isFinite(accumulated.price) ||
        accumulated.price <= 0
      if (productAntiBot || priceMissing) {
        let signedIn = false
        try {
          signedIn = await probeShopeeSignedIn()
        } catch {
          signedIn = false
        }

        if (
          shouldAttemptAuthenticatedProductPageTier({
            signedIn,
            antiBot: productAntiBot,
            priceMissing,
          })
        ) {
          const remainingForAuth = TOTAL_TIMEOUT_MS - (Date.now() - started)
          if (remainingForAuth > 4_000) {
            const productUrl =
              finalUrl.includes('/product/') || finalUrl.includes('-i.')
                ? finalUrl.split('?')[0] ||
                  buildShopeeProductPageUrl(ids.shop_id, ids.item_id)
                : buildShopeeProductPageUrl(ids.shop_id, ids.item_id)
            const authDom = await scrapeProductPageAuthenticated(
              productUrl,
              ids,
              remainingForAuth,
            )
            if (authDom?.ok) {
              accumulated = accumulated
                ? mergeScrapeFields(accumulated, authDom)
                : authDom
              const gated = gateScrapeResult(accumulated)
              if (gated.ok && isProductCardReady(gated)) {
                return gated
              }
              if (gated.ok) accumulated = gated
            }
          }
        }
      }
    }

    if (kind === 'product' && ids && !accumulated?.shop_name?.trim()) {
      const leftover = TOTAL_TIMEOUT_MS - (Date.now() - started)
      if (leftover > 1_200) {
        const shopHit = await scrapeShopViaInPageApi(
          win.webContents,
          ids.shop_id,
          `Gian hàng #${ids.shop_id}`,
        )
        if (shopHit?.shop_name?.trim()) {
          accumulated = mergeScrapeFields(
            accumulated ?? {
              ...emptyScrapeResult('shopee'),
              ok: true,
              shop_id: ids.shop_id,
              item_id: ids.item_id,
              source: 'api',
              error: null,
            },
            {
              shop_name: shopHit.shop_name,
              shop_id: ids.shop_id,
              source: accumulated?.source ?? 'api',
            },
          )
        }
      }
    }

    if (onVerify && !accumulated?.ok) {
      // Still attach human slug title when available for partial UX
      if (kind === 'product' && ids) {
        const slugTitle = readableProductTitleFromShopeeSlug(finalUrl)
        if (slugTitle) {
          return gateScrapeResult({
            ok: true,
            platform: 'shopee',
            title: slugTitle,
            image_url: null,
            price: null,
            currency: 'VND',
            category: null,
            shop_name: null,
            shop_id: ids.shop_id,
            item_id: ids.item_id,
            description: null,
            source: 'url_slug',
            error: null,
          })
        }
      }
      return emptyScrapeResult('shopee', TRAFFIC_VERIFY_ERROR_VI)
    }

    // Optional DOM pass on homepage (usually empty)
    if (kind === 'product' && ids) {
      const remainingForDom = TOTAL_TIMEOUT_MS - (Date.now() - started)
      if (remainingForDom > 500) {
        const browserResult = await scrapeViaDomFromPage(win.webContents, ids)
        if (browserResult?.ok) {
          accumulated = accumulated
            ? mergeScrapeFields(accumulated, browserResult)
            : {
                ...browserResult,
                shop_id: browserResult.shop_id ?? ids.shop_id,
                item_id: browserResult.item_id ?? ids.item_id,
              }
        }
      }

      // Slug-derived title when human-readable (never bare numeric id)
      const slugTitle = readableProductTitleFromShopeeSlug(finalUrl)
      if (slugTitle) {
        accumulated = mergeScrapeFields(
          accumulated ?? {
            ...emptyScrapeResult('shopee'),
            ok: true,
            shop_id: ids.shop_id,
            item_id: ids.item_id,
            source: 'url_slug',
            error: null,
          },
          {
            title: slugTitle,
            source: accumulated?.source ?? 'url_slug',
          },
        )
      }

      if (accumulated) {
        const gated = gateScrapeResult({
          ...accumulated,
          shop_id: accumulated.shop_id ?? ids.shop_id,
          item_id: accumulated.item_id ?? ids.item_id,
        })
        if (gated.ok) return gated
      }

      return productLookupFailureResult({
        antiBot: productAntiBot,
        shopId: ids.shop_id,
        itemId: ids.item_id,
        source: 'api',
      })
    }

    // Soft success: non-product kinds get a readable slug title so the
    // library is never left with an empty title (requirement 5).
    // Still gate junk titles (pure numeric / bare id) — never fake "done".
    if (kind === 'category' || kind === 'shop' || kind === 'search') {
      const base = accumulated ?? {
        ok: true,
        platform: 'shopee' as const,
        title: fallbackTitle,
        image_url: null,
        price: null,
        currency: 'VND',
        category:
          kind === 'category'
            ? 'Danh mục Shopee'
            : kind === 'shop'
              ? 'Gian hàng Shopee'
              : 'Tìm kiếm Shopee',
        shop_name: null,
        shop_id: shopIdOnly,
        item_id: null,
        description: null,
        source: 'url_slug',
        error: null,
      }
      if (!accumulated) {
        return gateScrapeResult(base)
      }
      return gateScrapeResult(
        mergeScrapeFields(base, {
          title: fallbackTitle,
          source: accumulated.source ?? 'url_slug',
        }),
      )
    }

    return null
  } catch (err) {
    logWarn('[ezaff] Shopee homepage scrape failed:', err)
    return null
  } finally {
    if (!win.isDestroyed()) {
      win.destroy()
    }
  }
}

async function resolveFinalUrl(url: string): Promise<string> {
  // Shortlinks and non-identity URLs need redirect resolution (fact A:
  // s.shopee.vn → category page). Product URLs with IDs can stay as-is.
  if (
    !isShopeeShortlink(url) &&
    (extractShopeeIds(url) ||
      extractShopeeCategoryId(url) ||
      extractShopeeShopId(url))
  ) {
    return url
  }
  try {
    const { followRedirectsWithElectronNet } = await import('./urlNormalizer')
    return await followRedirectsWithElectronNet(url)
  } catch {
    return url
  }
}

export const shopeeScraper: Scraper = {
  name: 'shopee',

  match(url: string): boolean {
    return shopeeHostsMatch(url)
  },

  async scrape(url: string): Promise<ScrapeResult> {
    try {
      const finalUrl = await resolveFinalUrl(url)
      const kind = classifyShopeeLink(finalUrl)
      const ids = extractShopeeIds(finalUrl) ?? extractShopeeIds(url)
      const categoryId =
        extractShopeeCategoryId(finalUrl) ?? extractShopeeCategoryId(url)
      const shopIdOnly =
        ids?.shop_id ??
        extractShopeeShopId(finalUrl) ??
        extractShopeeShopId(url)

      const effectiveKind: ShopeeLinkKind =
        ids != null ? 'product' : kind === 'unknown' && categoryId
          ? 'category'
          : kind

      // Fast path for products: share-preview OG / JSON-LD (no login, ~1–3s).
      // When Shopee anti-bots get_pc, this still returns title + image + often price.
      let sharePreview: ScrapeResult | null = null
      if (effectiveKind === 'product' && ids) {
        try {
          sharePreview = await scrapeProductViaSharePreview(
            ids.shop_id,
            ids.item_id,
            12_000,
          )
        } catch {
          sharePreview = null
        }
        // Full card (title+image+price) AND shop_name → skip heavy browser tier.
        // If shop_name missing, still open homepage to hit get_shop_base (works
        // even when product PDP API is anti-bot blocked).
        const gatedOg = sharePreview ? gateScrapeResult(sharePreview) : null
        if (
          gatedOg?.ok &&
          deriveScrapeStatus(gatedOg) === 'done' &&
          Boolean(gatedOg.shop_name?.trim())
        ) {
          return {
            ...gatedOg,
            shop_id: ids.shop_id,
            item_id: ids.item_id,
          }
        }
      }

      // Homepage-only window + in-page API (never load deep links — fact B)
      // Also enriches shop_name via get_shop_base when product API is blocked.
      const result = await scrapeWithHomepageWindow(
        finalUrl,
        effectiveKind,
        ids,
        categoryId,
        shopIdOnly,
      )

      // Merge share-preview fields under API/DOM when either side is partial
      let merged: ScrapeResult | null = result
      if (sharePreview?.ok) {
        merged = result
          ? mergeScrapeFields(sharePreview, result)
          : sharePreview
        // If API/DOM contributed no usable product fields, keep opengraph as source
        const apiContributed =
          Boolean(result?.ok) &&
          (isUsableTitle(result?.title, {
            shop_id: result?.shop_id,
            item_id: result?.item_id,
          }) ||
            Boolean(result?.image_url?.trim()) ||
            (result?.price != null && result.price > 0))
        if (!apiContributed && merged) {
          merged = { ...merged, source: sharePreview.source ?? 'opengraph' }
        }
      }

      // Last-chance price: Shopee OG price is intermittent — one more
      // share-preview pass after the heavy tier when still missing price.
      if (
        effectiveKind === 'product' &&
        ids &&
        (merged?.price == null ||
          !Number.isFinite(merged.price) ||
          merged.price <= 0)
      ) {
        try {
          const lateOg = await scrapeProductViaSharePreview(
            ids.shop_id,
            ids.item_id,
            8_000,
          )
          if (lateOg?.ok && lateOg.price != null && lateOg.price > 0) {
            merged = merged
              ? mergeScrapeFields(merged, lateOg)
              : lateOg
          }
        } catch {
          // ignore
        }
      }

      if (merged) {
        // Gate success: junk title without image must not become "done"
        const gated = gateScrapeResult(merged)
        if (gated.ok) {
          return {
            ...gated,
            shop_id: gated.shop_id ?? ids?.shop_id ?? shopIdOnly,
            item_id: gated.item_id ?? ids?.item_id ?? null,
          }
        }
        // Distinct verify failure already has TRAFFIC_VERIFY_ERROR_VI
        if (gated.error === TRAFFIC_VERIFY_ERROR_VI && !sharePreview?.ok) {
          return gated
        }
        // Product with unusable content → manual-entry error (never soft-success)
        if (effectiveKind === 'product') {
          return {
            ...emptyScrapeResult(
              'shopee',
              gated.error ?? merged.error ?? MANUAL_ENTRY_ERROR_VI,
            ),
            shop_id: ids?.shop_id ?? shopIdOnly,
            item_id: ids?.item_id ?? null,
            source: merged.source ?? sharePreview?.source ?? null,
          }
        }
      }

      // Non-product: slug title soft success only when the title is usable
      if (effectiveKind !== 'product') {
        const fallback = titleFromShopeeUrlSlug(finalUrl, effectiveKind)
        return gateScrapeResult({
          ok: true,
          platform: 'shopee',
          title: fallback,
          image_url: null,
          price: null,
          currency: 'VND',
          category:
            effectiveKind === 'category'
              ? 'Danh mục Shopee'
              : effectiveKind === 'shop'
                ? 'Gian hàng Shopee'
                : null,
          shop_name: null,
          shop_id: shopIdOnly,
          item_id: null,
          description: null,
          source: 'url_slug',
          error: null,
        })
      }

      return emptyScrapeResult(
        'shopee',
        merged?.error ?? result?.error ?? MANUAL_ENTRY_ERROR_VI,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return emptyScrapeResult('shopee', message)
    }
  },
}
