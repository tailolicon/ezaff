import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appRoot = join(__dirname, '..')
const entry = join(__dirname, 'probe-og-price-electron.ts')
const outfile = join(appRoot, 'out', 'probe-og-price-electron.cjs')
mkdirSync(join(appRoot, 'out'), { recursive: true })
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile,
  external: ['electron'],
  logLevel: 'info',
})
const require = createRequire(import.meta.url)
const electronPath = require('electron')
const child = spawn(electronPath, [outfile], {
  cwd: appRoot,
  stdio: 'inherit',
  windowsHide: false,
})
child.on('exit', (code) => process.exit(code ?? 1))
