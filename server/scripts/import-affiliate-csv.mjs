/**
 * Turn "Lấy link sản phẩm hàng loạt" CSV exports from the Shopee Affiliate
 * dashboard into a KV bulk-put file for the owner-link mapping table.
 *
 * Usage:
 *   node scripts/import-affiliate-csv.mjs <file-or-folder>… [--out owner-links.json]
 *
 * Then upload (one KV write per product, mind the daily quota):
 *   npx wrangler kv bulk put owner-links.json --binding=OWNER_KV --preview false
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync } from 'node:fs'
import { join, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

// Bundle the TypeScript parser to a temp ESM file so this stays a plain
// `node` script with no build step of its own.
const tmp = join(mkdtempSync(join(tmpdir(), 'ezaff-csv-')), 'affiliateCsv.mjs')
await esbuild.build({
  entryPoints: ['src/affiliateCsv.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: tmp,
  logLevel: 'error',
})
const { parseAffiliateCsv, toKvBulk } = await import(pathToFileURL(tmp).href)

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const outFile = outIndex >= 0 ? args[outIndex + 1] : 'owner-links.json'
const outValueIndex = outIndex >= 0 ? outIndex + 1 : -1
const inputs = args.filter(
  (a, i) => !a.startsWith('--') && i !== outValueIndex,
)

if (inputs.length === 0) {
  console.error('Cách dùng: node scripts/import-affiliate-csv.mjs <file.csv|thư-mục>… [--out owner-links.json]')
  process.exit(1)
}

/** Expand folders into the CSV files inside them. */
function collectCsvFiles(paths) {
  const files = []
  for (const p of paths) {
    if (statSync(p).isDirectory()) {
      for (const name of readdirSync(p)) {
        if (extname(name).toLowerCase() === '.csv') files.push(join(p, name))
      }
    } else {
      files.push(p)
    }
  }
  return files
}

const files = collectCsvFiles(inputs)
if (files.length === 0) {
  console.error('Không tìm thấy file .csv nào.')
  process.exit(1)
}

// Later files win, so re-exporting a product updates its link.
const byKey = new Map()
let totalSkipped = 0
let totalDuplicates = 0

for (const file of files) {
  const report = parseAffiliateCsv(readFileSync(file, 'utf8'))
  for (const m of report.mappings) byKey.set(m.key, m)
  totalSkipped += report.skipped.length
  totalDuplicates += report.duplicates

  console.log(
    `${file}\n  → ${report.mappings.length} link` +
      (report.duplicates ? `, ${report.duplicates} trùng trong file` : '') +
      (report.skipped.length ? `, ${report.skipped.length} dòng bỏ qua` : ''),
  )
  for (const s of report.skipped.slice(0, 5)) {
    console.log(`     dòng ${s.row}: ${s.reason}`)
  }
  if (report.skipped.length > 5) {
    console.log(`     … và ${report.skipped.length - 5} dòng nữa`)
  }
}

const mappings = [...byKey.values()]
writeFileSync(outFile, JSON.stringify(toKvBulk(mappings), null, 2), 'utf8')

// Highest commission first — useful when the daily KV quota forces a split.
const ranked = mappings
  .filter((m) => m.commissionPercent !== null)
  .sort((a, b) => b.commissionPercent - a.commissionPercent)

console.log(`\n${mappings.length} sản phẩm → ${outFile}`)
if (totalSkipped) console.log(`${totalSkipped} dòng bị bỏ qua (xem chi tiết ở trên)`)
if (totalDuplicates) console.log(`${totalDuplicates} dòng trùng, đã giữ bản mới nhất`)
if (ranked.length) {
  const top = ranked.slice(0, 3).map((m) => `${m.commissionPercent}%`).join(', ')
  console.log(`Hoa hồng cao nhất: ${top}`)
}
console.log(
  `\nĐẩy lên KV:\n  npx wrangler kv bulk put ${outFile} --binding=OWNER_KV --preview false`,
)
