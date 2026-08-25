/**
 * Build verify-scrape.ts to CJS (same external:electron pattern as electron-vite
 * main) and launch it under the local Electron binary.
 *
 * Extra argv after `--` are forwarded as URLs:
 *   npm run verify:scrape -- https://s.shopee.vn/xxx
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import * as esbuild from 'esbuild'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appRoot = join(__dirname, '..')
const entry = join(__dirname, 'verify-scrape.ts')
const outfile = join(appRoot, 'out', 'verify-scrape.cjs')

const urls = process.argv.slice(2)

mkdirSync(join(appRoot, 'out'), { recursive: true })

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile,
  // Match electron-vite main: leave electron as a runtime require
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info',
})

const require = createRequire(import.meta.url)
const electronPath = require('electron')

console.log('[run-verify-scrape] electron binary:', electronPath)
console.log('[run-verify-scrape] entry:', outfile)
console.log('[run-verify-scrape] urls:', urls.length ? urls.join(' | ') : '(none)')

// Electron treats bare https:// argv tokens as navigation targets when more
// than one is present, and exits -1 before the app boots. Always pass `--`
// so remaining tokens are plain process.argv for the harness.
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
  console.error('[run-verify-scrape] failed to spawn electron:', err)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[run-verify-scrape] killed by signal ${signal}`)
    process.exit(1)
  }
  const normalized =
    code !== null && code > 255 ? code - 0x100000000 : (code ?? 1)
  console.log(`[run-verify-scrape] electron exit code: ${normalized}`)
  process.exit(normalized === 0 ? 0 : normalized < 0 ? 1 : normalized)
})
