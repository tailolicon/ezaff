import { z } from 'zod'
import { getDatabase } from '../db/connection'
import {
  createTemplate,
  deleteTemplate,
  getDefaultTemplate,
  listTemplates,
  setDefaultTemplate,
  updateTemplate,
  type Template,
} from '../db/repositories/templateRepo'
import { listProducts } from '../db/repositories/productRepo'
import { renderTemplate } from '../services/templateRenderer'
import { registerHandler } from './registry'

const createSchema = z.object({
  name: z.string().trim().min(1, 'Tên mẫu không được để trống'),
  content: z.string().trim().min(1, 'Nội dung mẫu không được để trống'),
  is_default: z.boolean().optional(),
})

const updateSchema = z.object({
  id: z.string().uuid('ID mẫu không hợp lệ'),
  name: z.string().trim().min(1, 'Tên mẫu không được để trống').optional(),
  content: z
    .string()
    .trim()
    .min(1, 'Nội dung mẫu không được để trống')
    .optional(),
  is_default: z.boolean().optional(),
})

const idSchema = z.object({
  id: z.string().uuid('ID mẫu không hợp lệ'),
})

const previewSchema = z.object({
  content: z.string(),
  /** Preview against a real product; omit to use the sample product. */
  productId: z.string().uuid().nullish(),
})

/** Placeholder shown instead of a real affiliate link (never leaves main). */
const PREVIEW_LINK = 'https://s.shopee.vn/2q8xK1a9Zv'

const SAMPLE_PRODUCT = {
  title: 'Nồi chiên không dầu Lock&Lock 5.5L điện tử',
  price: 1_290_000,
  shop_name: 'Lock&Lock Official Store',
  rating: 4.9,
  sold: 12_300,
}

export type TemplatePreview = {
  /** Rendered invitation sentence with a placeholder link. */
  text: string
  /** Product name the preview was rendered for. */
  productName: string
}

export function registerTemplateHandlers(): void {
  /**
   * Render a template for the Cài đặt preview pane.
   * Always uses a placeholder link so no affiliate URL reaches the renderer.
   */
  registerHandler<z.infer<typeof previewSchema>, TemplatePreview>(
    'templates:preview',
    previewSchema,
    (_event, input) => {
      const db = getDatabase()
      let source = SAMPLE_PRODUCT
      const candidates = input.productId
        ? listProducts(db).filter((p) => p.id === input.productId)
        : listProducts(db, { sort: 'most_used' }).slice(0, 1)
      const found = candidates[0]
      if (found?.title) {
        source = {
          title: found.title,
          price: found.price ?? SAMPLE_PRODUCT.price,
          shop_name: found.shop_name ?? '',
          rating: found.rating ?? 0,
          sold: found.sold ?? 0,
        }
      }

      return {
        text: renderTemplate(input.content, {
          link: PREVIEW_LINK,
          ten: source.title,
          gia: source.price,
          shop: source.shop_name,
          danhgia: source.rating,
          daban: source.sold,
        }),
        productName: source.title,
      }
    },
  )

  registerHandler<null, Template[]>('templates:list', null, () => {
    return listTemplates(getDatabase())
  })

  registerHandler<null, Template | null>(
    'templates:getDefault',
    null,
    () => {
      return getDefaultTemplate(getDatabase())
    },
  )

  registerHandler<z.infer<typeof createSchema>, Template>(
    'templates:create',
    createSchema,
    (_event, input) => {
      return createTemplate(getDatabase(), input)
    },
  )

  registerHandler<z.infer<typeof updateSchema>, Template>(
    'templates:update',
    updateSchema,
    (_event, input) => {
      return updateTemplate(getDatabase(), input)
    },
  )

  registerHandler<z.infer<typeof idSchema>, Template>(
    'templates:setDefault',
    idSchema,
    (_event, input) => {
      return setDefaultTemplate(getDatabase(), input.id)
    },
  )

  registerHandler<z.infer<typeof idSchema>, { deleted: boolean }>(
    'templates:delete',
    idSchema,
    (_event, input) => {
      const deleted = deleteTemplate(getDatabase(), input.id)
      if (!deleted) {
        throw new Error('Không tìm thấy mẫu câu mời để xoá')
      }
      return { deleted: true }
    },
  )
}
