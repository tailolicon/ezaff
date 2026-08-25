import { app } from "electron"
import Database from "better-sqlite3"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { net } from "electron"

app.disableHardwareAcceleration()
void app.whenReady().then(async () => {
  const dbPath = join(process.env.APPDATA || "", "ezaff", "data", "ezaff.db")
  const db = new Database(dbPath, { readonly: true })
  const rows = db.prepare(`SELECT id, image_url, image_local, length(image_url) as ulen, length(image_local) as llen FROM products`).all() as any[]
  console.log(JSON.stringify(rows, null, 2))
  for (const r of rows) {
    console.log("---", r.id)
    console.log("url", r.image_url)
    console.log("local exists", r.image_local ? existsSync(r.image_local) : false, r.image_local)
    if (r.image_url) {
      try {
        const res = await net.fetch(r.image_url, { method: "GET", headers: { "User-Agent": "Mozilla/5.0", Accept: "image/*" } })
        const buf = Buffer.from(await res.arrayBuffer())
        console.log("fetch status", res.status, "ctype", res.headers.get("content-type"), "bytes", buf.length)
      } catch (e) {
        console.log("fetch err", e)
      }
    }
  }
  db.close()
  app.exit(0)
}).catch((e) => { console.error(e); app.exit(1) })
