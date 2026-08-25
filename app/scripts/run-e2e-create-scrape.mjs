import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdirSync } from "node:fs"
import * as esbuild from "esbuild"
const __dirname = dirname(fileURLToPath(import.meta.url))
const appRoot = join(__dirname, "..")
const outfile = join(appRoot, "out", "e2e-create-scrape.cjs")
mkdirSync(join(appRoot, "out"), { recursive: true })
await esbuild.build({
  entryPoints: [join(__dirname, "e2e-create-scrape.ts")],
  bundle: true, platform: "node", format: "cjs", target: "node20", outfile,
  external: ["electron", "better-sqlite3"], logLevel: "info",
})
const electronPath = createRequire(import.meta.url)("electron")
spawn(electronPath, [outfile], { cwd: appRoot, stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 1))
