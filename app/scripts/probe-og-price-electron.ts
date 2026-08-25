/**
 * Fetch share-preview via Electron net (same as app) and check for price.
 */
import { app } from 'electron'
import {
  fetchShopeeSharePreviewHtml,
  mapShopeeSharePreviewHtml,
  scrapeProductViaSharePreview,
} from '../electron/services/scraper/shopee.scraper'

const shopId = '279658061'
const itemId = '43508358436'

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

void app.whenReady().then(async () => {
  for (let i = 1; i <= 5; i++) {
    const r = await scrapeProductViaSharePreview(shopId, itemId, 12_000)
    console.log(
      `attempt ${i}`,
      r
        ? {
            price: r.price,
            title: r.title?.slice(0, 40),
            shop: r.shop_name,
            rating: r.rating,
            category: r.category,
          }
        : null,
    )
    await new Promise((r) => setTimeout(r, 600))
  }

  // Raw HTML score check
  const url = `https://shopee.vn/product/${shopId}/${itemId}`
  const html = await fetchShopeeSharePreviewHtml(url, 12_000)
  console.log(
    'raw html',
    html
      ? {
          len: html.length,
          hasProduct: /@type["']?\s*:\s*["']Product["']/i.test(html),
          hasPriceAmount: /product:price:amount/i.test(html),
          hasOfferPrice: /"price"\s*:\s*"?\d/i.test(html),
        }
      : null,
  )
  if (html) {
    console.log('mapped', mapShopeeSharePreviewHtml(html, shopId, itemId))
  }
  app.exit(0)
}).catch((e) => {
  console.error(e)
  app.exit(1)
})
