/**
 * Dev mode: trial expired + author affiliate fallback "test" at the real 5% rate.
 *
 * Env applied:
 *   EZAFF_FORCE_PAID=1
 *   EZAFF_OWNER_AFFILIATE_URL=test  → https://s.shopee.vn/test (when roll hits)
 *   EZAFF_OWNER_LINK_RATE_BP=500    → 5% (same as production OWNER_LINK_RATE_BP)
 *
 * Override RATE only if you need stress-test, e.g.:
 *   set EZAFF_OWNER_LINK_RATE_BP=10000 && npm run dev:paid
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appRoot = join(__dirname, '..')

const env = {
  ...process.env,
  EZAFF_FORCE_PAID: process.env.EZAFF_FORCE_PAID || '1',
  EZAFF_OWNER_AFFILIATE_URL:
    process.env.EZAFF_OWNER_AFFILIATE_URL || 'test',
  // Default 5% — do not force 100%
  EZAFF_OWNER_LINK_RATE_BP: process.env.EZAFF_OWNER_LINK_RATE_BP || '500',
}

console.log('[dev:paid] FORCE_PAID=%s OWNER_URL=%s RATE_BP=%s (5%% = 500)',
  env.EZAFF_FORCE_PAID,
  env.EZAFF_OWNER_AFFILIATE_URL,
  env.EZAFF_OWNER_LINK_RATE_BP,
)

// Prefer local electron-vite binary
const require = createRequire(import.meta.url)
let bin
try {
  bin = require.resolve('electron-vite/bin/electron-vite.js')
} catch {
  bin = join(appRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
}

const child = spawn(process.execPath, [bin, 'dev'], {
  cwd: appRoot,
  env,
  stdio: 'inherit',
  windowsHide: false,
})

child.on('exit', (code) => process.exit(code ?? 1))
