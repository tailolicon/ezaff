/**
 * Probe alternate Shopee APIs for product price (session partition).
 *   node scripts/run-probe-price-apis.mjs [shopId] [itemId]
 */
import { app, BrowserWindow } from 'electron'
import {
  convertShopeePdpPrice,
} from '../electron/services/scraper/shopee.scraper'
import {
  getShopeeAuthStatus,
  shopeePartitionWebPreferences,
} from '../electron/services/scraper/shopeeSession'
import { BROWSER_USER_AGENT } from '../electron/services/scraper/urlNormalizer'

const nums = process.argv.filter((a) => /^\d{5,}$/.test(a))
const shopId = nums[0] || '279658061'
const itemId = nums[1] || '43508358436'

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

async function inPage(
  webContents: Electron.WebContents,
  path: string,
): Promise<{
  status: number
  error: unknown
  error_msg: unknown
  keys: string[] | null
  dataKeys: string[] | null
  snippet: string
  json: unknown
  err?: string
}> {
  const script = `
    (async () => {
      try {
        const res = await fetch(${JSON.stringify(path)}, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'x-api-source': 'pc',
            'Accept': 'application/json',
          },
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        return {
          status: res.status,
          error: json && typeof json === 'object' ? json.error : null,
          error_msg: json && typeof json === 'object' ? json.error_msg : null,
          keys: json && typeof json === 'object' ? Object.keys(json).slice(0,20) : null,
          dataKeys: json && json.data && typeof json.data === 'object' && !Array.isArray(json.data)
            ? Object.keys(json.data).slice(0,30) : null,
          snippet: text.slice(0, 350),
          json,
        };
      } catch (e) {
        return { status: -1, err: String(e), error: null, error_msg: null, keys: null, dataKeys: null, snippet: '', json: null };
      }
    })()
  `
  return webContents.executeJavaScript(script, true)
}

function walkPrices(
  node: unknown,
  path = '',
  out: Array<{ path: string; value: number; vndMicro: number | null }> = [],
  depth = 0,
): typeof out {
  if (!node || depth > 8 || out.length > 40) return out
  if (typeof node === 'number' && Number.isFinite(node) && node > 0) {
    if (/price|amount|discount/i.test(path) && !/percent|rate|ratio/i.test(path)) {
      out.push({
        path,
        value: node,
        vndMicro: convertShopeePdpPrice(node),
      })
    }
    return out
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < Math.min(node.length, 8); i++) {
      walkPrices(node[i], `${path}[${i}]`, out, depth + 1)
    }
    return out
  }
  if (typeof node === 'object') {
    for (const k of Object.keys(node as object)) {
      if (k.startsWith('__')) continue
      walkPrices(
        (node as Record<string, unknown>)[k],
        path ? `${path}.${k}` : k,
        out,
        depth + 1,
      )
    }
  }
  return out
}

void app.whenReady().then(async () => {
  const auth = await getShopeeAuthStatus()
  console.log('auth', auth.signedIn, auth.message)
  console.log('target', shopId, itemId)

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: shopeePartitionWebPreferences({ offscreen: true }),
  })

  try {
    win.webContents.setUserAgent(BROWSER_USER_AGENT)
    await win.loadURL('https://shopee.vn/', {
      userAgent: BROWSER_USER_AGENT,
      httpReferrer: 'https://shopee.vn/',
    })
    await new Promise((r) => setTimeout(r, 2500))

    const paths = [
      `/api/v4/pdp/get_pc?shop_id=${shopId}&item_id=${itemId}`,
      `/api/v4/pdp/get_rw?shop_id=${shopId}&item_id=${itemId}`,
      `/api/v4/item/get?itemid=${itemId}&shopid=${shopId}`,
      `/api/v2/item/get?itemid=${itemId}&shopid=${shopId}`,
      `/api/v4/shop/search_items?shopid=${shopId}&limit=20&offset=0&order=desc&by=pop`,
      `/api/v4/shop/get_products_tab_data?shopid=${shopId}&limit=20&offset=0`,
      `/api/v4/recommend/product_detail_page?shopid=${shopId}&itemid=${itemId}&limit=5`,
      `/api/v4/pdp/cart_panel/get?shopid=${shopId}&itemid=${itemId}`,
      `/api/v4/product/get_shop_info?shopid=${shopId}`,
      `/api/v4/shop/get_shop_base?shopid=${shopId}`,
    ]

    for (const p of paths) {
      const r = await inPage(win.webContents, p)
      console.log('\n===', p)
      console.log(
        'status',
        r.status,
        'error',
        r.error,
        'keys',
        r.keys,
        'dataKeys',
        r.dataKeys,
      )
      if (r.error === 90309999 || r.error === '90309999') {
        console.log('ANTI-BOT')
        continue
      }
      if (r.json) {
        const prices = walkPrices(r.json)
        if (prices.length) {
          console.log('PRICE HITS:', JSON.stringify(prices.slice(0, 20), null, 2))
        } else {
          console.log('no price fields; snippet:', r.snippet?.slice(0, 200))
        }
      } else {
        console.log('snippet', r.snippet?.slice(0, 200))
      }
    }

    // Search POST for known product name fragment
    const postR = await win.webContents.executeJavaScript(
      `
      (async () => {
        try {
          const res = await fetch('/api/v4/search/search_items', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'x-api-source': 'pc',
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: JSON.stringify({
              by: 'relevancy',
              keyword: 'chân gà rút xương tê cay bà tuyết',
              limit: 20,
              newest: 0,
              order: 'desc',
              page_type: 'search',
              scenario: 'PAGE_GLOBAL_SEARCH',
              version: 2,
            }),
          });
          const j = await res.json();
          const list = j?.data?.items || [];
          const matches = [];
          for (const row of list) {
            const item = row.item_basic || row.item || row;
            matches.push({
              itemid: item.itemid || item.item_id,
              shopid: item.shopid || item.shop_id,
              name: (item.name || '').slice(0, 80),
              price: item.price,
              price_min: item.price_min,
              price_max: item.price_max,
            });
          }
          return { status: res.status, error: j.error, count: list.length, matches };
        } catch (e) {
          return { err: String(e) };
        }
      })()
      `,
      true,
    )
    console.log('\n=== POST search ===')
    console.log(JSON.stringify(postR, null, 2))

    // shop search_items — find our itemId
    const shopSearch = await inPage(
      win.webContents,
      `/api/v4/shop/search_items?shopid=${shopId}&limit=50&offset=0&order=desc&by=pop`,
    )
    if (shopSearch.json && shopSearch.error !== 90309999) {
      const found: unknown[] = []
      const walk = (n: unknown, d = 0): void => {
        if (!n || d > 6 || found.length > 5) return
        if (Array.isArray(n)) {
          for (const x of n) walk(x, d + 1)
          return
        }
        if (typeof n === 'object') {
          const o = n as Record<string, unknown>
          const iid = o.itemid ?? o.item_id
          if (String(iid) === String(itemId)) {
            found.push({
              itemid: iid,
              name: o.name,
              price: o.price,
              price_min: o.price_min,
              price_max: o.price_max,
            })
          }
          for (const k of Object.keys(o)) walk(o[k], d + 1)
        }
      }
      walk(shopSearch.json)
      console.log('\n=== shop search for item ===', JSON.stringify(found, null, 2))
      const prices = walkPrices(shopSearch.json)
      console.log('shop search price samples', prices.slice(0, 10))
    }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
  app.exit(0)
}).catch((e) => {
  console.error(e)
  app.exit(1)
})
