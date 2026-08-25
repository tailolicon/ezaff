/**
 * Load product page with session partition and intercept XHR/fetch for price.
 */
import { app, BrowserWindow, session as electronSession } from 'electron'
import { pickPriceFromItem } from '../electron/services/scraper/shopee.scraper'
import {
  getShopeeAuthStatus,
  shopeePartitionWebPreferences,
  SHOPEE_SESSION_PARTITION as PART,
} from '../electron/services/scraper/shopeeSession'
import { BROWSER_USER_AGENT } from '../electron/services/scraper/urlNormalizer'

const shopId = '279658061'
const itemId = '43508358436'
const productUrl = `https://shopee.vn/product/${shopId}/${itemId}`

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

void app.whenReady().then(async () => {
  const auth = await getShopeeAuthStatus()
  console.log('auth', auth.signedIn, auth.message)

  const hits: Array<Record<string, unknown>> = []
  const ses = electronSession.fromPartition(PART)

  ses.webRequest.onCompleted({ urls: ['*://shopee.vn/*', '*://*.shopee.vn/*'] }, (details) => {
    if (/get_pc|item\/get|pdp|search_items|get_rw/i.test(details.url)) {
      hits.push({
        type: 'completed',
        status: details.statusCode,
        url: details.url.slice(0, 160),
      })
    }
  })

  // Debugger Network domain for response bodies
  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: shopeePartitionWebPreferences({ offscreen: true }),
  })

  try {
    win.webContents.setUserAgent(BROWSER_USER_AGENT)
    const wc = win.webContents
    try {
      wc.debugger.attach('1.3')
    } catch (e) {
      console.log('debugger attach fail', e)
    }

    const bodies: Array<{ url: string; price?: unknown; name?: unknown; error?: unknown }> = []
    wc.debugger.on('message', async (_e, method, params) => {
      if (method === 'Network.responseReceived') {
        const url: string = params.response?.url || ''
        if (!/get_pc|item\/get|pdp|search_items|get_rw|get_item/i.test(url)) return
        try {
          const { body, base64Encoded } = await wc.debugger.sendCommand(
            'Network.getResponseBody',
            { requestId: params.requestId },
          )
          const text = base64Encoded
            ? Buffer.from(body, 'base64').toString('utf8')
            : body
          let j: Record<string, unknown> | null = null
          try {
            j = JSON.parse(text)
          } catch {
            j = null
          }
          const item =
            (j?.data as Record<string, unknown> | undefined)?.item ||
            (j?.data as Record<string, unknown> | undefined)?.item_basic
          const rec: {
            url: string
            price?: unknown
            name?: unknown
            error?: unknown
            price_min?: unknown
            picked?: number | null
          } = {
            url: url.slice(0, 160),
            error: j?.error,
          }
          if (item && typeof item === 'object') {
            const it = item as Record<string, unknown>
            rec.name = it.name || it.title
            rec.price = it.price
            rec.price_min = it.price_min
            rec.picked = pickPriceFromItem(it)
          }
          bodies.push(rec)
        } catch {
          // body not available
        }
      }
    })

    await wc.debugger.sendCommand('Network.enable')

    // Warm home first
    await win.loadURL('https://shopee.vn/', {
      userAgent: BROWSER_USER_AGENT,
      httpReferrer: 'https://shopee.vn/',
    })
    await new Promise((r) => setTimeout(r, 2000))
    console.log('home', await wc.executeJavaScript('location.href', true))

    await win.loadURL(productUrl, {
      userAgent: BROWSER_USER_AGENT,
      httpReferrer: 'https://shopee.vn/',
    })
    await new Promise((r) => setTimeout(r, 8000))
    console.log('product href', await wc.executeJavaScript('location.href', true))

    // DOM price scan
    const dom = await wc.executeJavaScript(
      `
      (() => {
        const texts = [];
        for (const el of document.querySelectorAll('*')) {
          const t = (el.textContent || '').trim();
          if (t && t.length < 40 && /[₫đ]|\\d{1,3}(\\.\\d{3})+/.test(t) && el.children.length === 0) {
            texts.push(t);
          }
        }
        return { title: document.title, texts: [...new Set(texts)].slice(0, 30) };
      })()
      `,
      true,
    )
    console.log('dom', JSON.stringify(dom, null, 2))
    console.log('webRequest hits', JSON.stringify(hits, null, 2))
    console.log('network bodies', JSON.stringify(bodies, null, 2))
  } finally {
    try {
      win.webContents.debugger.detach()
    } catch {
      /* ignore */
    }
    if (!win.isDestroyed()) win.destroy()
  }
  app.exit(0)
}).catch((e) => {
  console.error(e)
  app.exit(1)
})
