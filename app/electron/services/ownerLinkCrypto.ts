/**
 * Seal owner affiliate URLs before writing to SQLite owner_link_cache.
 * Prevents casual DB browsing (DB Browser for SQLite) from revealing owner links.
 *
 * Key is derived from installId + app salt (scrypt). Not DRM against a reverse
 * engineer who extracts this code — raises the bar for casual inspection.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto'

const ALGO = 'aes-256-gcm'
const PREFIX = 'e1:' // versioned sealed blob
const SALT = 'ezaff-owner-cache-v1'

let key: Buffer | null = null

/** Call once after license init (installId known). */
export function initOwnerLinkCrypto(installId: string): void {
  if (!installId || typeof installId !== 'string') {
    key = null
    return
  }
  try {
    key = scryptSync(installId, SALT, 32)
  } catch {
    key = null
  }
}

export function isOwnerLinkCryptoReady(): boolean {
  return key !== null && key.length === 32
}

/** Encrypt plaintext URL → sealed string for DB. Plain passthrough if no key. */
export function sealOwnerUrl(plainUrl: string): string {
  if (!plainUrl) return plainUrl
  if (!key) return plainUrl
  try {
    const iv = randomBytes(12)
    const cipher = createCipheriv(ALGO, key, iv)
    const enc = Buffer.concat([
      cipher.update(plainUrl, 'utf8'),
      cipher.final(),
    ])
    const tag = cipher.getAuthTag()
    return (
      PREFIX +
      Buffer.concat([iv, tag, enc]).toString('base64url')
    )
  } catch {
    return plainUrl
  }
}

/** Decrypt sealed blob → plaintext URL, or null if invalid. */
export function openOwnerUrl(stored: string): string | null {
  if (stored == null || stored === '') return null
  if (!stored.startsWith(PREFIX)) {
    // Legacy plaintext row (pre-hardening) — still usable
    return stored
  }
  if (!key) return null
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64url')
    if (raw.length < 12 + 16 + 1) return null
    const iv = raw.subarray(0, 12)
    const tag = raw.subarray(12, 28)
    const data = raw.subarray(28)
    const decipher = createDecipheriv(ALGO, key, iv)
    decipher.setAuthTag(tag)
    const dec = Buffer.concat([decipher.update(data), decipher.final()])
    return dec.toString('utf8')
  } catch {
    return null
  }
}

/** Reset for tests. */
export function resetOwnerLinkCryptoForTests(): void {
  key = null
}
