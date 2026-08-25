/**
 * Try getting price via search page / shop page navigation (signed-in session).
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

const shopId = '279658061'
const itemId = '43508358436'
const keyword = 'Combo 20 chân gà rút xương tê cay'

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

void app.whenReady().then(async () => {
  const auth = await getShopeeAuthStatus()
  console.log('auth', auth.signedIn, auth.message)

  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: shopeePartitionWebPreferences({ offscreen: true }),
  })

  try {
    win.webContents.setUserAgent(BROWSER_USER_AGENT)

    // 1) Homepage warm-up
    await win.loadURL('https://shopee.vn/', {
      userAgent: BROWSER_USER_AGENT,
      httpReferrer: 'https://shopee.vn/',
    })
    await new Promise((r) => setTimeout(r, 3000))
    console.log('home href', await win.webContents.executeJavaScript('location.href', true))

    // 2) Search page
    const searchUrl = `https://shopee.vn/search?keyword=${encodeURIComponent(keyword)}`
    await win.loadURL(searchUrl, {
      userAgent: BROWSER_USER_AGENT,
      httpReferrer: 'https://shopee.vn/',
    })
    await new Promise((r) => setTimeout(r, 5000))
    const searchInfo = await win.webContents.executeJavaScript(
      `
      (async () => {
        const out = { href: location.href, cards: [], api: null };
        // DOM cards
        const els = Array.from(document.querySelectorAll('[data-sqe="item"], .shopee-search-item-result__item, a[href*="-i."]'));
        for (const el of els.slice(0, 30)) {
          const a = el.closest('a') || el.querySelector('a') || (el.tagName === 'A' ? el : null);
          const href = a ? a.getAttribute('href') : null;
          const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
          const priceMatch = text.match(/[₫đ]\\s*[\\d.]+|[\\d.]+\\s*₫/);
          out.cards.push({ href, text, priceText: priceMatch ? priceMatch[0] : null });
        }
        // in-page search API
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
              keyword: ${JSON.stringify(keyword)},
              limit: 20,
              newest: 0,
              order: 'desc',
              page_type: 'search',
              scenario: 'PAGE_GLOBAL_SEARCH',
              version: 2,
            }),
          });
          const j = await res.json();
          out.api = {
            status: res.status,
            error: j.error,
            count: (j?.data?.items || []).length,
            items: (j?.data?.items || []).slice(0, 8).map((row) => {
              const item = row.item_basic || row.item || row;
              return {
                itemid: item.itemid || item.item_id,
                shopid: item.shopid || item.shop_id,
                name: (item.name || '').slice(0, 60),
                price: item.price,
                price_min: item.price_min,
                price_max: item.price_max,
              };
            }),
          };
        } catch (e) {
          out.api = { err: String(e) };
        }
        return out;
      })()
      `,
      true,
    )
    console.log('search href', searchInfo.href)
    console.log('search cards sample', JSON.stringify(searchInfo.cards?.slice(0, 5), null, 2))
    console.log('search api', JSON.stringify(searchInfo.api, null, 2))

    // 3) Shop page
    const shopUrl = `https://shopee.vn/shop/${shopId}`
    await win.loadURL(shopUrl, {
      userAgent: BROWSER_USER_AGENT,
      httpReferrer: 'https://shopee.vn/',
    })
    await new Promise((r) => setTimeout(r, 5000))
    const shopInfo = await win.webContents.executeJavaScript(
      `
      (async () => {
        const out = { href: location.href, api: null, prices: [] };
        try {
          const res = await fetch('/api/v4/shop/search_items?shopid=${shopId}&limit=30&offset=0&order=desc&by=pop', {
            credentials: 'include',
            headers: { 'x-api-source': 'pc', 'Accept': 'application/json' },
          });
          const j = await res.json();
          out.api = { status: res.status, error: j.error, keys: j.data ? Object.keys(j.data).slice(0,15) : null };
          const items = j?.data?.items || j?.data?.item || j?.items || [];
          function walk(n, d) {
            if (!n || d > 6 || out.prices.length > 20) return;
            if (Array.isArray(n)) { for (const x of n) walk(x, d+1); return; }
            if (typeof n === 'object') {
              const iid = n.itemid || n.item_id;
              if (iid && (n.price != null || n.price_min != null)) {
                out.prices.push({
                  itemid: iid,
                  name: (n.name||'').slice(0,50),
                  price: n.price,
                  price_min: n.price_min,
                  match: String(iid) === '${itemId}',
                });
              }
              for (const k of Object.keys(n)) walk(n[k], d+1);
            }
          }
          walk(j, 0);
        } catch (e) { out.api = { err: String(e) }; }
        return out;
      })()
      `,
      true,
    )
    console.log('shop href', shopInfo.href)
    console.log('shop api', JSON.stringify(shopInfo.api, null, 2))
    console.log(
      'shop prices match',
      JSON.stringify(
        shopInfo.prices?.filter((p: { match?: boolean }) => p.match),
        null,
        2,
      ),
    )
    console.log('shop prices sample', JSON.stringify(shopInfo.prices?.slice(0, 5), null, 2))

    // 4) After warm-up, retry get_pc
    const pdp = await win.webContents.executeJavaScript(
      `
      (async () => {
        const res = await fetch('/api/v4/pdp/get_pc?shop_id=${shopId}&item_id=${itemId}', {
          credentials: 'include',
          headers: { 'x-api-source': 'pc', 'Accept': 'application/json' },
        });
        const j = await res.json();
        const item = j?.data?.item;
        return {
          status: res.status,
          error: j.error,
          name: item?.name || item?.title || null,
          price: item?.price ?? null,
          price_min: item?.price_min ?? null,
          converted: item?.price_min != null ? item.price_min / 100000 : null,
        };
      })()
      `,
      true,
    )
    console.log('retry get_pc after shop', JSON.stringify(pdp, null, 2))
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
  app.exit(0)
}).catch((e) => {
  console.error(e)
  app.exit(1)
})
