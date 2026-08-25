import { app } from 'electron'
import { pickPriceFromItem } from '../electron/services/scraper/shopee.scraper'
import {
  getShopeeAuthStatus,
  getShopeeSession,
} from '../electron/services/scraper/shopeeSession'
import { BROWSER_USER_AGENT } from '../electron/services/scraper/urlNormalizer'

const shopId = '279658061'
const itemId = '43508358436'

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

function findPrices(node: unknown, out: unknown[] = [], depth = 0): unknown[] {
  if (!node || depth > 7 || out.length > 15) return out
  if (Array.isArray(node)) {
    for (const x of node.slice(0, 20)) findPrices(x, out, depth + 1)
    return out
  }
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>
    if (
      (o.itemid != null || o.item_id != null) &&
      (o.price != null || o.price_min != null)
    ) {
      out.push({
        itemid: o.itemid ?? o.item_id,
        name: typeof o.name === 'string' ? o.name.slice(0, 40) : null,
        price: o.price,
        price_min: o.price_min,
        match: String(o.itemid ?? o.item_id) === itemId,
        picked: pickPriceFromItem(o),
      })
    }
    for (const k of Object.keys(o)) {
      if (!k.startsWith('__')) findPrices(o[k], out, depth + 1)
    }
  }
  return out
}

void app.whenReady().then(async () => {
  console.log(await getShopeeAuthStatus())
  const ses = getShopeeSession()

  const paths = [
    `/api/v4/shop/rcmd_items?shop_id=${shopId}&limit=20&offset=0`,
    `/api/v4/shop/get_shop_tab?shopid=${shopId}`,
    `/api/v4/recommend/recommend?bundle=shop_page_product_tab_main&shop_id=${shopId}&limit=20&offset=0`,
    `/api/v4/recommend/recommend?bundle=shop_page_product_tab_main&shopid=${shopId}&limit=20`,
    `/api/v4/search/search_facet?keyword=chango&search_type=0`,
    `/api/v4/pages/get_homepage_mall_list?offset=0&limit=10`,
    `/api/v4/banner/batch_list`,
    `/api/v4/item/get_categories?catids=11036526`,
    `/api/v4/homepage/get_daily_discover?limit=10&offset=0`,
    `/api/v4/product/rating/get_item_ratings?itemid=${itemId}&shopid=${shopId}&limit=1&offset=0&type=0&filter=0`,
    `/api/v4/pdp/get_shipping_info?shopid=${shopId}&itemid=${itemId}`,
    `/api/v4/pdp/get_shop_info?shopid=${shopId}`,
    `/api/v4/shop/get_categories?shopid=${shopId}`,
    `/api/v4/shop/get_items_by_label?shopid=${shopId}&limit=20`,
    // SEO-ish
    `/api/v4/item/get_list?shop_id=${shopId}&item_ids=[${itemId}]`,
    `/api/v4/item/get_list?item_ids=${itemId}`,
    `/api/v2/item/get_list?shopid=${shopId}&itemids=${itemId}`,
  ]

  for (const path of paths) {
    const url = `https://shopee.vn${path}`
    try {
      const res = await ses.fetch(url, {
        headers: {
          Accept: 'application/json',
          'x-api-source': 'pc',
          'User-Agent': BROWSER_USER_AGENT,
          Referer: 'https://shopee.vn/',
        },
      })
      const text = await res.text()
      let j: Record<string, unknown> = {}
      try {
        j = JSON.parse(text)
      } catch {
        console.log(path.slice(0, 70), 'st', res.status, 'non-json', text.slice(0, 80))
        continue
      }
      const prices = findPrices(j)
      console.log(
        path.slice(0, 75).padEnd(75),
        'st',
        res.status,
        'err',
        j.error,
        'prices',
        prices.length,
        prices[0] ? JSON.stringify(prices[0]) : '',
      )
      const match = prices.find((p) => (p as { match?: boolean }).match)
      if (match) console.log('  *** MATCH', JSON.stringify(match))
    } catch (e) {
      console.log(path.slice(0, 70), 'ERR', String(e).slice(0, 80))
    }
  }
  app.exit(0)
}).catch((e) => {
  console.error(e)
  app.exit(1)
})
