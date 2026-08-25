/**
 * Cầu nối tạm để lấy dữ liệu từ IndexedDB của tab Shopee ra đĩa, khi
 * `ezHarvest.dumpCsv()` không tải được file về (Chrome chặn download tự động).
 *
 *   node tools/receive-dump.js
 *
 * rồi trong Console của tab affiliate.shopee.vn:
 *
 *   const rows = await ezHarvest.links()
 *   const csv = ['key,url', ...rows.map(r => `${r.key},${r.value}`)].join('\n')
 *   await fetch('http://127.0.0.1:8791/ezaff-owner-links.csv', {method:'POST', body: csv})
 *
 * Chỉ nghe trên 127.0.0.1 và tự tắt sau khi nhận xong.
 */
const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = 8791
const OUT_DIR = __dirname

const server = http.createServer((req, res) => {
  // Trang gọi sang là https://affiliate.shopee.vn — cần cả CORS lẫn cờ
  // Private Network Access, không thì Chrome chặn ở bước preflight.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Private-Network', 'true')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }
  if (req.method !== 'POST') {
    res.writeHead(405)
    return res.end('chỉ nhận POST')
  }

  // Tên file lấy từ đường dẫn, cắt sạch mọi thứ có thể thoát ra khỏi OUT_DIR.
  const name = path.basename(decodeURIComponent(req.url)) || 'dump.txt'
  const dest = path.join(OUT_DIR, name)
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    fs.writeFileSync(dest, body)
    console.log(`[ezaff] đã ghi ${dest} — ${(body.length / 1048576).toFixed(1)} MB`)
    res.writeHead(200)
    res.end('ok')
    server.close(() => process.exit(0))
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ezaff] đang chờ ở http://127.0.0.1:${PORT} — ghi vào ${OUT_DIR}`)
})
