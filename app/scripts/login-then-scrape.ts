/**
 * Open Shopee login (visible), wait for user, then scrape a product URL.
 *
 * Usage:
 *   npx esbuild scripts/login-then-scrape.ts --bundle --platform=node --format=cjs --external:electron --outfile=out/login-then-scrape.cjs
 *   electron out/login-then-scrape.cjs -- <url>
 *
 * Or via the runner: node scripts/run-login-then-scrape.mjs <url>
 */

import { app } from 'electron'
import {
  getShopeeAuthStatus,
  openShopeeLoginWindow,
  normalizeUrl,
  scrapeUrl,
  deriveScrapeStatus,
  gateScrapeResult,
  scrapeStatusLabel,
} from '../electron/services/scraper'

const DEFAULT_URL = 'https://s.shopee.vn/4AywY2kyot'
const OVERALL_TIMEOUT_MS = 10 * 60_000 // login can take a few minutes

function parseUrl(argv: string[]): string {
  const dd = argv.indexOf('--')
  const slice = dd >= 0 ? argv.slice(dd + 1) : argv
  for (const raw of slice) {
    const a = raw.trim()
    if (!a || a.startsWith('-')) continue
    if (a.endsWith('.js') || a.endsWith('.cjs') || a.endsWith('.ts')) continue
    if (a.startsWith('http')) return a
  }
  return DEFAULT_URL
}

function log(line = ''): void {
  console.log(line)
}

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-software-rasterizer')

app.on('window-all-closed', () => {
  /* harness owns lifecycle */
})

const url = parseUrl(process.argv.slice(1))

const hardTimer = setTimeout(() => {
  log(`[login-then-scrape] HARD TIMEOUT after ${OVERALL_TIMEOUT_MS}ms`)
  app.exit(2)
}, OVERALL_TIMEOUT_MS)
hardTimer.unref?.()

void app
  .whenReady()
  .then(async () => {
    log('[login-then-scrape] Electron ready')
    log(`[login-then-scrape] target URL: ${url}`)

    const before = await getShopeeAuthStatus()
    log(
      `[login-then-scrape] BEFORE login: signedIn=${before.signedIn} — ${before.message}`,
    )

    if (!before.signedIn) {
      log('')
      log('════════════════════════════════════════════════════════════')
      log('  Mở cửa sổ đăng nhập Shopee — hãy đăng nhập trong cửa sổ đó')
      log('  (cửa sổ tự đóng sau khi đăng nhập thành công)')
      log('════════════════════════════════════════════════════════════')
      log('')

      const login = await openShopeeLoginWindow()
      log(
        `[login-then-scrape] login result: signedIn=${login.signedIn} reason=${login.reason} — ${login.message}`,
      )

      if (!login.signedIn) {
        log(
          '[login-then-scrape] Chưa đăng nhập được — vẫn scrape để so sánh (anonymous).',
        )
      }
    } else {
      log('[login-then-scrape] Đã có phiên Shopee — bỏ qua bước login.')
    }

    const after = await getShopeeAuthStatus()
    log(
      `[login-then-scrape] AFTER login: signedIn=${after.signedIn} — ${after.message}`,
    )

    log('')
    log(`[login-then-scrape] ▶ normalize + scrape ${url}`)

    let resolved: string | null = null
    let linkKind: string | null = null
    let canonical: string | null = null
    try {
      const n = await normalizeUrl(url)
      resolved = n.final_url
      linkKind = n.link_kind ?? null
      canonical = n.canonical_key
      log(`  resolved_url: ${resolved}`)
      log(`  link_kind: ${linkKind}`)
      log(`  canonical_key: ${canonical}`)
    } catch (err) {
      log(
        `  normalize error: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const started = Date.now()
    const result = await scrapeUrl(resolved || url)
    const gated = gateScrapeResult(result)
    const status = deriveScrapeStatus(gated)
    const ms = Date.now() - started

    log('')
    log('────────────────────────────────────────────────────────────')
    log('SCRAPE RESULT (after login attempt)')
    log('────────────────────────────────────────────────────────────')
    log(`  signedIn: ${after.signedIn}`)
    log(`  tier (source): ${gated.source}`)
    log(`  title: ${gated.title ?? '(null)'}`)
    log(`  price: ${gated.price ?? '(null)'}`)
    log(`  image_url: ${gated.image_url ?? '(null)'}`)
    log(`  shop_name: ${gated.shop_name ?? '(null)'}`)
    log(`  category: ${gated.category ?? '(null)'}`)
    log(`  shop_id: ${gated.shop_id ?? '(null)'}`)
    log(`  item_id: ${gated.item_id ?? '(null)'}`)
    log(`  description: ${gated.description ? gated.description.slice(0, 120) + '…' : '(null)'}`)
    log(`  scrape_status: ${status} (${scrapeStatusLabel(status, gated.error)})`)
    log(`  error: ${gated.error ?? '(null)'}`)
    log(`  duration_ms: ${ms}`)
    log('')

    if (after.signedIn && gated.price != null) {
      log('✓ Đăng nhập giúp lấy thêm GIÁ.')
    } else if (after.signedIn && gated.price == null) {
      log(
        '△ Đã đăng nhập nhưng vẫn chưa có giá (API/DOM vẫn chặn hoặc thiếu field).',
      )
    } else {
      log('△ Chưa đăng nhập — chỉ có dữ liệu anonymous (thường là OG title+ảnh).')
    }

    clearTimeout(hardTimer)
    app.exit(0)
  })
  .catch((err: unknown) => {
    clearTimeout(hardTimer)
    console.error('[login-then-scrape] fatal:', err)
    app.exit(1)
  })
