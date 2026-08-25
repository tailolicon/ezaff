/**
 * Build the product-metadata bundle from the full harvest CSV.
 *
 * Usage:
 *   node scripts/publish-meta.mjs ../tools/ezaff-links-full.csv \
 *     [--prev dist/meta-full.txt] [--out dist]
 *
 * Input columns (as ezHarvest writes them):
 *   key,url,commission_pct,est_commission_vnd,price_vnd,historical_sold,
 *   rating,shop_name,name
 *
 * `est_commission_vnd` is dropped — it is price × pct and the client can
 * recompute it, which is cheaper than shipping it on every one of 132k rows.
 *
 * The payload is far past the 25 MB a single KV value holds, so it is written
 * as numbered chunks plus a count key. Everything the Worker needs to
 * reassemble is in the bulk-put file.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const args = process.argv.slice(2)
const FLAGS = new Set(['--prev', '--out'])
const opts = {}
const positional = []
for (let i = 0; i < args.length; i++) {
  if (FLAGS.has(args[i])) opts[args[i]] = args[++i]
  else if (args[i].startsWith('--')) opts[args[i]] = true
  else positional.push(args[i])
}
const input = positional[0]
const prevPath = opts['--prev'] ?? null
const outDir = opts['--out'] ?? 'dist'

if (!input) {
  console.error('Cách dùng: node scripts/publish-meta.mjs <ezaff-links-full.csv> [--prev dist/meta-full.txt] [--out dist]')
  process.exit(1)
}

// ── bộ đọc CSV đúng chuẩn ────────────────────────────────────────────────────
// Tên sản phẩm chứa đầy dấu phẩy và dấu nháy — tách bằng split(',') là hỏng
// hơn một phần ba số dòng. Đo trên file thật: 52.771/132.178 dòng có phẩy.
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') {
      row.push(field); field = ''
      if (row.length > 1) rows.push(row)
      row = []
    } else if (c !== '\r') field += c
  }
  if (field !== '' || row.length) { row.push(field); if (row.length > 1) rows.push(row) }
  return rows
}

const sanitise = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim()
const num = (v, max) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(Math.round(n), max)
}

const raw = readFileSync(input, 'utf8').replace(/^\uFEFF/, '')
const rows = parseCsv(raw)
const header = rows.shift() ?? []
const col = (name) => header.indexOf(name)

const iKey = col('key')
const iPct = col('commission_pct')
const iPrice = col('price_vnd')
const iSold = col('historical_sold')
const iRating = col('rating')
const iShop = col('shop_name')
const iName = col('name')

if (iKey === -1 || iName === -1) {
  console.error('Thiếu cột bắt buộc. Cột đọc được:', header.join(', '))
  process.exit(1)
}

/** "shopId\titemId" → dòng đã đóng gói */
const incoming = new Map()
let skipped = 0
let noMeta = 0

for (const r of rows) {
  const m = /^owner:shopee:(\d+):(\d+)$/.exec(r[iKey] ?? '')
  if (!m) { skipped += 1; continue }
  const shopId = m[1]
  const itemId = m[2]
  const name = sanitise(r[iName])
  const shop = sanitise(r[iShop])
  if (!name && !shop) noMeta += 1
  incoming.set(
    `${shopId}\t${itemId}`,
    [
      shopId, itemId,
      num(r[iPct], 100),
      num(r[iPrice], 1e12),
      num(r[iSold], 1e9),
      num(r[iRating], 5),
      shop, name,
    ].join('\t'),
  )
}

// ── so với bản trước để ra delta ─────────────────────────────────────────────
const previous = new Map()
let prevVersion = 0
if (prevPath && existsSync(prevPath)) {
  const text = readFileSync(prevPath, 'utf8')
  const nl = text.indexOf('\n')
  const h = text.slice(0, nl).trim().split(/\s+/)
  if (h[0] !== 'm1') { console.error('--prev không phải định dạng m1'); process.exit(1) }
  prevVersion = Number(h[1]) || 0
  for (const line of text.slice(nl + 1).split('\n')) {
    if (!line) continue
    const f = line.split('\t')
    if (f.length !== 8) continue
    previous.set(`${f[0]}\t${f[1]}`, line)
  }
}

const version = prevVersion + 1
const added = []
for (const [k, line] of incoming) {
  if (previous.get(k) !== line) added.push(line)
}

const merged = new Map(previous)
for (const [k, line] of incoming) merged.set(k, line)

const body = (lines) => `m1 ${version} ${lines.length}\n${lines.join('\n')}\n`
const fullText = body([...merged.values()])
const segText = body(added)

// ── cắt mảnh cho vừa giới hạn 25 MB của một value KV ────────────────────────
const MAX_CHUNK = 20 * 1024 * 1024
function chunk(text) {
  if (Buffer.byteLength(text) <= MAX_CHUNK) return [text]
  const out = []
  let cur = ''
  let bytes = 0
  const pieces = text.split('\n')
  for (let i = 0; i < pieces.length; i++) {
    const isLast = i === pieces.length - 1
    if (isLast && pieces[i] === '') break
    const piece = isLast ? pieces[i] : pieces[i] + '\n'
    const b = Buffer.byteLength(piece)
    if (bytes > 0 && bytes + b > MAX_CHUNK) { out.push(cur); cur = ''; bytes = 0 }
    cur += piece
    bytes += b
  }
  if (cur !== '') out.push(cur)
  return out
}

const chunkEntries = (prefix, text) => {
  const parts = chunk(text)
  return [
    ...parts.map((value, i) => ({ key: `${prefix}:${i}`, value })),
    { key: `${prefix}:count`, value: String(parts.length) },
  ]
}

const SEGMENT_WINDOW = 30
const segments = []
for (let v = Math.max(1, version - SEGMENT_WINDOW + 1); v <= version; v++) segments.push(v)

mkdirSync(join(root, outDir), { recursive: true })
writeFileSync(join(root, outDir, 'meta-full.txt'), fullText)

/*
 * On a first publish the delta is the whole snapshot, so storing both would
 * put 51 MB in KV for 25 MB of data and double the upload. A client on
 * version 0 always takes the snapshot anyway — the Worker never reaches for
 * segment 1 — so it is simply not written.
 */
const firstPublish = prevVersion === 0
const kvEntries = [
  ...chunkEntries('meta:full', fullText),
  ...(firstPublish ? [] : chunkEntries(`meta:seg:${version}`, segText)),
  {
    key: 'meta:meta',
    value: JSON.stringify({
      version,
      count: merged.size,
      segments: firstPublish ? [] : segments,
    }),
  },
]
writeFileSync(join(root, outDir, 'meta-kv.json'), JSON.stringify(kvEntries, null, 1))

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`
console.log(`Phiên bản   ${prevVersion} → ${version}`)
console.log(`Đọc vào     ${rows.length} dòng${skipped ? `, bỏ ${skipped} khoá lạ` : ''}`)
console.log(`Thiếu meta  ${noMeta} dòng (vẫn giữ, link vẫn dùng được)`)
console.log(`Thêm mới    ${added.length}`)
console.log(`Tổng cộng   ${merged.size}`)
console.log(`Snapshot    ${mb(Buffer.byteLength(fullText))} → ${chunk(fullText).length} mảnh`)
console.log(
  firstPublish
    ? 'Delta       (bỏ qua — bản đầu, client tải thẳng snapshot)'
    : `Delta       ${mb(Buffer.byteLength(segText))} → ${chunk(segText).length} mảnh`,
)
console.log(`\nĐẩy lên:\n  npx wrangler kv bulk put ${join(outDir, 'meta-kv.json')} --binding=OWNER_KV --preview false`)
