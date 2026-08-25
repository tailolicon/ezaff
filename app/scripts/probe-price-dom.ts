import { app, BrowserWindow } from "electron"
import { BROWSER_USER_AGENT } from "../electron/services/scraper/urlNormalizer"
import { shopeePartitionWebPreferences, getShopeeAuthStatus, probeShopeeSignedIn } from "../electron/services/scraper/shopeeSession"
import { scrapeProductViaSharePreview, convertShopeePdpPrice } from "../electron/services/scraper/shopee.scraper"

const shopId = "89827191"
const itemId = "26609048170"
const productUrl = `https://shopee.vn/product/${shopId}/${itemId}`

app.disableHardwareAcceleration()
app.on("window-all-closed", () => {})

void app.whenReady().then(async () => {
  const auth = await getShopeeAuthStatus()
  console.log("signedIn", auth.signedIn, auth.message)

  const og = await scrapeProductViaSharePreview(shopId, itemId)
  console.log("OG", { title: og?.title, price: og?.price, image: og?.image_url?.slice(0,60), rating: og?.rating })

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: shopeePartitionWebPreferences({ offscreen: true }),
  })
  try {
    win.webContents.setUserAgent(BROWSER_USER_AGENT)
    await win.loadURL(productUrl, { userAgent: BROWSER_USER_AGENT, httpReferrer: "https://shopee.vn/" })
    await new Promise((r) => setTimeout(r, 4000))
    const href = await win.webContents.executeJavaScript("location.href", true)
    console.log("href", href)

    const data = await win.webContents.executeJavaScript(`(async () => {
      const out = { title: null, priceText: null, price: null, image: null, href: location.href };
      const h1 = document.querySelector("h1");
      if (h1) out.title = (h1.textContent||"").trim();
      const ogt = document.querySelector('meta[property="og:title"]');
      if (ogt && !out.title) out.title = ogt.getAttribute("content");
      const ogi = document.querySelector('meta[property="og:image"]');
      if (ogi) out.image = ogi.getAttribute("content");
      // price candidates
      const nodes = Array.from(document.querySelectorAll("[class*=price], [class*=Price], .pqTWkA, [data-sqe=price]"));
      out.priceText = nodes.slice(0,5).map(n => (n.textContent||"").trim()).filter(Boolean);
      // INITIAL_STATE walk for price_min
      function walk(n, d) {
        if (!n || d>10) return null;
        if (typeof n === "object") {
          if (n.price_min != null || n.price != null) return { price_min: n.price_min, price: n.price, name: n.name||n.title };
          if (Array.isArray(n)) { for (const x of n) { const h=walk(x,d+1); if (h) return h; } }
          else { for (const k of Object.keys(n)) { const h=walk(n[k],d+1); if (h) return h; } }
        }
        return null;
      }
      try { out.fromState = walk(window.__INITIAL_STATE__||window.__NEXT_DATA__||null, 0); } catch(e) { out.fromState = String(e); }
      // in-page api
      try {
        const res = await fetch("/api/v4/pdp/get_pc?shop_id=${shopId}&item_id=${itemId}", { credentials:"include", headers:{"x-api-source":"pc","Accept":"application/json"} });
        const j = await res.json();
        out.apiError = j.error;
        out.apiPrice = j?.data?.item?.price_min ?? j?.data?.item?.price ?? null;
        out.apiName = j?.data?.item?.name ?? j?.data?.item?.title ?? null;
      } catch(e) { out.apiErr = String(e); }
      return out;
    })()`, true)
    console.log(JSON.stringify(data, null, 2))
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
  app.exit(0)
}).catch((e) => { console.error(e); app.exit(1) })
