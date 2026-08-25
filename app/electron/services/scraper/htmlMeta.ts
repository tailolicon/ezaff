/**
 * Lightweight HTML meta / JSON-LD extractors (no cheerio dependency).
 */

export type OpenGraphFields = {
  title: string | null
  image: string | null
  description: string | null
  priceAmount: string | null
  priceCurrency: string | null
  siteName: string | null
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) =>
      String.fromCodePoint(Number.parseInt(n, 10)),
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) =>
      String.fromCodePoint(Number.parseInt(h, 16)),
    )
}

function metaContent(html: string, propertyOrName: string): string | null {
  const prop = propertyOrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // property="..." content="..."  OR  content="..." property="..."
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      'i',
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["'][^>]*>`,
      'i',
    ),
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m?.[1]) {
      return decodeHtmlEntities(m[1].trim())
    }
  }
  return null
}

export function extractOpenGraph(html: string): OpenGraphFields {
  return {
    title:
      metaContent(html, 'og:title') ??
      metaContent(html, 'twitter:title') ??
      null,
    image:
      metaContent(html, 'og:image') ??
      metaContent(html, 'og:image:secure_url') ??
      metaContent(html, 'twitter:image') ??
      null,
    description:
      metaContent(html, 'og:description') ??
      metaContent(html, 'description') ??
      null,
    priceAmount:
      metaContent(html, 'product:price:amount') ??
      metaContent(html, 'og:price:amount') ??
      null,
    priceCurrency:
      metaContent(html, 'product:price:currency') ??
      metaContent(html, 'og:price:currency') ??
      null,
    siteName: metaContent(html, 'og:site_name'),
  }
}

export type JsonLdProduct = {
  name: string | null
  image: string | null
  description: string | null
  price: number | null
  currency: string | null
  brand: string | null
  category: string | null
  /** Product aggregate rating value (0–5). */
  rating: number | null
  /** Number of ratings/reviews. */
  rating_count: number | null
  /** Units sold when present in structured data. */
  sold: number | null
}

function firstImage(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstImage(item)
      if (found) return found
    }
  }
  if (value && typeof value === 'object' && 'url' in value) {
    const url = (value as { url?: unknown }).url
    if (typeof url === 'string' && url.trim()) return url.trim()
  }
  return null
}

/**
 * Parse a price string/number into whole VND (or major currency units).
 *
 * Handles:
 *   - numbers: 168500
 *   - JSON-LD decimals: "168500.00" → 168500  (NOT 16850000)
 *   - VN thousand dots: "168.500" → 168500
 *   - mixed: "168.500,50" / "1,234.56"
 */
function parsePrice(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value)
  }
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw) return null

  // Plain integer
  if (/^\d+$/.test(raw)) {
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  // JSON-LD / ISO style with decimal point only: "168500.00", "99.5"
  // Must run BEFORE stripping dots, or "168500.00" becomes 16850000.
  if (/^\d+\.\d{1,2}$/.test(raw)) {
    const n = Number.parseFloat(raw)
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null
  }

  // Vietnamese thousand separators: 168.500 or 1.234.567
  if (/^\d{1,3}(\.\d{3})+$/.test(raw)) {
    const n = Number.parseInt(raw.replace(/\./g, ''), 10)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  // European: 168.500,50 or 168500,50
  if (/^\d{1,3}(\.\d{3})*,\d{1,2}$/.test(raw) || /^\d+,\d{1,2}$/.test(raw)) {
    const n = Number.parseFloat(raw.replace(/\./g, '').replace(',', '.'))
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null
  }

  // US thousands: 1,234.56
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw)) {
    const n = Number.parseFloat(raw.replace(/,/g, ''))
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null
  }

  // Fallback: strip currency symbols, keep last comma/dot as decimal if short fraction
  const stripped = raw.replace(/[^\d.,]/g, '')
  if (!stripped) return null
  if (/^\d+\.\d{1,2}$/.test(stripped)) {
    const n = Number.parseFloat(stripped)
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null
  }
  const digits = stripped.replace(/[^\d]/g, '')
  if (!digits) return null
  const n = Number.parseInt(digits, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

function asProductNode(node: unknown): JsonLdProduct | null {
  if (!node || typeof node !== 'object') return null
  const obj = node as Record<string, unknown>
  const type = obj['@type']
  const types = Array.isArray(type)
    ? type.map(String)
    : type
      ? [String(type)]
      : []
  const isProduct = types.some(
    (t) => t.toLowerCase() === 'product' || t.endsWith('/Product'),
  )
  if (!isProduct) return null

  let price: number | null = null
  let currency: string | null = null
  let sellerName: string | null = null
  const offers = obj.offers
  if (offers && typeof offers === 'object') {
    const offerList = Array.isArray(offers) ? offers : [offers]
    for (const offer of offerList) {
      if (!offer || typeof offer !== 'object') continue
      const o = offer as Record<string, unknown>
      if (price === null) {
        price = parsePrice(o.price ?? o.lowPrice ?? o.highPrice)
      }
      if (typeof o.priceCurrency === 'string' && !currency) {
        currency = o.priceCurrency
      }
      // Shopee Product JSON-LD: offers.seller.Organization.name
      if (!sellerName && o.seller && typeof o.seller === 'object') {
        const seller = o.seller as Record<string, unknown>
        if (typeof seller.name === 'string' && seller.name.trim()) {
          sellerName = seller.name.trim()
        }
      }
      if (price !== null && currency && sellerName) break
    }
  }

  let brand: string | null = null
  if (typeof obj.brand === 'string' && obj.brand.trim()) {
    brand = obj.brand.trim()
  } else if (obj.brand && typeof obj.brand === 'object') {
    const b = obj.brand as { name?: unknown }
    if (typeof b.name === 'string' && b.name.trim()) brand = b.name.trim()
  }
  // Prefer brand; fall back to offer seller (Shopee puts shop here)
  if (!brand && sellerName) brand = sellerName

  // Product-level aggregateRating (not seller's)
  let rating: number | null = null
  let rating_count: number | null = null
  const agg = obj.aggregateRating
  if (agg && typeof agg === 'object' && !Array.isArray(agg)) {
    const a = agg as Record<string, unknown>
    if (typeof a.ratingValue === 'number' && Number.isFinite(a.ratingValue)) {
      rating = Math.round(a.ratingValue * 100) / 100
    } else if (typeof a.ratingValue === 'string' && a.ratingValue.trim()) {
      const n = Number.parseFloat(a.ratingValue)
      if (Number.isFinite(n)) rating = Math.round(n * 100) / 100
    }
    if (typeof a.ratingCount === 'number' && Number.isFinite(a.ratingCount)) {
      rating_count = Math.round(a.ratingCount)
    } else if (typeof a.ratingCount === 'string' && a.ratingCount.trim()) {
      const n = Number.parseInt(a.ratingCount.replace(/[^\d]/g, ''), 10)
      if (Number.isFinite(n)) rating_count = n
    } else if (
      typeof a.reviewCount === 'number' &&
      Number.isFinite(a.reviewCount)
    ) {
      rating_count = Math.round(a.reviewCount)
    } else if (typeof a.reviewCount === 'string' && a.reviewCount.trim()) {
      const n = Number.parseInt(a.reviewCount.replace(/[^\d]/g, ''), 10)
      if (Number.isFinite(n)) rating_count = n
    }
  }

  // Sold is rarely in JSON-LD; accept a few common keys if present
  let sold: number | null = null
  for (const key of ['sold', 'sales', 'totalSold', 'orderCount', 'purchaseCount']) {
    const v = obj[key]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      sold = Math.round(v)
      break
    }
    if (typeof v === 'string' && v.trim()) {
      const n = Number.parseInt(v.replace(/[^\d]/g, ''), 10)
      if (Number.isFinite(n) && n >= 0) {
        sold = n
        break
      }
    }
  }

  return {
    name: typeof obj.name === 'string' ? obj.name.trim() : null,
    image: firstImage(obj.image),
    description:
      typeof obj.description === 'string' ? obj.description.trim() : null,
    price,
    currency,
    brand,
    category: typeof obj.category === 'string' ? obj.category.trim() : null,
    rating,
    rating_count,
    sold,
  }
}

function walkJsonLd(node: unknown, out: JsonLdProduct[]): void {
  if (!node) return
  if (Array.isArray(node)) {
    for (const item of node) walkJsonLd(item, out)
    return
  }
  if (typeof node !== 'object') return
  const product = asProductNode(node)
  if (product) out.push(product)
  const obj = node as Record<string, unknown>
  if (obj['@graph']) walkJsonLd(obj['@graph'], out)
}

/** Extract Product nodes from application/ld+json script tags. */
export function extractJsonLdProducts(html: string): JsonLdProduct[] {
  const products: JsonLdProduct[] = []
  const re =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) {
    const raw = match[1]?.trim()
    if (!raw) continue
    try {
      const parsed: unknown = JSON.parse(raw)
      walkJsonLd(parsed, products)
    } catch {
      // ignore malformed JSON-LD
    }
  }
  return products
}

export function parsePriceAmount(raw: string | null): number | null {
  if (!raw) return null
  return parsePrice(raw)
}
