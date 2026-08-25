import { z } from 'zod'

/**
 * POST /v1/owner-link body.
 * ONLY these four fields — never accept or forward a user affiliate URL.
 */
export const ownerLinkRequestSchema = z.object({
  platform: z.string().min(1).max(64),
  itemId: z.string().max(128),
  shopId: z.string().max(128),
  installId: z.string().min(1).max(128),
})

export type OwnerLinkRequestBody = z.infer<typeof ownerLinkRequestSchema>

/** Keys allowed in the request body (asserted by client tests). */
export const OWNER_LINK_REQUEST_KEYS = [
  'platform',
  'itemId',
  'shopId',
  'installId',
] as const

/**
 * Most ids one client may report in a day.
 *
 * Bounds the KV value and the request body. A user with more misses than this
 * reports the rest tomorrow — the ranking only needs to know what is popular,
 * and a long tail truncated at 5k does not change which products win.
 */
export const WANT_MAX_IDS = 5000

/**
 * POST /v1/want body.
 *
 * `missing` carries "shopId:itemId" pairs only — no titles, no URLs, no
 * categories. That is the entire product identity the generator needs, and
 * nothing else about the user's library should leave their machine.
 */
export const wantRequestSchema = z.object({
  installId: z.string().min(1).max(128),
  missing: z
    .array(z.string().regex(/^\d{1,20}:\d{1,20}$/))
    .max(WANT_MAX_IDS),
})

export type WantRequestBody = z.infer<typeof wantRequestSchema>
