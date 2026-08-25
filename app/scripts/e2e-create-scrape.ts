import { app } from "electron"
import Database from "better-sqlite3"
import { join } from "node:path"
import { mkdirSync, rmSync } from "node:fs"
import { createProductWithScrape } from "../electron/services/scraper/productScrape"
import { MIGRATIONS } from "../electron/db/migrations"

app.disableHardwareAcceleration()
void app.whenReady().then(async () => {
  const dir = join(app.getPath("temp"), "ezaff-scrape-test")
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, "test.db")
  try { rmSync(dbPath) } catch {}
  const db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  for (const m of MIGRATIONS) db.exec(m.sql)

  const url = "https://s.shopee.vn/4AywY2kyot"
  console.log("scraping", url)
  const p = await createProductWithScrape(db, url, { skipLookupCache: true })
  console.log(JSON.stringify({
    title: p.title,
    price: p.price,
    image_url: p.image_url,
    image_local: p.image_local,
    shop_name: p.shop_name,
    rating: p.rating,
    rating_count: p.rating_count,
    scrape_status: p.scrape_status,
    scrape_error: p.scrape_error,
  }, null, 2))
  db.close()
  app.exit(0)
}).catch((e) => { console.error(e); app.exit(1) })
