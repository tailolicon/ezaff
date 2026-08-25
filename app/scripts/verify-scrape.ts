/**
 * End-to-end scrape verification harness (Electron main process).
 *
 * Uses the same pipeline as products:create IPC:
 *   normalizeUrl (redirect + classify + canonical_key) → scrapeUrl
 *
 * Usage (via npm):
 *   npm run verify:scrape -- <url> [url...]
 *
 * Exit codes:
 *   0 — pipeline finished for every URL (graceful scrape failure counts as OK)
 *   1 — uncaught throw / invalid args
 *   2 — hard overall timeout (hang guard)
 */

import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  getScraperForUrl,
  normalizeUrl,
  scrapeUrl,
  scrapeStatusLabel,
  getShopeeAuthStatus,
  deriveScrapeStatus,
  gateScrapeResult,
  type ScrapeResult,
  type NormalizedUrl,
  type ShopeeAuthStatus,
} from '../electron/services/scraper'

/** Stable + timestamped report paths so CI can always find the latest run. */
const REPORT_PATH = join(process.cwd(), 'out', 'verify-scrape-report.log')
const REPORT_PATH_STAMPED = join(
  process.cwd(),
  'out',
  `verify-scrape-report-${Date.now()}.log`,
)

function appendReport(line: string): void {
  try {
    appendFileSync(REPORT_PATH, line + '\n', 'utf8')
    appendFileSync(REPORT_PATH_STAMPED, line + '\n', 'utf8')
  } catch {
    // ignore disk errors — console is primary
  }
}

function log(line = ''): void {
  console.log(line)
  appendReport(line)
}

function logError(line: string): void {
  console.error(line)
  appendReport(line)
}

/** Hard cap for the whole harness run — never hang CI. */
const OVERALL_TIMEOUT_MS = 180_000

/** Per-URL soft budget (informational; scraper has its own 30s cap). */
const PER_URL_SOFT_MS = 45_000

type UrlReport = {
  input_url: string
  resolved_url: string | null
  link_kind: string | null
  canonical_key: string | null
  platform: string | null
  scraper: string | null
  tier: string | null
  title: string | null
  price: number | null
  image_url: string | null
  shop_name: string | null
  category: string | null
  rating: number | null
  rating_count: number | null
  sold: number | null
  scrape_status: string
  scrape_status_label: string
  error: string | null
  duration_ms: number
  normalize_error: string | null
  threw: boolean
}

function parseUrls(argv: string[]): string[] {
  // Prefer tokens after a bare `--` (runner always inserts one so Electron
  // does not treat multiple https:// args as navigation targets).
  const dd = argv.indexOf('--')
  const slice = dd >= 0 ? argv.slice(dd + 1) : argv

  const out: string[] = []
  for (const raw of slice) {
    const a = raw.trim()
    if (!a || a === '--') continue
    if (a.startsWith('-')) continue
    // Skip the script path itself if it appears in argv
    if (a.endsWith('verify-scrape.js') || a.endsWith('verify-scrape.cjs')) {
      continue
    }
    if (a.endsWith('.js') || a.endsWith('.cjs') || a.endsWith('.ts')) continue
    out.push(a)
  }
  return out
}

function formatField(label: string, value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return `  ${label}: (null)`
  }
  return `  ${label}: ${String(value)}`
}

function printReport(report: UrlReport, index: number, total: number): void {
  const bar = '─'.repeat(60)
  log(`\n${bar}`)
  log(`URL ${index + 1}/${total}`)
  log(bar)
  log(formatField('input_url', report.input_url))
  log(formatField('resolved_url', report.resolved_url))
  log(formatField('link_kind', report.link_kind))
  log(formatField('canonical_key', report.canonical_key))
  log(formatField('platform', report.platform))
  log(formatField('scraper', report.scraper))
  log(formatField('tier (source)', report.tier))
  log(formatField('title', report.title))
  log(formatField('price', report.price))
  log(formatField('image_url', report.image_url))
  log(formatField('shop_name', report.shop_name))
  log(formatField('category', report.category))
  log(formatField('rating', report.rating))
  log(formatField('rating_count', report.rating_count))
  log(formatField('sold', report.sold))
  log(
    formatField(
      'scrape_status',
      `${report.scrape_status} (${report.scrape_status_label})`,
    ),
  )
  log(formatField('error', report.error))
  log(formatField('duration_ms', report.duration_ms))
  if (report.normalize_error) {
    log(formatField('normalize_error', report.normalize_error))
  }
  if (report.threw) {
    log('  threw: true')
  }
}

function scrapeStatusFromResult(result: ScrapeResult): string {
  return deriveScrapeStatus(gateScrapeResult(result))
}

async function verifyOne(inputUrl: string): Promise<UrlReport> {
  const started = Date.now()
  let normalized: NormalizedUrl | null = null
  let normalizeError: string | null = null
  let scrapeTarget = inputUrl
  let scraperName: string | null = null

  try {
    normalized = await normalizeUrl(inputUrl)
    scrapeTarget = normalized.final_url || inputUrl
  } catch (err) {
    normalizeError = err instanceof Error ? err.message : String(err)
  }

  try {
    scraperName = getScraperForUrl(scrapeTarget).name
  } catch {
    scraperName = null
  }

  // Soft per-URL timer: do not kill mid-scrape, only warn after the fact
  const softTimer = setTimeout(() => {
    log(
      `[verify-scrape] soft budget ${PER_URL_SOFT_MS}ms exceeded for: ${inputUrl}`,
    )
  }, PER_URL_SOFT_MS)

  try {
    // Same entry point as productScrape → scrapeUrl (never throws by design,
    // but we still catch to satisfy "exit non-zero only if something threw")
    const result = await scrapeUrl(scrapeTarget)
    clearTimeout(softTimer)

    const status = scrapeStatusFromResult(result)
    return {
      input_url: inputUrl,
      resolved_url: normalized?.final_url ?? null,
      link_kind: normalized?.link_kind ?? null,
      canonical_key: normalized?.canonical_key ?? null,
      platform: normalized?.platform ?? result.platform ?? null,
      scraper: scraperName,
      tier: result.source,
      title: result.title,
      price: result.price,
      image_url: result.image_url,
      shop_name: result.shop_name,
      category: result.category,
      rating: result.rating ?? null,
      rating_count: result.rating_count ?? null,
      sold: result.sold ?? null,
      scrape_status: status,
      scrape_status_label: scrapeStatusLabel(status, result.error),
      error: result.error,
      duration_ms: Date.now() - started,
      normalize_error: normalizeError,
      threw: false,
    }
  } catch (err) {
    clearTimeout(softTimer)
    const message = err instanceof Error ? err.message : String(err)
    return {
      input_url: inputUrl,
      resolved_url: normalized?.final_url ?? null,
      link_kind: normalized?.link_kind ?? null,
      canonical_key: normalized?.canonical_key ?? null,
      platform: normalized?.platform ?? null,
      scraper: scraperName,
      tier: null,
      title: null,
      price: null,
      image_url: null,
      shop_name: null,
      category: null,
      rating: null,
      rating_count: null,
      sold: null,
      scrape_status: 'error',
      scrape_status_label: scrapeStatusLabel('error'),
      error: message,
      duration_ms: Date.now() - started,
      normalize_error: normalizeError,
      threw: true,
    }
  }
}

async function runHarness(urls: string[]): Promise<number> {
  try {
    writeFileSync(REPORT_PATH, '', 'utf8')
    writeFileSync(REPORT_PATH_STAMPED, '', 'utf8')
  } catch {
    // continue without file report
  }
  log(`[verify-scrape] report file: ${REPORT_PATH}`)
  log(`[verify-scrape] stamped report: ${REPORT_PATH_STAMPED}`)
  log('[verify-scrape] Electron ready')
  log(`[verify-scrape] URLs: ${urls.length}`)
  log(`[verify-scrape] overall timeout: ${OVERALL_TIMEOUT_MS}ms`)

  // Phase 11: report Shopee partition auth status (probe — never credentials)
  let authStatus: ShopeeAuthStatus | null = null
  try {
    authStatus = await getShopeeAuthStatus()
    log(
      `[verify-scrape] Shopee session: signedIn=${authStatus.signedIn} — ${authStatus.message}`,
    )
  } catch (err) {
    log(
      `[verify-scrape] Shopee session probe failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const reports: UrlReport[] = []
  let anyThrow = false

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]
    log(`\n[verify-scrape] ▶ (${i + 1}/${urls.length}) ${url}`)
    const report = await verifyOne(url)
    reports.push(report)
    printReport(report, i, urls.length)
    if (report.threw) anyThrow = true
  }

  log(`\n${'═'.repeat(60)}`)
  log('SUMMARY')
  log('═'.repeat(60))
  if (authStatus) {
    log(
      `  Shopee auth probe: signedIn=${authStatus.signedIn} (${authStatus.message})`,
    )
  }
  for (const r of reports) {
    const mark = r.threw ? 'THROW' : r.scrape_status === 'done' ? 'OK  ' : 'FAIL'
    log(
      `  [${mark}] ${r.scrape_status.padEnd(7)} tier=${(r.tier ?? '-').padEnd(12)} ${r.input_url}`,
    )
    if (r.error) log(`         error: ${r.error}`)
  }

  return anyThrow ? 1 : 0
}

// ── bootstrap ──────────────────────────────────────────────────────────────

// Offscreen-friendly; no hardware GPU required for hidden BrowserWindow
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-software-rasterizer')

// Keep process alive while scraper creates/destroys offscreen windows
app.on('window-all-closed', () => {
  /* harness owns lifecycle via app.exit */
})

const urls = parseUrls(process.argv.slice(1))

if (urls.length === 0) {
  logError(
    'Usage: npm run verify:scrape -- <url> [url...]\n' +
      'Example: npm run verify:scrape -- https://s.shopee.vn/xxx https://example.com/',
  )
  // app may not be ready yet — force exit
  process.exitCode = 1
  app.exit(1)
} else {
  const hardTimer = setTimeout(() => {
    logError(
      `\n[verify-scrape] HARD TIMEOUT after ${OVERALL_TIMEOUT_MS}ms — aborting`,
    )
    app.exit(2)
  }, OVERALL_TIMEOUT_MS)
  // Unref so the timer alone cannot keep the process alive past a clean exit
  // (Electron still needs the explicit app.exit on timeout).
  hardTimer.unref?.()

  void app
    .whenReady()
    .then(() => runHarness(urls))
    .then((code) => {
      clearTimeout(hardTimer)
      log(`\n[verify-scrape] exit ${code}`)
      log(`[verify-scrape] full report also at: ${REPORT_PATH}`)
      app.exit(code)
    })
    .catch((err: unknown) => {
      clearTimeout(hardTimer)
      logError(`[verify-scrape] fatal: ${String(err)}`)
      app.exit(1)
    })
}
