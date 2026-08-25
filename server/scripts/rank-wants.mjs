/**
 * Aggregate the daily "want" reports into a ranked work list.
 *
 * Usage:
 *   node scripts/rank-wants.mjs [--days 7] [--top 20000] [--local] [--out wants.txt]
 *
 * Reads every `want:<day>:<installId>` key, counts how many distinct installs
 * asked for each product, and writes the ids ordered by demand.
 *
 * Rank by number of installs, not raw mentions: a product 50 people hold is
 * worth generating before 50 products one person holds. The output is the
 * keyword-free answer to "what should I generate next" — feed the top slice
 * back into the harvester, publish, and those users are covered tomorrow.
 *
 * Output is one "shopId:itemId" per line, plus a `.counts.tsv` beside it with
 * the demand numbers so coverage can be tracked over time.
 *
 * Note: this shells out to wrangler once per key, which is fine for a nightly
 * batch but slow at tens of thousands of installs. If it ever becomes the
 * bottleneck, move the aggregation into an admin Worker route behind
 * ADMIN_TOKEN so the listing and reads happen inside Cloudflare.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const FLAGS_WITH_VALUE = new Set(['--days', '--top', '--out'])
const opts = {}
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (FLAGS_WITH_VALUE.has(a)) opts[a] = args[++i]
  else if (a.startsWith('--')) opts[a] = true
}

const days = Number(opts['--days'] ?? 7)
const top = Number(opts['--top'] ?? 20000)
const outFile = opts['--out'] ?? 'wants.txt'
const local = Boolean(opts['--local'])

const wrangler = (argv) =>
  execFileSync('npx', ['wrangler', ...argv], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === 'win32',
  })

const base = ['--binding=OWNER_KV', '--preview', 'false']
if (local) base.push('--local')

// ── which days count ─────────────────────────────────────────────────────────
const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10)

console.log(`Đọc báo cáo từ ${cutoff} trở đi…`)

let keys
try {
  const raw = wrangler(['kv', 'key', 'list', ...base, '--prefix', 'want:'])
  // wrangler prints warnings before the JSON — take from the first bracket.
  keys = JSON.parse(raw.slice(raw.indexOf('[')))
} catch (err) {
  console.error('Không liệt kê được khoá want:', err.message)
  process.exit(1)
}

const wanted = keys
  .map((k) => k.name)
  .filter((name) => {
    const day = name.split(':')[1]
    return typeof day === 'string' && day >= cutoff
  })

console.log(`${keys.length} khoá tổng, ${wanted.length} khoá trong khoảng.`)
if (wanted.length === 0) {
  console.log('Chưa có báo cáo nào. Client gửi 1 lần/ngày, chờ thêm.')
  process.exit(0)
}

// ── đếm theo số install ──────────────────────────────────────────────────────
/** product id → Set(installId) */
const demand = new Map()
let read = 0
let failed = 0

for (const name of wanted) {
  const installId = name.split(':').slice(2).join(':')
  let ids
  try {
    const raw = wrangler(['kv', 'key', 'get', name, ...base])
    ids = JSON.parse(raw.slice(raw.indexOf('[')))
  } catch {
    failed += 1
    continue
  }
  if (!Array.isArray(ids)) continue
  for (const id of ids) {
    let set = demand.get(id)
    if (!set) demand.set(id, (set = new Set()))
    set.add(installId)
  }
  read += 1
  if (read % 50 === 0) process.stdout.write(`\r  đọc ${read}/${wanted.length}`)
}
process.stdout.write('\r')

const ranked = [...demand.entries()]
  .map(([id, installs]) => [id, installs.size])
  .sort((a, b) => b[1] - a[1])

const slice = ranked.slice(0, top)
writeFileSync(outFile, slice.map(([id]) => id).join('\n') + '\n')
writeFileSync(
  `${outFile}.counts.tsv`,
  'productId\tinstalls\n' + slice.map(([id, n]) => `${id}\t${n}`).join('\n') + '\n',
)

const multi = ranked.filter(([, n]) => n > 1).length
console.log(`Đọc xong ${read} báo cáo${failed ? `, hỏng ${failed}` : ''}.`)
console.log(`${ranked.length} sản phẩm khác nhau đang thiếu link.`)
console.log(`${multi} sản phẩm có từ 2 người trở lên cùng cần — làm mấy cái này trước.`)
console.log(`Cao nhất: ${ranked[0]?.[1] ?? 0} người cùng cần.`)
console.log(`\nĐã ghi ${slice.length} id vào ${outFile} (+ ${outFile}.counts.tsv)`)
