import { app, session } from "electron"
import { SHOPEE_SESSION_PARTITION } from "../electron/services/scraper/shopeeSession"
import { BROWSER_USER_AGENT } from "../electron/services/scraper/urlNormalizer"

app.disableHardwareAcceleration()
void app.whenReady().then(async () => {
  const ses = session.fromPartition(SHOPEE_SESSION_PARTITION)
  const cookies = await ses.cookies.get({ domain: ".shopee.vn" })
  console.log("cookies", cookies.length, cookies.map(c => c.name).slice(0, 15))

  const url = "https://shopee.vn/api/v4/pdp/get_pc?shop_id=89827191&item_id=26609048170"
  const res = await ses.fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "x-api-source": "pc",
      "User-Agent": BROWSER_USER_AGENT,
      Referer: "https://shopee.vn/product/89827191/26609048170",
    },
  })
  const text = await res.text()
  console.log("status", res.status, text.slice(0, 300))

  // also try chicken product which has OG price - confirm
  const res2 = await ses.fetch("https://shopee.vn/api/v4/pdp/get_pc?shop_id=279658061&item_id=43508358436", {
    headers: {
      Accept: "application/json",
      "x-api-source": "pc",
      "User-Agent": BROWSER_USER_AGENT,
      Referer: "https://shopee.vn/",
    },
  })
  console.log("chicken api", res2.status, (await res2.text()).slice(0, 200))
  app.exit(0)
}).catch((e) => { console.error(e); app.exit(1) })
