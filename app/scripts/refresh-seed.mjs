/**
 * Refresh the owner-link seed shipped inside the installer.
 *
 * Usage:
 *   node scripts/refresh-seed.mjs ../server/dist/bundle-full.txt
 *
 * Takes the snapshot that publish-bundle.mjs wrote, gzips it into
 * resources/res.dat, and reports the version baked in.
 *
 * The seed is committed to the repo on purpose: a build must produce the same
 * app from the same commit without needing the network or a live Worker.
 * Run this after a harvest, then rebuild — the version inside the file is what
 * new installs use as their `?since=`, so a stale seed only costs one larger
 * first sync, never correctness.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const target = join(here, '..', 'resources', 'res.dat')

const input = process.argv[2]
if (!input) {
  console.error('Cách dùng: node scripts/refresh-seed.mjs <bundle-full.txt>')
  process.exit(1)
}

const raw = readFileSync(input)
const newline = raw.indexOf(10)
const header = raw.toString('utf8', 0, newline).trim().split(/\s+/)

if (header[0] !== 'v1') {
  console.error(`Không phải bundle v1 (đọc được "${header[0]}")`)
  process.exit(1)
}

const version = Number(header[1])
const count = Number(header[2])
if (!Number.isInteger(version) || version < 1) {
  console.error(`Version không hợp lệ: ${header[1]}`)
  process.exit(1)
}

const gz = gzipSync(raw, { level: 9 })
// Nonce + XOR — keep in sync with ownerLinkMask.ts wrapResourceBytes
const RES_KEY = Buffer.from([
  0x6c, 0x2b, 0x9e, 0x41, 0xd0, 0x17, 0x88, 0x53, 0xfa, 0x0c, 0x31, 0xb4,
])
const nonce = randomBytes(16)
const wrapped = Buffer.allocUnsafe(16 + gz.length)
nonce.copy(wrapped, 0)
for (let i = 0; i < gz.length; i++) {
  wrapped[16 + i] = gz[i] ^ RES_KEY[i % RES_KEY.length] ^ nonce[i % 16]
}
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, wrapped)

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`
console.log(`Seed v${version} — ${count.toLocaleString('vi-VN')} link`)
console.log(`${mb(raw.length)} → ${mb(gz.length)} nén`)
console.log(`Đã ghi ${target}`)
console.log('\nNhớ commit file này rồi build lại app.')
