/**
 * Default scraper for non-Shopee marketplaces.
 * Reads og:title / og:image / og:description / product:price:amount / JSON-LD Product.
 * Missing fields stay null so the user can fill them manually.
 */

import {
  extractJsonLdProducts,
  extractOpenGraph,
  parsePriceAmount,
} from './htmlMeta'
import type { ScrapeResult, Scraper } from './types'
import { emptyScrapeResult } from './types'
import { BROWSER_USER_AGENT, detectPlatform } from './urlNormalizer'

async function fetchHtml(url: string): Promise<string | null> {
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_USER_AGENT,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  }

  try {
    let response: Response
    try {
      const { net } = await import('electron')
      response = await net.fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers,
      })
    } catch {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers,
      })
    }
    if (!response.ok) return null
    const contentType = response.headers.get('content-type') ?? ''
    // Avoid trying to parse pure binary responses
    if (
      contentType &&
      !contentType.includes('text') &&
      !contentType.includes('html') &&
      !contentType.includes('xml') &&
      !contentType.includes('json')
    ) {
      return null
    }
    return await response.text()
  } catch {
    return null
  }
}

export const openGraphScraper: Scraper = {
  name: 'opengraph',

  match(_url: string): boolean {
    // Default matcher — registry uses this as fallback for every other platform.
    return true
  },

  async scrape(url: string): Promise<ScrapeResult> {
    const platform = detectPlatform(url)
    try {
      const html = await fetchHtml(url)
      if (!html) {
        return emptyScrapeResult(
          platform,
          'Không tải được trang. Bạn có thể nhập tay tên và ảnh.',
        )
      }

      const og = extractOpenGraph(html)
      const products = extractJsonLdProducts(html)
      const product = products[0]

      const title = og.title ?? product?.name ?? null
      const image = og.image ?? product?.image ?? null
      const description = og.description ?? product?.description ?? null
      const price =
        parsePriceAmount(og.priceAmount) ?? product?.price ?? null
      const currency =
        og.priceCurrency ?? product?.currency ?? 'VND'
      const shopName = product?.brand ?? og.siteName ?? null
      const category = product?.category ?? null

      const ok = Boolean(title || image || price !== null)
      if (!ok) {
        return emptyScrapeResult(
          platform,
          'Không tìm thấy Open Graph / JSON-LD. Bạn có thể nhập tay.',
        )
      }

      return {
        ok: true,
        platform,
        title,
        image_url: image,
        price,
        currency: currency || 'VND',
        category,
        shop_name: shopName,
        shop_id: null,
        item_id: null,
        description,
        rating: product?.rating ?? null,
        rating_count: product?.rating_count ?? null,
        sold: product?.sold ?? null,
        source: 'opengraph',
        error: null,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return emptyScrapeResult(platform, message)
    }
  },
}
