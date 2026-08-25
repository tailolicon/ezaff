/**
 * ezaff owner-link Cloudflare Worker.
 *
 * POST /v1/owner-link — resolve author affiliate URL for a product.
 * Privacy: request body must never include a user affiliate link.
 * Credentials: Shopee secrets only via env (SHOPEE_APP_ID, SHOPEE_SECRET).
 */

import { Hono } from 'hono'
import { buildBundleResponse, readBundleMeta } from './bundle'
import { readChunked } from './chunk'
import { concatMetaSegments } from './meta'
import { getCachedOwnerLink, putCachedOwnerLink } from './cache'
import { runProviderChain } from './providers/chain'
import { checkRateLimit } from './rateLimit'
import { ownerLinkRequestSchema, wantRequestSchema } from './schema'
import type { Env, OwnerLinkResponse } from './types'
import { recordWant } from './want'

const app = new Hono<{ Bindings: Env }>()

/**
 * Edge cache for bundle responses. Bodies are immutable for a given
 * (since, version) pair, so most syncs never reach KV at all.
 */
const BUNDLE_CACHE_SECONDS = 300

/** KV keys for the metadata bundle, mirroring the link bundle's layout. */
const META_META_KEY = 'meta:meta'
const META_FULL_PREFIX = 'meta:full'

app.get('/', (c) =>
  c.json({
    service: 'ezaff-owner-link',
    endpoints: [
      'POST /v1/owner-link',
      'GET /v1/bundle?since=<version>',
      'GET /v1/meta?since=<version>',
      'POST /v1/want',
    ],
  }),
)

app.get('/health', (c) => c.json({ ok: true }))

/**
 * GET /v1/bundle?since=<version>
 *
 * 200 — packed table (full snapshot or delta), `X-Bundle-Version` header
 * 204 — client already current
 *
 * Sends no request body and takes no install id: the bundle is identical for
 * every client, which is what makes it cacheable at the edge and what keeps
 * product ids from leaving the user's machine on this path.
 */
app.get('/v1/bundle', async (c) => {
  const raw = c.req.query('since') ?? '0'
  const since = Number(raw)
  if (!Number.isInteger(since) || since < 0) {
    return c.json({ error: 'since must be a non-negative integer' }, 400)
  }

  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default
  const cacheKey = new Request(
    new URL(`/v1/bundle?since=${since}`, c.req.url).toString(),
    { method: 'GET' },
  )

  if (cache) {
    const hit = await cache.match(cacheKey)
    if (hit) return hit
  }

  const result = await buildBundleResponse(c.env.OWNER_KV, since)

  let response: Response
  if (result.kind === 'up_to_date' || result.kind === 'empty') {
    response = new Response(null, {
      status: 204,
      headers: {
        'X-Bundle-Version': String(result.version),
        'Cache-Control': `public, max-age=${BUNDLE_CACHE_SECONDS}`,
      },
    })
  } else {
    response = new Response(result.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Bundle-Version': String(result.version),
        'X-Bundle-Kind': result.kind,
        'Cache-Control': `public, max-age=${BUNDLE_CACHE_SECONDS}`,
      },
    })
  }

  if (cache) {
    c.executionCtx?.waitUntil(cache.put(cacheKey, response.clone()))
  }
  return response
})

/**
 * GET /v1/meta?since=<version>
 *
 * Product metadata: name, price, rating, sold, commission. Optional by
 * design — a client that never fetches this still works, it just scrapes as
 * before. Chunked in KV because the payload is far past a single 25 MB value.
 */
app.get('/v1/meta', async (c) => {
  const since = Number(c.req.query('since') ?? '0')
  if (!Number.isInteger(since) || since < 0) {
    return c.json({ error: 'since must be a non-negative integer' }, 400)
  }

  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default
  const cacheKey = new Request(
    new URL(`/v1/meta?since=${since}`, c.req.url).toString(),
    { method: 'GET' },
  )
  if (cache) {
    const hit = await cache.match(cacheKey)
    if (hit) return hit
  }

  const meta = await readBundleMeta(c.env.OWNER_KV, META_META_KEY)
  let response: Response

  if (meta.version === 0 || since >= meta.version) {
    response = new Response(null, {
      status: 204,
      headers: {
        'X-Meta-Version': String(meta.version),
        'Cache-Control': `public, max-age=${BUNDLE_CACHE_SECONDS}`,
      },
    })
  } else {
    const needed = meta.segments.filter((v) => v > since)
    const oldest = meta.segments[0]
    const canDelta =
      since > 0 && needed.length > 0 && oldest !== undefined && oldest <= since + 1

    let body: string | null = null
    let kind = 'full'

    if (canDelta) {
      const parts = await Promise.all(
        needed.map((v) => readChunked(c.env.OWNER_KV, `meta:seg:${v}`)),
      )
      if (parts.every((p): p is string => typeof p === 'string')) {
        body = concatMetaSegments(parts, meta.version)
        kind = 'delta'
      }
    }
    if (body == null) {
      body = await readChunked(c.env.OWNER_KV, META_FULL_PREFIX)
    }

    response =
      body == null
        ? new Response(null, {
            status: 204,
            headers: { 'X-Meta-Version': String(meta.version) },
          })
        : new Response(body, {
            status: 200,
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              'X-Meta-Version': String(meta.version),
              'X-Meta-Kind': kind,
              'Cache-Control': `public, max-age=${BUNDLE_CACHE_SECONDS}`,
            },
          })
  }

  if (cache) c.executionCtx?.waitUntil(cache.put(cacheKey, response.clone()))
  return response
})

/**
 * POST /v1/want — one batched report of products the client's bundle lacks.
 *
 * Fire-and-forget by design: there is no answer to give here. The client gets
 * what it asked for in a later bundle sync, which is a channel it already
 * runs. Adding a response would mean holding a request open across a
 * generation step that happens hours later on a different machine.
 */
app.post('/v1/want', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const parsed = wantRequestSchema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      400,
    )
  }

  const { installId, missing } = parsed.data

  // Same limiter as owner-link, keyed on installId only.
  const rl = await checkRateLimit(c.env, installId)
  if (!rl.allowed) return c.body(null, 429)

  if (missing.length === 0) return c.body(null, 204)

  try {
    await recordWant(c.env.OWNER_KV, installId, missing, Date.now())
  } catch {
    // A dropped report costs one day of telemetry, nothing the user can see.
    return c.body(null, 204)
  }

  return c.body(null, 204)
})

app.post('/v1/owner-link', async (c) => {
  // Parse body once; do not log it.
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const parsed = ownerLinkRequestSchema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      400,
    )
  }

  const req = parsed.data
  const env = c.env

  // Rate limit by installId only (no product fields stored in RL keys).
  const rl = await checkRateLimit(env, req.installId)
  if (!rl.allowed) {
    const response: OwnerLinkResponse = {
      ownerUrl: null,
      source: 'rate_limited',
    }
    return c.json(response)
  }

  // KV response cache (30 day TTL for successful hits).
  const cached = await getCachedOwnerLink(env, req)
  if (cached) {
    return c.json(cached satisfies OwnerLinkResponse)
  }

  const result = await runProviderChain(req, { env })

  if (result.ownerUrl) {
    // Best-effort cache; ignore write failures so the response still returns.
    try {
      await putCachedOwnerLink(env, req, result.ownerUrl)
    } catch {
      // no-op
    }
  }

  const response: OwnerLinkResponse = {
    ownerUrl: result.ownerUrl,
    source: result.source,
  }
  return c.json(response)
})

export default app
