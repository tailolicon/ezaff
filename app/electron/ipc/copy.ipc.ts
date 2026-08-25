import { clipboard } from 'electron'
import { z } from 'zod'
import { getDatabase } from '../db/connection'
import {
  buildCopyText,
  LINK_ONLY_TEMPLATE_ID,
  type CopyTextResult,
} from '../services/copyText'
import { registerHandler } from './registry'

/**
 * templateId:
 * - omitted / undefined → use default template
 * - null or LINK_ONLY_TEMPLATE_ID → copy raw affiliate link only
 * - uuid → use that template
 */
const copySchema = z.object({
  productId: z.string().uuid('ID sản phẩm không hợp lệ'),
  templateId: z
    .union([
      z.string().uuid('ID mẫu không hợp lệ'),
      z.literal(LINK_ONLY_TEMPLATE_ID),
      z.null(),
    ])
    .optional(),
})

/** Bulk copy — same anti-circumvention rules, one clipboard write. */
const copyManySchema = z.object({
  productIds: z
    .array(z.string().uuid('ID sản phẩm không hợp lệ'))
    .min(1, 'Chưa chọn sản phẩm nào'),
  templateId: z
    .union([
      z.string().uuid('ID mẫu không hợp lệ'),
      z.literal(LINK_ONLY_TEMPLATE_ID),
      z.null(),
    ])
    .optional(),
})

/**
 * Renderer-facing copy result.
 * NEVER includes clipboard text, usedOwner, or reason — those are main-only.
 */
export type CopyIpcResult = {
  productName: string
  productId: string
  templateId: string | null
  /** Always false — kept for API shape; never trust from UI. */
  usedOwner: boolean
  /** Always opaque — never real reason codes. */
  reason: string
}

/** Bulk result — counts only, never the clipboard payload. */
export type CopyManyIpcResult = {
  copied: number
  failed: number
  templateId: string | null
}

export function registerCopyHandlers(): void {
  registerHandler<z.infer<typeof copySchema>, CopyIpcResult>(
    'copy:product',
    copySchema,
    async (_event, input) => {
      const result: CopyTextResult = await buildCopyText(
        getDatabase(),
        input.productId,
        input.templateId === undefined ? undefined : input.templateId,
      )

      // Clipboard write happens in main process only.
      clipboard.writeText(result.text)

      // Anti-circumvention (hard):
      // - Do NOT return result.text (would leak owner shortlink to renderer/devtools)
      // - Do NOT return real usedOwner / reason
      return {
        productName: result.productName,
        productId: result.productId,
        templateId: result.templateId,
        usedOwner: false,
        reason: 'ok',
      }
    },
  )

  /**
   * Copy many products at once ("Sao chép hàng loạt" in the bulk bar).
   * Blocks are joined by a blank line; one clipboard write for the batch.
   */
  registerHandler<z.infer<typeof copyManySchema>, CopyManyIpcResult>(
    'copy:products',
    copyManySchema,
    async (_event, input) => {
      const db = getDatabase()
      const blocks: string[] = []
      let failed = 0
      let templateId: string | null = null

      for (const productId of input.productIds) {
        try {
          const result = await buildCopyText(
            db,
            productId,
            input.templateId === undefined ? undefined : input.templateId,
          )
          blocks.push(result.text)
          templateId = result.templateId
        } catch {
          failed += 1
        }
      }

      if (blocks.length === 0) {
        throw new Error('Không sao chép được sản phẩm nào đã chọn.')
      }

      clipboard.writeText(blocks.join('\n\n'))

      return { copied: blocks.length, failed, templateId }
    },
  )
}
