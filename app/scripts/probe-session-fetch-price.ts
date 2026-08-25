import { app } from 'electron'
import { convertShopeePdpPrice, pickPriceFromItem } from '../electron/services/scraper/shopee.scraper'
import {
  getShopeeAuthStatus,
  getShopeeSession,
} from '../electron/services/scraper/shopeeSession'
import { BROWSER_USER_AGENT } from '../electron/services/scraper/urlNormalizer'

const shopId = '279658061'
const itemId = '43508358436'

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

void app.whenReady().then(async () => {
  console.log(await getShopeeAuthStatus())
  const ses = getShopeeSession()
  const urls = [
    `https://shopee.vn/api/v4/pdp/get_pc?shop_id=${shopId}&item_id=${itemId}`,
    `https://shopee.vn/api/v4/item/get?itemid=${itemId}&shopid=${shopId}`,
    `https://shopee.vn/api/v4/shop/get_shop_base?shopid=${shopId}`,
  ]
  for (const url of urls) {
    try {
      const res = await ses.fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'x-api-source': 'pc',
          'User-Agent': BROWSER_USER_AGENT,
          Referer: 'https://shopee.vn/',
        },
      })
      const j = (await res.json()) as Record<string, unknown>
      const data = j.data as Record<string, unknown> | undefined
      const item = (data?.item || data?.item_basic) as Record<string, unknown> | undefined
      console.log(
        url.slice(0, 70),
        'st',
        res.status,
        'err',
        j.error,
        'item',
        item
          ? {
              name: item.name || item.title,
              price: item.price,
              price_min: item.price_min,
              picked: pickPriceFromItem(item),
            }
          : null,
        'name',
        data && 'name' in data ? data.name : null,
      )
    } catch (e) {
      console.log(url.slice(0, 70), 'ERR', e)
    }
  }
  app.exit(0)
}).catch((e) => {
  console.error(e)
  app.exit(1)
})
