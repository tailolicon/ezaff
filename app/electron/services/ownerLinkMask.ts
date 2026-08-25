/**
 * Cheap reversible wrap for bundle rows stored in SQLite.
 *
 * AES-GCM on 130k inserts is too slow for first-run seed. XOR + base64url
 * is enough that opening the DB in a browser no longer shows raw shortlinks.
 * Legacy plaintext rows (no prefix) still read back unchanged.
 */

import { randomBytes } from 'node:crypto'

const PREFIX = 'b1:'
const KEY = Buffer.from([
  0x3d, 0x91, 0x4a, 0xe7, 0x12, 0x6b, 0xc8, 0x5f, 0x20, 0xaa, 0x77, 0x04,
])

function xor(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length)
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i]! ^ KEY[i % KEY.length]!
  }
  return out
}

export function packStoreValue(plain: string): string {
  if (!plain) return plain
  if (plain.startsWith(PREFIX)) return plain
  return PREFIX + xor(Buffer.from(plain, 'utf8')).toString('base64url')
}

export function unpackStoreValue(stored: string | null | undefined): string | null {
  if (stored == null || stored === '') return null
  if (!stored.startsWith(PREFIX)) return stored
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64url')
    if (raw.length === 0) return null
    return xor(raw).toString('utf8')
  } catch {
    return null
  }
}

export function isPackedStoreValue(stored: string): boolean {
  return typeof stored === 'string' && stored.startsWith(PREFIX)
}

/** Same key as scripts/refresh-seed.mjs — wrap the shipped extraResource. */
const RES_KEY = Buffer.from([
  0x6c, 0x2b, 0x9e, 0x41, 0xd0, 0x17, 0x88, 0x53, 0xfa, 0x0c, 0x31, 0xb4,
])

function xorResource(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length)
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i]! ^ RES_KEY[i % RES_KEY.length]!
  }
  return out
}

export function wrapResourceBytes(gz: Buffer): Buffer {
  const nonce = randomBytes(16)
  const out = Buffer.allocUnsafe(16 + gz.length)
  nonce.copy(out, 0)
  for (let i = 0; i < gz.length; i++) {
    out[16 + i] =
      gz[i]! ^ RES_KEY[i % RES_KEY.length]! ^ nonce[i % 16]!
  }
  return out
}

function looksGzip(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b
}

/** Undo wrapResourceBytes. Bare gzip (1f 8b) and older XOR-only wraps still work. */
export function unwrapResourceBytes(raw: Buffer): Buffer {
  if (looksGzip(raw)) return raw

  if (raw.length > 16) {
    const nonce = raw.subarray(0, 16)
    const body = raw.subarray(16)
    const out = Buffer.allocUnsafe(body.length)
    for (let i = 0; i < body.length; i++) {
      out[i] = body[i]! ^ RES_KEY[i % RES_KEY.length]! ^ nonce[i % 16]!
    }
    if (looksGzip(out)) return out
  }

  return xorResource(raw)
}
