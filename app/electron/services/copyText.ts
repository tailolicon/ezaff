/**
 * Copy path entry point.
 *
 * Affiliate URL selection lives in `copyResolver.ts`. This module builds the
 * final clipboard string and records copy_events.
 */

import type Database from 'better-sqlite3'
import { getProductById } from '../db/repositories/productRepo'
import {
  getDefaultTemplate,
  getTemplateById,
  type Template,
} from '../db/repositories/templateRepo'
import {
  recordCopyEvent,
  resolveAffiliateLink as resolveAffiliateLinkCore,
  type CopyResolverDeps,
  type ResolveAffiliateLinkResult,
} from './copyResolver'
import { renderTemplate } from './templateRenderer'

/** Special template id meaning "copy raw link only" (no invitation sentence). */
export const LINK_ONLY_TEMPLATE_ID = '__link_only__'

export type CopyTextResult = {
  /** Final clipboard string. */
  text: string
  /** Product display name for toasts — never the raw affiliate link. */
  productName: string
  productId: string
  templateId: string | null
  usedOwner: boolean
  reason: string
}

export type { ResolveAffiliateLinkResult }

/**
 * Resolve which affiliate URL to put in the clipboard.
 * Delegates entirely to copyResolver (FR-10).
 */
export async function resolveAffiliateLink(
  db: Database.Database,
  product: {
    id: string
    original_url: string
    platform: string
    shop_id: string | null
    item_id: string | null
    canonical_key: string
  },
  deps?: CopyResolverDeps,
): Promise<ResolveAffiliateLinkResult> {
  return resolveAffiliateLinkCore(db, product, deps)
}

function productDisplayName(title: string | null | undefined): string {
  const t = title?.trim()
  return t || 'Sản phẩm chưa có tên'
}

function resolveTemplate(
  db: Database.Database,
  templateId: string | null | undefined,
): Template | null {
  if (templateId === LINK_ONLY_TEMPLATE_ID || templateId === null) {
    return null
  }
  if (templateId === undefined || templateId === '') {
    return getDefaultTemplate(db)
  }
  const t = getTemplateById(db, templateId)
  if (!t) {
    throw new Error('Không tìm thấy mẫu câu mời')
  }
  return t
}

/**
 * Build the final copy string for a product + optional template.
 * Never throws because of network; only throws for missing product/template.
 */
export async function buildCopyText(
  db: Database.Database,
  productId: string,
  templateId?: string | null,
  deps?: CopyResolverDeps,
): Promise<CopyTextResult> {
  const product = getProductById(db, productId)
  if (!product) {
    throw new Error('Không tìm thấy sản phẩm')
  }

  const productName = productDisplayName(product.title)
  const template = resolveTemplate(db, templateId)

  const linkResult = await resolveAffiliateLink(db, product, deps)

  let text: string
  if (template === null && (templateId === LINK_ONLY_TEMPLATE_ID || templateId === null)) {
    text = linkResult.url
  } else if (template === null) {
    text = linkResult.url
  } else {
    text = renderTemplate(template.content, {
      link: linkResult.url,
      ten: product.title,
      gia: product.price,
      shop: product.shop_name,
      danhgia: product.rating,
      daban: product.sold,
    })
  }

  const resolvedTemplateId = template?.id ?? null
  recordCopyEvent(db, {
    productId: product.id,
    templateId: resolvedTemplateId,
    usedOwner: linkResult.usedOwner,
    reason: linkResult.reason,
  })

  return {
    text,
    productName,
    productId: product.id,
    templateId: resolvedTemplateId,
    usedOwner: linkResult.usedOwner,
    reason: linkResult.reason,
  }
}
