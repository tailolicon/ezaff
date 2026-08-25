import { BrowserWindow, dialog } from 'electron'
import { z } from 'zod'
import { getDatabase } from '../db/connection'
import {
  createProduct,
  deleteProduct,
  deleteProducts,
  getProductById,
  getProductCounts,
  listCategories,
  listCategoryTree,
  listProducts,
  updateProduct,
  type ListProductsFilter,
  type Product,
  type CategoryNode,
  type ProductCounts,
  type ProductListItem,
} from '../db/repositories/productRepo'
import {
  cacheImage,
  importImageFile,
  saveClipboardImage,
} from '../services/scraper/imageCache'
import {
  createProductWithScrape,
  rescrapeProduct,
} from '../services/scraper/productScrape'
import { openShopeeProductPage } from '../services/scraper/shopee.scraper'
import { registerHandler } from './registry'

const createSchema = z.object({
  original_url: z
    .string()
    .trim()
    .min(1, 'Link không được để trống')
    .url('Link không hợp lệ'),
  title: z.string().trim().nullable().optional(),
  price: z.number().int().nonnegative().nullable().optional(),
  currency: z.string().trim().min(1).optional(),
  category: z.string().trim().nullable().optional(),
  category_path: z.string().trim().nullable().optional(),
  shop_name: z.string().trim().nullable().optional(),
  note: z.string().trim().nullable().optional(),
  image_url: z.string().trim().nullable().optional(),
  platform: z.string().trim().optional(),
  item_id: z.string().trim().nullable().optional(),
  shop_id: z.string().trim().nullable().optional(),
  scrape_status: z.string().trim().nullable().optional(),
  /** When true (default), run scraper after save. Pass false for pure manual create. */
  scrape: z.boolean().optional(),
})

const updateSchema = z.object({
  id: z.string().uuid('ID sản phẩm không hợp lệ'),
  original_url: z
    .string()
    .trim()
    .min(1)
    .url('Link không hợp lệ')
    .optional(),
  title: z.string().trim().nullable().optional(),
  price: z.number().int().nonnegative().nullable().optional(),
  currency: z.string().trim().min(1).optional(),
  category: z.string().trim().nullable().optional(),
  category_path: z.string().trim().nullable().optional(),
  shop_name: z.string().trim().nullable().optional(),
  note: z.string().trim().nullable().optional(),
  image_url: z.string().trim().nullable().optional(),
  image_local: z.string().trim().nullable().optional(),
  platform: z.string().trim().optional(),
  item_id: z.string().trim().nullable().optional(),
  shop_id: z.string().trim().nullable().optional(),
  scrape_status: z.string().trim().nullable().optional(),
  scrape_error: z.string().trim().nullable().optional(),
})

const idSchema = z.object({
  id: z.string().uuid('ID sản phẩm không hợp lệ'),
})

const listFilterSchema = z
  .object({
    query: z.string().optional(),
    groupId: z.string().uuid().nullish(),
    platform: z.string().trim().nullish(),
    priceMin: z.number().int().nonnegative().nullish(),
    priceMax: z.number().int().nonnegative().nullish(),
    dateFrom: z.number().int().nullish(),
    dateTo: z.number().int().nullish(),
    sort: z
      .enum(['newest', 'title', 'price', 'most_used'])
      .optional(),
    bucket: z.enum(['missing', 'error', 'ungrouped']).nullish(),
    categoryPath: z.string().trim().nullish(),
  })
  .nullish()

const idsSchema = z.object({
  ids: z.array(z.string().uuid('ID sản phẩm không hợp lệ')).min(1),
})

function focusedWindow(): BrowserWindow | null {
  return (
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  )
}

export function registerProductHandlers(): void {
  registerHandler<
    z.infer<typeof listFilterSchema>,
    ProductListItem[]
  >('products:list', listFilterSchema, (_event, input) => {
    const filter: ListProductsFilter = input ?? {}
    return listProducts(getDatabase(), filter)
  })

  /** Sidebar counters (total + cần xử lý buckets) in one query. */
  registerHandler<null, ProductCounts>('products:counts', null, () => {
    return getProductCounts(getDatabase())
  })

  /** Existing categories for the edit-dialog autocomplete. */
  registerHandler<null, string[]>('products:categories', null, () => {
    return listCategories(getDatabase())
  })

  /** Full category hierarchy with per-branch counts (sidebar tree). */
  registerHandler<null, CategoryNode[]>('products:categoryTree', null, () => {
    return listCategoryTree(getDatabase())
  })

  registerHandler<z.infer<typeof idSchema>, Product | null>(
    'products:get',
    idSchema,
    (_event, input) => {
      return getProductById(getDatabase(), input.id)
    },
  )

  registerHandler<z.infer<typeof createSchema>, Product>(
    'products:create',
    createSchema,
    async (_event, input) => {
      // scrape: false or scrape_status 'manual' → pure insert (no network)
      const shouldScrape =
        input.scrape !== false && input.scrape_status !== 'manual'
      const db = getDatabase()
      const product = shouldScrape
        ? await createProductWithScrape(db, input.original_url)
        : createProduct(db, input)

      // No per-product worker call here any more — the owner-link bundle is
      // synced daily and answers locally. Warming each add cost one request
      // per product, which does not survive contact with a few thousand users.
      return product
    },
  )

  registerHandler<z.infer<typeof updateSchema>, Product>(
    'products:update',
    updateSchema,
    (_event, input) => {
      return updateProduct(getDatabase(), input)
    },
  )

  registerHandler<z.infer<typeof idSchema>, Product>(
    'products:rescrape',
    idSchema,
    async (_event, input) => {
      // Always hit the network on "Quét lại" — never reuse stale lookup cache
      // (old partial rows without price/image were masking fixed scrapers).
      const db = getDatabase()
      const product = await rescrapeProduct(db, input.id, {
        skipLookupCache: true,
      })
      return product
    },
  )

  registerHandler<z.infer<typeof idSchema>, { deleted: boolean }>(
    'products:delete',
    idSchema,
    (_event, input) => {
      const deleted = deleteProduct(getDatabase(), input.id)
      if (!deleted) {
        throw new Error('Không tìm thấy sản phẩm để xoá')
      }
      return { deleted: true }
    },
  )

  /**
   * Paste image from clipboard into the image cache, optionally attach to product.
   * Also accepts a pasted image URL as text (handled inside saveClipboardImage).
   */
  registerHandler<
    z.infer<typeof pasteImageSchema>,
    { image_local: string; image_url: string | null; product: Product | null }
  >('products:pasteImage', pasteImageSchema, async (_event, input) => {
    let local: string | null = null

    if (input.imageUrl?.trim()) {
      local = await cacheImage(input.imageUrl.trim())
    } else {
      local = await saveClipboardImage()
    }

    if (!local) {
      throw new Error(
        'Không có ảnh trong clipboard. Hãy sao chép ảnh (hoặc dán URL ảnh) rồi thử lại.',
      )
    }

    let product: Product | null = null
    if (input.productId) {
      product = updateProduct(getDatabase(), {
        id: input.productId,
        image_local: local,
        // Keep remote URL if user pasted a URL; otherwise leave existing
        image_url: input.imageUrl?.trim() || undefined,
      })
    }

    return {
      image_local: local,
      image_url: input.imageUrl?.trim() || null,
      product,
    }
  })

  /** Bulk delete from the list-view selection bar. */
  registerHandler<z.infer<typeof idsSchema>, { deleted: number }>(
    'products:deleteMany',
    idsSchema,
    (_event, input) => {
      const deleted = deleteProducts(getDatabase(), input.ids)
      if (deleted === 0) {
        throw new Error('Không xoá được sản phẩm nào')
      }
      return { deleted }
    },
  )

  /**
   * Pick an image file from disk and copy it into the local image cache.
   * The picked file is never referenced directly — the cached copy is stored.
   */
  registerHandler<
    z.infer<typeof pickImageSchema>,
    { cancelled: boolean; image_local: string | null; product: Product | null }
  >('products:pickImage', pickImageSchema, async (_event, input) => {
    const win = focusedWindow()
    const dialogOpts = {
      title: 'Chọn ảnh sản phẩm',
      filters: [
        { name: 'Ảnh', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] },
      ],
      properties: ['openFile' as const],
    }
    const { canceled, filePaths } = win
      ? await dialog.showOpenDialog(win, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts)

    if (canceled || !filePaths[0]) {
      return { cancelled: true, image_local: null, product: null }
    }

    const local = await importImageFile(filePaths[0])
    if (!local) {
      throw new Error('Không đọc được file ảnh đã chọn.')
    }

    let product: Product | null = null
    if (input.productId) {
      product = updateProduct(getDatabase(), {
        id: input.productId,
        image_local: local,
      })
    }

    return { cancelled: false, image_local: local, product }
  })

  /** Open product URL in a visible window on the authenticated Shopee partition. */
  registerHandler<
    z.infer<typeof openProductPageSchema>,
    { opened: boolean; message: string }
  >('products:openProductPage', openProductPageSchema, async (_event, input) => {
    return openShopeeProductPage(input.url)
  })
}

const pickImageSchema = z.object({
  productId: z.string().uuid().optional(),
})

const pasteImageSchema = z.object({
  productId: z.string().uuid().optional(),
  /** Optional image URL text (paste URL instead of binary clipboard image). */
  imageUrl: z.string().trim().url().optional(),
})

const openProductPageSchema = z.object({
  url: z.string().trim().min(1).url('Link không hợp lệ'),
})
