/**
 * Release-only pass over the bundled main process.
 * Dev (`npm run dev` / `npm test`) never runs this.
 *
 * Optional extra pass. Do NOT run this on the ship pipeline:
 * RC4 + control-flow flattening broke the packaged Electron main process
 * (window flashed then the process exited). Terser minify in
 * electron.vite.config.ts is the production transform.
 *
 * Goal if you opt in locally: a casual unpack of app.asar should not grep
 * to OWNER_LINK_RATE or a bare 500 next to a rate identifier.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import JavaScriptObfuscator from 'javascript-obfuscator'

const here = dirname(fileURLToPath(import.meta.url))
const mainDir = join(here, '..', 'out', 'main')
const indexFile = join(mainDir, 'index.js')

if (!existsSync(indexFile)) {
  console.error('obfuscate-main: out/main/index.js missing — run electron-vite build first')
  process.exit(1)
}

const files = [indexFile]
const chunksDir = join(mainDir, 'chunks')
if (existsSync(chunksDir)) {
  for (const name of readdirSync(chunksDir)) {
    if (name.endsWith('.js')) files.push(join(chunksDir, name))
  }
}

const options = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.35,
  deadCodeInjection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: false,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['rc4'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayThreshold: 0.85,
  splitStrings: true,
  splitStringsChunkLength: 7,
  target: 'node',
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
  sourceMap: false,
}

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const result = JavaScriptObfuscator.obfuscate(source, options)
  writeFileSync(file, result.getObfuscatedCode())
  console.log(`obfuscated ${file}`)
}
