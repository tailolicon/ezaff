/**
 * Download product images into userData/images/<sha256>.jpg for offline display.
 * Returns the absolute local path, or null on failure (never throws to callers
 * of the scrape pipeline — image cache is best-effort).
 */

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, access } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { BROWSER_USER_AGENT } from './urlNormalizer'
import { logWarn } from '../../services/log'

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}

function pickExtension(url: string, contentType: string | null): string {
  const fromType = (contentType ?? '').toLowerCase()
  if (fromType.includes('png')) return '.png'
  if (fromType.includes('webp')) return '.webp'
  if (fromType.includes('gif')) return '.gif'
  if (fromType.includes('jpeg') || fromType.includes('jpg')) return '.jpg'

  try {
    const pathExt = extname(new URL(url).pathname).toLowerCase()
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(pathExt)) {
      return pathExt === '.jpeg' ? '.jpg' : pathExt
    }
  } catch {
    // ignore
  }
  return '.jpg'
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve images directory under Electron userData.
 * Injectable for tests.
 */
export function getImagesDir(userDataPath?: string): string {
  if (userDataPath) {
    return join(userDataPath, 'images')
  }
  // Dynamic import not usable synchronously here — use require only when
  // running inside Electron main (production scrape path).
  // vitest never hits this branch if userDataPath is provided.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as typeof import('electron')
  return join(electron.app.getPath('userData'), 'images')
}

export type CacheImageOptions = {
  /** Override userData root (tests). */
  userDataPath?: string
  /** Custom fetcher (tests). */
  fetchFn?: (url: string) => Promise<{
    ok: boolean
    contentType: string | null
    body: Buffer
  }>
}

async function defaultFetch(
  url: string,
): Promise<{ ok: boolean; contentType: string | null; body: Buffer }> {
  try {
    const { net } = await import('electron')
    const response = await net.fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    })
    if (!response.ok) {
      return { ok: false, contentType: null, body: Buffer.alloc(0) }
    }
    const contentType = response.headers.get('content-type')
    const ab = await response.arrayBuffer()
    return {
      ok: true,
      contentType,
      body: Buffer.from(ab),
    }
  } catch {
    // Node fallback (dev / tests without electron net)
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': BROWSER_USER_AGENT },
        redirect: 'follow',
      })
      if (!response.ok) {
        return { ok: false, contentType: null, body: Buffer.alloc(0) }
      }
      const contentType = response.headers.get('content-type')
      const ab = await response.arrayBuffer()
      return {
        ok: true,
        contentType,
        body: Buffer.from(ab),
      }
    } catch {
      return { ok: false, contentType: null, body: Buffer.alloc(0) }
    }
  }
}

/**
 * Download `imageUrl` into userData/images/<sha256>.jpg (or matching ext).
 * Reuses existing file when present. Returns absolute local path or null.
 */
export async function cacheImage(
  imageUrl: string,
  options: CacheImageOptions = {},
): Promise<string | null> {
  const trimmed = imageUrl?.trim()
  if (!trimmed) return null

  try {
    void new URL(trimmed)
  } catch {
    return null
  }

  try {
    const dir = getImagesDir(options.userDataPath)
    await mkdir(dir, { recursive: true })

    const digest = hashUrl(trimmed)
    // Spec: userData/images/<sha256>.jpg — use .jpg as default name; if we
    // detect another type after fetch we still prefer .jpg when content is jpeg.
    // Probe for any already-cached extension first.
    for (const ext of ['.jpg', '.png', '.webp', '.gif']) {
      const candidate = join(dir, `${digest}${ext}`)
      if (await fileExists(candidate)) {
        return candidate
      }
    }

    const fetchFn = options.fetchFn ?? defaultFetch
    const result = await fetchFn(trimmed)
    if (!result.ok || result.body.length === 0) {
      return null
    }

    const ext = pickExtension(trimmed, result.contentType)
    // Spec asks for <sha256>.jpg — keep .jpg when possible.
    const finalExt = ext === '.jpeg' ? '.jpg' : ext
    const localPath = join(dir, `${digest}${finalExt}`)

    await pipeline(Readable.from(result.body), createWriteStream(localPath))
    return localPath
  } catch (err) {
    logWarn('[ezaff] cacheImage failed:', err)
    return null
  }
}

export type SaveImageBufferOptions = {
  /** Override userData root (tests). */
  userDataPath?: string
  /** File extension including dot, e.g. '.png'. Default '.png'. */
  ext?: string
  /** Optional seed for hash (defaults to buffer content). */
  seed?: string
}

/**
 * Save a raw image buffer into the image cache directory (clipboard paste).
 * Returns absolute local path or null.
 */
export async function saveImageBuffer(
  body: Buffer,
  options: SaveImageBufferOptions = {},
): Promise<string | null> {
  if (!body || body.length === 0) return null
  try {
    const dir = getImagesDir(options.userDataPath)
    await mkdir(dir, { recursive: true })

    const seed = options.seed ?? body.toString('base64').slice(0, 256)
    const digest = createHash('sha256')
      .update(seed)
      .update(body.subarray(0, Math.min(body.length, 64 * 1024)))
      .digest('hex')
    const ext =
      options.ext === '.jpeg'
        ? '.jpg'
        : options.ext && options.ext.startsWith('.')
          ? options.ext
          : '.png'
    const localPath = join(dir, `${digest}${ext}`)

    if (await fileExists(localPath)) {
      return localPath
    }

    await pipeline(Readable.from(body), createWriteStream(localPath))
    return localPath
  } catch (err) {
    logWarn('[ezaff] saveImageBuffer failed:', err)
    return null
  }
}

/**
 * Read an image from the system clipboard (Electron clipboard.readImage)
 * and save it into the image cache directory. Returns local path or null.
 */
export async function saveClipboardImage(
  options: SaveImageBufferOptions = {},
): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { clipboard } = require('electron') as typeof import('electron')
    const img = clipboard.readImage()
    if (!img || img.isEmpty()) {
      // Also accept image URL text on clipboard
      const text = clipboard.readText()?.trim()
      if (text && isPasteableImageUrl(text)) {
        return cacheImage(text, { userDataPath: options.userDataPath })
      }
      return null
    }
    const png = img.toPNG()
    if (!png || png.length === 0) {
      const jpeg = img.toJPEG(90)
      if (jpeg && jpeg.length > 0) {
        return saveImageBuffer(Buffer.from(jpeg), {
          ...options,
          ext: '.jpg',
          seed: options.seed ?? `clipboard-jpeg-${Date.now()}`,
        })
      }
      return null
    }
    return saveImageBuffer(Buffer.from(png), {
      ...options,
      ext: '.png',
      seed: options.seed ?? `clipboard-png-${Date.now()}`,
    })
  } catch (err) {
    logWarn('[ezaff] saveClipboardImage failed:', err)
    return null
  }
}

/**
 * Copy an image the user picked from disk into the cache directory, so the
 * product keeps working even if the original file is moved or deleted.
 */
export async function importImageFile(
  sourcePath: string,
  options: SaveImageBufferOptions = {},
): Promise<string | null> {
  const trimmed = sourcePath?.trim()
  if (!trimmed) return null
  try {
    const { readFile } = await import('node:fs/promises')
    const body = await readFile(trimmed)
    const ext = extname(trimmed).toLowerCase()
    const known = ['.jpg', '.jpeg', '.png', '.webp', '.gif']
    return saveImageBuffer(body, {
      ...options,
      ext: known.includes(ext) ? ext : '.png',
      seed: options.seed ?? `file-${trimmed}`,
    })
  } catch (err) {
    logWarn('[ezaff] importImageFile failed:', err)
    return null
  }
}

/** Pure helper for tests: decide if clipboard text is a pasteable image URL. */
export function isPasteableImageUrl(text: string | null | undefined): boolean {
  if (!text?.trim()) return false
  try {
    const u = new URL(text.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    return true
  } catch {
    return false
  }
}
