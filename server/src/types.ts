/**
 * Shared types for the owner-link Worker.
 * Request body intentionally excludes any user affiliate URL (privacy invariant).
 */

export type OwnerLinkRequest = {
  platform: string
  itemId: string
  shopId: string
  installId: string
}

export type OwnerLinkResponse = {
  ownerUrl: string | null
  source: string
}

export type ProviderResult = {
  ownerUrl: string | null
  source: string
}

export type ProviderContext = {
  env: Env
  /** Optional fetch override (tests). */
  fetchImpl?: typeof fetch
  /** Optional clock override (tests). */
  now?: () => number
}

/** Cloudflare Worker bindings. */
export type Env = {
  OWNER_KV: KVNamespace
  SHOPEE_APP_ID?: string
  SHOPEE_SECRET?: string
  ENVIRONMENT?: string
}

export type OwnerLinkProvider = {
  name: string
  /**
   * Resolve an owner affiliate URL for the product.
   * Return null ownerUrl to fall through to the next provider.
   */
  resolve: (
    req: OwnerLinkRequest,
    ctx: ProviderContext,
  ) => Promise<ProviderResult | null>
}
