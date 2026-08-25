/**
 * Picks a scraper by domain. Shopee gets the deep scraper;
 * every other platform falls through to OpenGraph.
 */

import { openGraphScraper } from './opengraph.scraper'
import { shopeeScraper } from './shopee.scraper'
import type { ScrapeResult, Scraper } from './types'
import { emptyScrapeResult } from './types'
import { detectPlatform } from './urlNormalizer'

const scrapers: Scraper[] = [shopeeScraper]

/** Resolve the scraper for a product URL. */
export function getScraperForUrl(url: string): Scraper {
  for (const scraper of scrapers) {
    if (scraper.match(url)) {
      return scraper
    }
  }
  return openGraphScraper
}

/** List registered specialised scrapers (excludes default OpenGraph). */
export function listScrapers(): readonly Scraper[] {
  return scrapers
}

/**
 * Run the matching scraper. Never throws — returns a failed ScrapeResult
 * so the product can still be saved for manual entry.
 */
export async function scrapeUrl(url: string): Promise<ScrapeResult> {
  try {
    const scraper = getScraperForUrl(url)
    return await scraper.scrape(url)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return emptyScrapeResult(detectPlatform(url), message)
  }
}
