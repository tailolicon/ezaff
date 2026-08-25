/**
 * Build login-then-scrape.ts and launch under Electron.
 *
 *   node scripts/run-login-then-scrape.mjs [url]
 *   npm run login:scrape -- https://s.shopee.vn/xxx
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import * as esbuild from 'esbuild'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appRoot = join(__dirname, '..')
const entry = join(__dirname, 'login-then-scrape.ts')
const outfile = join(appRoot, 'out', 'login-then-scrape.cjs')

const urls = process.argv.slice(2)

mkdirSync(join(appRoot, 'out'), { recursive: true })

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile,
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info',
})

const require = createRequire(import.meta.url)
const electronPath = require('electron')

console.log('[run-login-then-scrape] electron:', electronPath)
console.log('[run-login-then-scrape] entry:', outfile)

const electronArgs = [outfile, '--', ...urls]

const child = spawn(electronPath, electronArgs, {
  cwd: appRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING ?? '0',
  },
  windowsHide: false,
})

child.on('error', (err) => {
  console.error('[run-login-then-scrape] spawn failed:', err)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[run-login-then-scrape] killed by signal ${signal}`)
    process.exit(1)
  }
  const normalized =
    code !== null && code > 255 ? code - 0x100000000 : (code ?? 1)
  process.exit(normalized === 0 ? 0 : normalized < 0 ? 1 : normalized)
})
