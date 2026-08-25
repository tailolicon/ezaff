/**
 * Turn harvested owner links into the KV objects `GET /v1/bundle` serves.
 *
 * Usage:
 *   node scripts/publish-bundle.mjs <links.json> [--prev dist/bundle-full.txt] [--out dist]
 *
 * `links.json` is what ezHarvest.dump() writes: [{ key, value }, …] where key
 * is "owner:shopee:<shopId>:<itemId>" and value is the shortlink.
 *
 * Writes into <out>/:
 *   bundle-full.txt      full snapshot at the new version
 *   bundle-seg-<v>.txt   just what this publish added
 *   bundle-kv.json       bulk-put file for wrangler
 *
 * Then:
 *   npx wrangler kv bulk put dist/bundle-kv.json --binding=OWNER_KV --preview false
 *
 * Keep bundle-full.txt between runs and pass it as --prev; that is what makes
 * the next publish a small delta instead of a full reship for every client.
 * The version increments by exactly 1 each publish — the Worker's delta-gap
 * check relies on that.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const SHORTLINK_HOSTS = ['s.shopee.vn', 'shope.ee', 'shp.ee']
const BUNDLE_FORMAT = 'v1'
const CODE_RE = /^[A-Za-z0-9_-]{1,64}$/
const ID_RE = /^\d{1,20}$/

function packUrl(url) {
  let parsed
  try {
    parsed = new URL(String(url).trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  const i = SHORTLINK_HOSTS.indexOf(host)
  if (i === -1) return null
  const code = parsed.pathname.replace(/^\//, '').replace(/\/$/, '')
  if (!CODE_RE.test(code)) return null
  return `${i}${code}`
}

const args = process.argv.slice(2)
const FLAGS_WITH_VALUE = new Set(['--prev', '--out'])

// Walk once so a flag's value is never mistaken for the positional input.
const opts = {}
const positional = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (FLAGS_WITH_VALUE.has(a)) {
    opts[a] = args[++i]
  } else if (a.startsWith('--')) {
    opts[a] = true
  } else {
    positional.push(a)
  }
}
const input = positional[0]
const prevPath = opts['--prev'] ?? null
const outDir = opts['--out'] ?? 'dist'

if (!input) {
  console.error('Cách dùng: node scripts/publish-bundle.mjs <links.json> [--prev bundle-full.txt] [--out dist]')
  process.exit(1)
}

// ── đọc link mới ─────────────────────────────────────────────────────────────
// Nhận cả hai thứ ezHarvest xuất ra: dump() → JSON, dumpCsv() → CSV "key,url".
const rawInput = readFileSync(input, 'utf8').replace(/^﻿/, '')
let rows
if (input.toLowerCase().endsWith('.csv')) {
  rows = []
  for (const line of rawInput.split(/\r?\n/)) {
    if (!line) continue
    const comma = line.indexOf(',')
    if (comma === -1) continue
    const key = line.slice(0, comma).trim()
    const value = line.slice(comma + 1).trim()
    if (key === 'key') continue // dòng tiêu đề
    rows.push({ key, value })
  }
} else {
  rows = JSON.parse(rawInput)
}
if (!Array.isArray(rows)) {
  console.error('File đầu vào phải là CSV "key,url" hoặc JSON [{ key, value }, …]')
  process.exit(1)
}

/** "shopId,itemId" → packed code */
const incoming = new Map()
let skipped = 0
for (const row of rows) {
  const key = String(row?.key ?? '')
  const m = /^owner:shopee:(\d+):(\d+)$/.exec(key)
  const packed = packUrl(row?.value)
  if (!m || !packed) {
    skipped += 1
    continue
  }
  incoming.set(`${m[1]},${m[2]}`, packed)
}

// ── đọc snapshot cũ ──────────────────────────────────────────────────────────
const previous = new Map()
let prevVersion = 0
if (prevPath && existsSync(prevPath)) {
  const text = readFileSync(prevPath, 'utf8')
  const nl = text.indexOf('\n')
  const header = text.slice(0, nl).trim().split(/\s+/)
  if (header[0] !== BUNDLE_FORMAT) {
    console.error(`--prev không đúng định dạng ${BUNDLE_FORMAT}`)
    process.exit(1)
  }
  prevVersion = Number(header[1]) || 0
  for (const line of text.slice(nl + 1).split('\n')) {
    if (!line) continue
    const parts = line.split(',')
    if (parts.length !== 3) continue
    const [shopId, itemId, packed] = parts
    if (!ID_RE.test(shopId) || !ID_RE.test(itemId)) continue
    previous.set(`${shopId},${itemId}`, packed)
  }
}

const version = prevVersion + 1

// Chỉ những mục thật sự mới hoặc đổi giá trị mới vào segment.
const added = []
for (const [k, v] of incoming) {
  if (previous.get(k) !== v) added.push(`${k},${v}`)
}

// Snapshot mới = cũ + mới (mục mới ghi đè mục cũ cùng khoá).
const merged = new Map(previous)
for (const [k, v] of incoming) merged.set(k, v)

const body = (lines) => `${BUNDLE_FORMAT} ${version} ${lines.length}\n${lines.join('\n')}\n`
const fullLines = [...merged].map(([k, v]) => `${k},${v}`)
const fullText = body(fullLines)
const segText = body(added)

// Giữ lại cửa sổ segment vừa phải: client cũ hơn thì nhận nguyên snapshot.
const SEGMENT_WINDOW = 30
const segments = []
for (let v = Math.max(1, version - SEGMENT_WINDOW + 1); v <= version; v++) {
  segments.push(v)
}

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'bundle-full.txt'), fullText)
writeFileSync(join(outDir, `bundle-seg-${version}.txt`), segText)
writeFileSync(
  join(outDir, 'bundle-kv.json'),
  JSON.stringify(
    [
      { key: 'bundle:full', value: fullText },
      { key: `bundle:seg:${version}`, value: segText },
      {
        key: 'bundle:meta',
        value: JSON.stringify({ version, count: merged.size, segments }),
      },
    ],
    null,
    1,
  ),
)

const kb = (s) => `${Math.round(Buffer.byteLength(s) / 1024)} KB`
console.log(`Phiên bản   ${prevVersion} → ${version}`)
console.log(`Đọc vào     ${rows.length} dòng${skipped ? `, bỏ ${skipped} dòng hỏng` : ''}`)
console.log(`Thêm mới    ${added.length}`)
console.log(`Tổng cộng   ${merged.size}  (${kb(fullText)} snapshot, ${kb(segText)} delta)`)
console.log(`\nĐẩy lên:\n  npx wrangler kv bulk put ${join(outDir, 'bundle-kv.json')} --binding=OWNER_KV --preview false`)
if (!prevPath) {
  console.log('\nLưu ý: không có --prev nên đây là bản đầu, mọi client sẽ tải nguyên snapshot.')
  console.log(`Lần sau nhớ: --prev ${join(outDir, 'bundle-full.txt')}`)
}
