/**
 * Probe Shopee product APIs using the persist:shopee session.
 * Inventory fields useful for ezaff product cards / templates.
 *
 *   node scripts/run-probe-shopee-fields.mjs [shopId] [itemId]
 */

import { app, BrowserWindow } from 'electron'
import {
  BROWSER_USER_AGENT,
  convertShopeePdpPrice,
  isShopeeAntiBotError,
  isUsableShopeeApiPayload,
  mapShopeePdpResponse,
  pickPriceFromItem,
  scrapeProductViaSharePreview,
} from '../electron/services/scraper/shopee.scraper'
import {
  getShopeeAuthStatus,
  shopeePartitionWebPreferences,
} from '../electron/services/scraper/shopeeSession'
// BROWSER_USER_AGENT is in urlNormalizer — re-import if not exported from scraper
import { BROWSER_USER_AGENT as UA } from '../electron/services/scraper/urlNormalizer'

const nums = process.argv.filter((a) => /^\d{5,}$/.test(a))
const shopId = nums[0] || '279658061'
const itemId = nums[1] || '43508358436'

function log(s = ''): void {
  console.log(s)
}

function summarizeValue(v: unknown, depth = 0): string {
  if (v == null) return String(v)
  if (typeof v === 'string') {
    const t = v.replace(/\s+/g, ' ').trim()
    return t.length > 90 ? JSON.stringify(t.slice(0, 90) + '…') : JSON.stringify(t)
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    if (depth >= 1) return `[len=${v.length}]`
    return `[len=${v.length}] e.g. ${summarizeValue(v[0], depth + 1)}`
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v as object)
    if (depth >= 1) return `{keys:${keys.length}: ${keys.slice(0, 8).join(',')}}`
    return `{${keys.slice(0, 15).join(',')}${keys.length > 15 ? ',…' : ''}}`
  }
  return typeof v
}

function inventoryItem(item: Record<string, unknown>): void {
  const interesting = [
    'name',
    'title',
    'image',
    'images',
    'price',
    'price_min',
    'price_max',
    'price_before_discount',
    'raw_discount',
    'discount',
    'stock',
    'sold',
    'historical_sold',
    'liked_count',
    'cmt_count',
    'item_rating',
    'shop_location',
    'brand',
    'description',
    'categories',
    'shop_name',
    'shopid',
    'itemid',
    'models',
    'tier_variations',
    'is_official_shop',
    'show_official_shop_label',
    'is_preferred_plus_seller',
    'label_ids',
  ]

  log('  --- interesting item fields ---')
  for (const k of interesting) {
    if (Object.prototype.hasOwnProperty.call(item, k)) {
      log(`  ${k}: ${summarizeValue(item[k])}`)
    }
  }

  log('  --- price conversion ---')
  for (const k of ['price', 'price_min', 'price_max', 'price_before_discount']) {
    if (item[k] != null) {
      log(`  ${k} raw=${item[k]} → VND ${convertShopeePdpPrice(item[k])}`)
    }
  }
  log(`  pickPriceFromItem → ${pickPriceFromItem(item)}`)

  if (item.item_rating && typeof item.item_rating === 'object') {
    log(`  item_rating: ${JSON.stringify(item.item_rating).slice(0, 400)}`)
  }
  if (Array.isArray(item.categories)) {
    log(
      `  categories: ${item.categories
        .map((c) => {
          if (c && typeof c === 'object') {
            const o = c as { display_name?: string; name?: string }
            return o.display_name || o.name || '?'
          }
          return '?'
        })
        .join(' > ')}`,
    )
  }
}

async function inPageFetch(
  win: Electron.BrowserWindow,
  pathAndQuery: string,
): Promise<Record<string, unknown>> {
  return (await win.webContents.executeJavaScript(
    `(async () => {
      try {
        const res = await fetch(${JSON.stringify(pathAndQuery)}, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'x-api-source': 'pc',
            'Accept': 'application/json, text/plain, */*',
          },
        });
        const body = await res.json();
        if (body && typeof body === 'object') body.__http_status = res.status;
        return body;
      } catch (e) {
        return { error: -1, error_msg: String(e && e.message ? e.message : e) };
      }
    })()`,
    true,
  )) as Record<string, unknown>
}

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.on('window-all-closed', () => {})

void app
  .whenReady()
  .then(async () => {
    log(`[probe] shop=${shopId} item=${itemId}`)
    const auth = await getShopeeAuthStatus()
    log(`[probe] session: signedIn=${auth.signedIn} — ${auth.message}`)

    log('\n=== TIER: opengraph share-preview ===')
    const og = await scrapeProductViaSharePreview(shopId, itemId, 12_000)
    if (og) {
      log(`  ok=${og.ok} source=${og.source}`)
      log(`  title=${og.title}`)
      log(`  price=${og.price}`)
      log(`  image=${og.image_url}`)
      log(`  shop_name=${og.shop_name}`)
      log(`  category=${og.category}`)
      log(`  description=${og.description?.slice(0, 120) ?? null}`)
    } else {
      log('  (null)')
    }

    log('\n=== TIER: in-page get_pc (session partition) ===')
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: shopeePartitionWebPreferences({ offscreen: true }),
    })
    try {
      win.webContents.setUserAgent(UA)
      await win.loadURL('https://shopee.vn/', {
        userAgent: UA,
        httpReferrer: 'https://shopee.vn/',
      })
      await new Promise((r) => setTimeout(r, 1500))

      const data = await inPageFetch(
        win,
        `/api/v4/pdp/get_pc?shop_id=${encodeURIComponent(shopId)}&item_id=${encodeURIComponent(itemId)}`,
      )

      log(
        `  status=${data.__http_status} error=${data.error} antiBot=${isShopeeAntiBotError(data)} usable=${isUsableShopeeApiPayload(data)}`,
      )

      if (isUsableShopeeApiPayload(data) && !isShopeeAntiBotError(data)) {
        const root = (data.data ?? data) as Record<string, unknown>
        log(`  root keys: ${Object.keys(root).join(', ')}`)
        const item = (root.item ??
          root.item_rich ??
          root) as Record<string, unknown>
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          inventoryItem(item)
        }
        if (root.shop && typeof root.shop === 'object') {
          log('  --- shop ---')
          const shop = root.shop as Record<string, unknown>
          for (const k of Object.keys(shop).slice(0, 35)) {
            log(`  shop.${k}: ${summarizeValue(shop[k])}`)
          }
        }
        const mapped = mapShopeePdpResponse(data, shopId, itemId)
        log('\n  --- mapShopeePdpResponse ---')
        log(JSON.stringify(mapped, null, 2))
      } else {
        log(`  snippet: ${JSON.stringify(data).slice(0, 500)}`)
      }

      const extra = [
        `/api/v4/product/get_shop_info?shopid=${shopId}`,
        `/api/v4/shop/get_shop_base?shopid=${shopId}`,
        `/api/v4/item/get?itemid=${itemId}&shopid=${shopId}`,
      ]
      for (const p of extra) {
        log(`\n=== EXTRA ${p} ===`)
        const body = await inPageFetch(win, p)
        log(
          `  status=${body.__http_status} error=${body.error} antiBot=${isShopeeAntiBotError(body)} usable=${isUsableShopeeApiPayload(body)}`,
        )
        if (isUsableShopeeApiPayload(body) && !isShopeeAntiBotError(body)) {
          const d = (body.data ?? body) as Record<string, unknown>
          log(`  data keys: ${Object.keys(d).slice(0, 40).join(', ')}`)
          for (const k of [
            'name',
            'shop_name',
            'account',
            'place',
            'username',
            'portrait',
            'item',
            'price',
            'price_min',
            'sold',
            'historical_sold',
            'item_rating',
            'rating_star',
            'response_rate',
            'follower_count',
            'is_official_shop',
            'is_shopee_verified',
            'shop_location',
          ]) {
            if (d[k] != null) log(`  ${k}: ${summarizeValue(d[k])}`)
          }
          // nested account
          if (d.account && typeof d.account === 'object') {
            const acc = d.account as Record<string, unknown>
            for (const k of ['username', 'portrait', 'following_count', 'status']) {
              if (acc[k] != null) log(`  account.${k}: ${summarizeValue(acc[k])}`)
            }
          }
        } else {
          log(`  snippet: ${JSON.stringify(body).slice(0, 280)}`)
        }
      }
    } finally {
      if (!win.isDestroyed()) win.destroy()
    }

    log('\n[probe] done')
    app.exit(0)
  })
  .catch((e) => {
    console.error(e)
    app.exit(1)
  })
