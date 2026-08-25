import type { OwnerLinkProvider, OwnerLinkRequest } from '../types'

/** KV key seeded manually by the app author. */
export function mappingKey(req: OwnerLinkRequest): string {
  return `owner:${req.platform}:${req.shopId}:${req.itemId}`
}

/**
 * Lookup author-seeded owner affiliate URLs in KV.
 * Key format: owner:{platform}:{shopId}:{itemId}
 */
export const mappingTableProvider: OwnerLinkProvider = {
  name: 'mapping_table',
  async resolve(req, ctx) {
    const key = mappingKey(req)
    const value = await ctx.env.OWNER_KV.get(key)
    if (value == null || value.trim() === '') {
      return null
    }
    return { ownerUrl: value.trim(), source: 'mapping_table' }
  },
}
