/**
 * One-shot Cloudflare setup: KV namespace → bundle upload → Worker deploy.
 *
 * Run once, after `npx wrangler login`:
 *   node scripts/setup-cloudflare.mjs
 *
 * Idempotent. Re-running with real namespace ids already in wrangler.toml
 * skips creation and just re-uploads + redeploys, so it doubles as the
 * "publish a new bundle" command.
 *
 * Every step prints what it is about to do and stops on the first failure
 * rather than pressing on — a half-configured Worker serving an empty KV is
 * worse than one that never deployed, because clients would sync a 204 and
 * record a version they never received data for.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const tomlPath = join(root, 'wrangler.toml')
const kvJson = join(root, 'dist', 'bundle-kv.json')

const PLACEHOLDER = '00000000000000000000000000000000'

function run(argv, { capture = true } = {}) {
  return execFileSync('npx', ['wrangler', ...argv], {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === 'win32',
  })
}

function step(n, label) {
  console.log(`\n[${n}/5] ${label}`)
}

// ── 0. tiền kiểm ─────────────────────────────────────────────────────────────
if (!existsSync(kvJson)) {
  console.error(`Thiếu ${kvJson}`)
  console.error('Chạy trước:  node scripts/publish-bundle.mjs ../tools/ezaff-owner-links.csv --out dist')
  process.exit(1)
}

try {
  const who = run(['whoami'])
  if (/not authenticated/i.test(who)) throw new Error('chưa đăng nhập')
  const account = /│\s*(.+?)\s*│\s*([0-9a-f]{32})\s*│/.exec(who)
  console.log(`Tài khoản: ${account ? account[1] : '(đã đăng nhập)'}`)
} catch {
  console.error('\nChưa đăng nhập Cloudflare.\n')
  console.error('Chạy lệnh này trước — trình duyệt sẽ mở ra để bạn bấm đồng ý:')
  console.error('  npx wrangler login\n')
  process.exit(1)
}

let toml = readFileSync(tomlPath, 'utf8')

// ── 1+2. namespace ───────────────────────────────────────────────────────────
if (toml.includes(PLACEHOLDER)) {
  step(1, 'Tạo KV namespace…')

  /** wrangler prints the new id inside the toml snippet it suggests. */
  const idFrom = (out) => {
    const m = /id\s*=\s*"([0-9a-f]{32})"/i.exec(out)
    if (!m) throw new Error(`Không đọc được namespace id từ:\n${out}`)
    return m[1]
  }

  const prodId = idFrom(run(['kv', 'namespace', 'create', 'ezaff-owner']))
  console.log(`  production: ${prodId}`)
  const previewId = idFrom(
    run(['kv', 'namespace', 'create', 'ezaff-owner', '--preview']),
  )
  console.log(`  preview:    ${previewId}`)

  step(2, 'Ghi id vào wrangler.toml…')
  copyFileSync(tomlPath, `${tomlPath}.bak`)
  toml = toml
    .replace(`id = "${PLACEHOLDER}"`, `id = "${prodId}"`)
    .replace(`preview_id = "${PLACEHOLDER}"`, `preview_id = "${previewId}"`)
  if (toml.includes(PLACEHOLDER)) {
    console.error('  Vẫn còn id giả trong wrangler.toml — dừng lại, không deploy nửa vời.')
    process.exit(1)
  }
  writeFileSync(tomlPath, toml)
  console.log(`  đã lưu (bản cũ ở ${tomlPath}.bak)`)
} else {
  step(1, 'KV namespace đã có id thật — bỏ qua')
  step(2, 'wrangler.toml đã đúng — bỏ qua')
}

// ── 3. đẩy bundle ────────────────────────────────────────────────────────────
step(3, 'Đẩy 132k link lên KV… (vài phút, file 9 MB)')
const put = run([
  'kv', 'bulk', 'put', kvJson,
  '--binding=OWNER_KV', '--preview', 'false',
])
if (!/success/i.test(put)) {
  console.error(put)
  console.error('  Đẩy KV thất bại — dừng, không deploy Worker rỗng.')
  process.exit(1)
}
console.log('  xong')

// ── 4. deploy ────────────────────────────────────────────────────────────────
step(4, 'Deploy Worker…')
let deployed
try {
  deployed = run(['deploy'])
} catch (err) {
  const out = `${err.stdout ?? ''}${err.stderr ?? ''}`
  const clean = (t) =>
    t
      .split('\n')
      .filter((l) => !/update available|out-of-date|npm install|after installation/i.test(l))
      .join('\n')

  if (/workers\.dev subdomain/i.test(out)) {
    console.error('\n  Tài khoản chưa có tên miền phụ workers.dev.')
    console.error('  Đây là thiết lập tài khoản, làm một lần. Tên đó thành URL công khai')
    console.error('  của bạn về sau, nên bạn tự chọn — tôi không đặt hộ.\n')
    console.error('  Mở trang này, chọn một tên rồi bấm Save:')
    console.error('    https://dash.cloudflare.com/workers/onboarding\n')
    console.error('  Xong thì chạy lại lệnh này. KV đã có đủ dữ liệu,')
    console.error('  chạy lại chỉ deploy chứ không làm lại từ đầu.')
  } else {
    console.error('\n  Deploy thất bại:\n')
    console.error(clean(out))
  }
  process.exit(1)
}

const url = /(https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev)/i.exec(deployed)
if (!url) {
  console.error(deployed)
  console.error('  Không đọc được URL Worker sau khi deploy.')
  process.exit(1)
}
console.log(`  ${url[1]}`)

// ── 5. kiểm chứng thật ───────────────────────────────────────────────────────
step(5, 'Kiểm chứng endpoint vừa deploy…')
const base = url[1]

const check = async () => {
  const health = await fetch(`${base}/health`)
  console.log(`  /health           → ${health.status}`)

  const fresh = await fetch(`${base}/v1/bundle?since=0`)
  const body = await fresh.text()
  const version = fresh.headers.get('X-Bundle-Version')
  const kind = fresh.headers.get('X-Bundle-Kind')
  const count = body.split('\n')[0]
  console.log(`  /v1/bundle?since=0 → ${fresh.status} ${kind} v${version} — "${count}"`)

  const current = await fetch(`${base}/v1/bundle?since=${version}`)
  console.log(`  /v1/bundle?since=${version} → ${current.status} (204 = đã mới nhất)`)

  const want = await fetch(`${base}/v1/want`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installId: 'setup-check', missing: ['1:2'] }),
  })
  console.log(`  POST /v1/want      → ${want.status}`)

  const entries = Number((count.split(' ')[2] ?? '0'))
  const ok =
    health.status === 200 &&
    fresh.status === 200 &&
    current.status === 204 &&
    want.status === 204 &&
    entries > 100_000

  console.log(
    ok
      ? `\n✅ Xong. Worker sống, ${entries.toLocaleString('vi-VN')} link đã lên.`
      : '\n❌ Có bước không đúng — xem lại phần in ở trên.',
  )
  if (!ok) process.exitCode = 1

  console.log(`\nViệc cuối, sửa trong app rồi build lại:`)
  console.log(`  app/electron/services/ownerLink.client.ts`)
  console.log(`  DEFAULT_OWNER_LINK_WORKER_URL = '${base}'`)
}

await check()
