/**
 * First-run import of the owner-link bundle shipped inside the installer.
 *
 * Why ship it at all: a fresh install otherwise has zero mappings until the
 * first sync lands, so the very first copies fall back to the user's own link
 * even for products that are covered. Seeding also means the app is useful
 * before the Worker exists, or when it is unreachable.
 *
 * ── The one thing that must be right ──────────────────────────────────────
 * After importing, `bundle_state.version` MUST be set to the seed's version.
 *
 * Leave it at 0 and the first sync asks `?since=0`, the Worker answers with
 * the full snapshot, and the client re-downloads everything it just imported.
 * Nothing breaks, nothing errors — the seed simply stops buying anything and
 * every install quietly pays for a 2 MB transfer forever. There is a test
 * pinning this.
 */

import { gunzipSync } from 'node:zlib'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import {
  applyBundle,
  getBundleState,
} from '../db/repositories/ownerLinkBundleRepo'
import { parseBundleBody } from './bundleSync'
import { unwrapResourceBytes } from './ownerLinkMask'

/** Shipped via electron-builder `extraResources`, so outside the asar. */
/** Extra resource name — deliberately unrelated to what it contains. */
export const SEED_FILENAME = 'res.dat'

export type SeedResult = {
  imported: number
  version: number
  reason: string
}

/**
 * Where the packaged app keeps extraResources, falling back to the repo copy
 * when running from source.
 */
export function resolveSeedPath(
  resourcesPath: string | undefined,
  appRoot: string,
): string | null {
  const candidates = [
    resourcesPath ? join(resourcesPath, SEED_FILENAME) : null,
    join(appRoot, 'resources', SEED_FILENAME),
  ].filter((p): p is string => p !== null)

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export type ImportSeedDeps = {
  /** Inject for tests. */
  readSeed?: () => Buffer | null
  now?: () => number
}

/**
 * Import the shipped bundle, but only into a database that has never synced.
 *
 * Skipping when a version is already present matters: a user who has been
 * running for months would otherwise have a stale snapshot from the installer
 * stamped over their current data on every launch.
 */
export function importSeedBundle(
  db: Database.Database,
  deps: ImportSeedDeps = {},
): SeedResult {
  const state = getBundleState(db)
  if (state.version > 0) {
    return { imported: 0, version: state.version, reason: 'already_synced' }
  }

  let raw: Buffer | null
  try {
    raw = deps.readSeed ? deps.readSeed() : null
  } catch {
    return { imported: 0, version: 0, reason: 'unreadable' }
  }
  if (!raw) return { imported: 0, version: 0, reason: 'no_seed' }

  let text: string
  try {
    text = gunzipSync(unwrapResourceBytes(raw)).toString('utf8')
  } catch {
    return { imported: 0, version: 0, reason: 'bad_gzip' }
  }

  const parsed = parseBundleBody(text)
  if (!parsed || parsed.entries.length === 0) {
    return { imported: 0, version: 0, reason: 'malformed' }
  }

  applyBundle(db, parsed.entries, parsed.version, {
    replace: true,
    nowMs: deps.now ? deps.now() : Date.now(),
  })

  return {
    imported: parsed.entries.length,
    version: parsed.version,
    reason: 'seeded',
  }
}

/** Read the shipped seed file, or null when it is not present. */
export function readSeedFile(path: string | null): Buffer | null {
  if (!path) return null
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}
