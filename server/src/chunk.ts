/**
 * Chunked KV storage for payloads larger than one value can hold.
 *
 * A single KV value tops out at 25 MB. The link bundle is 4.45 MB at 132k
 * mappings and would hit that ceiling around 761k; the metadata bundle is
 * already 33.8 MB and does not fit at all. Both therefore have to be split.
 *
 * Layout: `<prefix>:0`, `<prefix>:1`, … plus a `<prefix>:count` key holding
 * how many parts there are. Reading joins them back in order.
 *
 * Chunks are split on line boundaries, never mid-record — a reader that
 * receives parts out of order or misses one must fail loudly rather than
 * silently hand back a half-parsed record.
 */

/** Well under the 25 MB hard cap, leaving room for KV metadata overhead. */
export const MAX_CHUNK_BYTES = 20 * 1024 * 1024

export const chunkCountKey = (prefix: string): string => `${prefix}:count`
export const chunkKey = (prefix: string, index: number): string =>
  `${prefix}:${index}`

/**
 * Split text into chunks no larger than `maxBytes`, breaking only at
 * newlines. A single line longer than the limit is kept whole rather than
 * cut — a truncated record is worse than an oversized chunk, and the caller
 * finds out via the returned size.
 */
export function splitIntoChunks(
  text: string,
  maxBytes: number = MAX_CHUNK_BYTES,
): string[] {
  const encoder = new TextEncoder()
  if (encoder.encode(text).length <= maxBytes) return [text]

  const chunks: string[] = []
  let current = ''
  let currentBytes = 0

  /*
   * Rebuild each line with its own terminator so joining the chunks gives
   * back the input byte for byte. Splitting on '\n' leaves a trailing empty
   * element whenever the text ends with a newline; appending '\n' to that
   * one would add a blank line to every payload.
   */
  const pieces = text.split('\n')
  for (let i = 0; i < pieces.length; i++) {
    const isLast = i === pieces.length - 1
    if (isLast && pieces[i] === '') break
    const piece = isLast ? (pieces[i] as string) : `${pieces[i]}\n`
    const bytes = encoder.encode(piece).length

    if (currentBytes > 0 && currentBytes + bytes > maxBytes) {
      chunks.push(current)
      current = ''
      currentBytes = 0
    }
    current += piece
    currentBytes += bytes
  }

  if (current !== '') chunks.push(current)
  return chunks
}

/**
 * Read every chunk under `prefix` and join them.
 *
 * Returns null when the count key is missing or any part is absent — a gap
 * means the upload was interrupted, and serving the surviving parts would
 * look like a complete-but-shorter bundle to every client.
 */
export async function readChunked(
  kv: KVNamespace,
  prefix: string,
): Promise<string | null> {
  const rawCount = await kv.get(chunkCountKey(prefix))
  if (rawCount == null) return null

  const count = Number(rawCount)
  if (!Number.isInteger(count) || count < 1 || count > 1000) return null

  const parts = await Promise.all(
    Array.from({ length: count }, (_, i) => kv.get(chunkKey(prefix, i))),
  )
  if (parts.some((p) => p == null)) return null

  return parts.join('')
}

/** The KV entries a chunked payload becomes — for bulk-put files. */
export function chunkEntries(
  prefix: string,
  text: string,
  maxBytes: number = MAX_CHUNK_BYTES,
): Array<{ key: string; value: string }> {
  const chunks = splitIntoChunks(text, maxBytes)
  return [
    ...chunks.map((value, i) => ({ key: chunkKey(prefix, i), value })),
    { key: chunkCountKey(prefix), value: String(chunks.length) },
  ]
}
