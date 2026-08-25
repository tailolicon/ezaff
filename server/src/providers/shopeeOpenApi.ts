import type {
  OwnerLinkProvider,
  OwnerLinkRequest,
  ProviderResult,
} from '../types'

/**
 * Shopee Affiliate Open API endpoint (Vietnam).
 * @see https://open-api.affiliate.shopee.vn/graphql
 */
export const SHOPEE_GRAPHQL_URL =
  'https://open-api.affiliate.shopee.vn/graphql'

/**
 * Build a product origin URL for generateShortLink.
 * Prefer product path form which does not need the SEO slug.
 */
export function buildShopeeOriginUrl(req: OwnerLinkRequest): string {
  return `https://shopee.vn/product/${req.shopId}/${req.itemId}`
}

/**
 * GraphQL mutation body for generateShortLink.
 */
export function buildGenerateShortLinkPayload(originUrl: string): string {
  // Compact single-line body so the signature payload is deterministic.
  const query =
    `mutation{generateShortLink(input:{originUrl:"${escapeGraphqlString(originUrl)}"}){shortLink}}`
  return JSON.stringify({ query })
}

function escapeGraphqlString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Shopee Affiliate Open API auth signature.
 *
 * Documented scheme (community / official examples):
 *   factor    = appId + timestamp + payload + secret
 *   signature = hex(SHA256(factor))
 *   Authorization: SHA256 Credential={appId}, Timestamp={timestamp}, Signature={signature}
 *
 * ⚠ UNVERIFIED until real SHOPEE_APP_ID + SHOPEE_SECRET credentials are available.
 * Do not treat this as production-certified; re-validate against Shopee docs when enabling.
 */
export async function computeShopeeSignature(
  appId: string,
  secret: string,
  timestamp: number,
  payload: string,
): Promise<string> {
  const factor = `${appId}${timestamp}${payload}${secret}`
  const data = new TextEncoder().encode(factor)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return bufferToHex(digest)
}

function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0')
  }
  return hex
}

export function buildAuthorizationHeader(
  appId: string,
  timestamp: number,
  signature: string,
): string {
  return `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`
}

export function isShopeeOpenApiEnabled(env: {
  SHOPEE_APP_ID?: string
  SHOPEE_SECRET?: string
}): boolean {
  const id = env.SHOPEE_APP_ID?.trim()
  const secret = env.SHOPEE_SECRET?.trim()
  return Boolean(id && secret)
}

/**
 * Calls Shopee Affiliate Open API generateShortLink.
 * DISABLED (returns null immediately) unless both SHOPEE_APP_ID and SHOPEE_SECRET exist.
 * Never hardcodes credentials.
 */
export const shopeeOpenApiProvider: OwnerLinkProvider = {
  name: 'shopee_open_api',
  async resolve(req, ctx): Promise<ProviderResult | null> {
    if (!isShopeeOpenApiEnabled(ctx.env)) {
      // Stay disabled — fall through to mapping / passthrough.
      return null
    }

    // Only meaningful for Shopee product identifiers.
    if (req.platform.toLowerCase() !== 'shopee') {
      return null
    }
    if (!req.shopId || !req.itemId) {
      return null
    }

    const appId = ctx.env.SHOPEE_APP_ID!.trim()
    const secret = ctx.env.SHOPEE_SECRET!.trim()
    const now = ctx.now ?? (() => Date.now())
    // Shopee examples use Unix seconds for Timestamp.
    const timestamp = Math.floor(now() / 1000)
    const originUrl = buildShopeeOriginUrl(req)
    const payload = buildGenerateShortLinkPayload(originUrl)
    const signature = await computeShopeeSignature(
      appId,
      secret,
      timestamp,
      payload,
    )
    const authorization = buildAuthorizationHeader(appId, timestamp, signature)

    const fetchImpl = ctx.fetchImpl ?? fetch
    try {
      const res = await fetchImpl(SHOPEE_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authorization,
        },
        body: payload,
      })
      if (!res.ok) {
        return null
      }
      const json = (await res.json()) as {
        data?: { generateShortLink?: { shortLink?: string | null } }
        errors?: unknown
      }
      const shortLink = json.data?.generateShortLink?.shortLink
      if (typeof shortLink === 'string' && shortLink.trim() !== '') {
        return { ownerUrl: shortLink.trim(), source: 'shopee_open_api' }
      }
      return null
    } catch {
      // Network / parse errors → fall through; app never fails copy.
      return null
    }
  },
}
