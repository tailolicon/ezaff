import { contextBridge, ipcRenderer, webUtils } from 'electron'

export type DbStatusPayload = {
  ok: boolean
  path: string
  tables: string[]
  error?: string
}

export type IpcResult<T> =
  | { success: true; data: T }
  | { success: false; error: string }

/** Full product including original_url — only for edit dialog. */
export type Product = {
  id: string
  platform: string
  original_url: string
  canonical_key: string
  item_id: string | null
  shop_id: string | null
  title: string | null
  image_url: string | null
  image_local: string | null
  price: number | null
  currency: string
  category: string | null
  /** Full marketplace chain, e.g. "A > B > C". */
  category_path: string | null
  shop_name: string | null
  rating: number | null
  rating_count: number | null
  sold: number | null
  note: string | null
  scrape_status: string | null
  scrape_error: string | null
  created_at: number
  updated_at: number
}

/** List/card payload — no original_url. */
export type ProductSummary = Omit<Product, 'original_url'>

/** Group chip rendered on cards / list rows. */
export type ProductGroupRef = {
  id: string
  name: string
  color: string | null
}

/** Summary + real copy count + group chips (what the library renders). */
export type ProductListItem = ProductSummary & {
  copy_count: number
  groups: ProductGroupRef[]
}

export type ProductSort = 'newest' | 'title' | 'price' | 'most_used'

/** "Cần xử lý" buckets in the sidebar. */
export type ProductBucket = 'missing' | 'error' | 'ungrouped'

export type ProductCounts = {
  total: number
  missing: number
  error: number
  ungrouped: number
}

export type ListProductsFilter = {
  query?: string
  groupId?: string | null
  platform?: string | null
  priceMin?: number | null
  priceMax?: number | null
  dateFrom?: number | null
  dateTo?: number | null
  sort?: ProductSort
  bucket?: ProductBucket | null
  /** Category branch — matches this path and everything under it. */
  categoryPath?: string | null
}

/** One node of the category hierarchy shown in the sidebar. */
export type CategoryNode = {
  path: string
  name: string
  depth: number
  count: number
}

export type CreateProductInput = {
  original_url: string
  title?: string | null
  price?: number | null
  currency?: string
  category?: string | null
  category_path?: string | null
  shop_name?: string | null
  note?: string | null
  image_url?: string | null
  platform?: string
  item_id?: string | null
  shop_id?: string | null
  scrape_status?: string | null
  /** Default true — run scraper after save. */
  scrape?: boolean
}

export type UpdateProductInput = {
  id: string
  original_url?: string
  title?: string | null
  price?: number | null
  currency?: string
  category?: string | null
  category_path?: string | null
  shop_name?: string | null
  note?: string | null
  image_url?: string | null
  image_local?: string | null
  platform?: string
  item_id?: string | null
  shop_id?: string | null
  scrape_status?: string | null
  scrape_error?: string | null
}

export type Group = {
  id: string
  name: string
  color: string | null
  sort_order: number
  created_at: number
}

export type GroupWithCount = Group & {
  product_count: number
}

export type CreateGroupInput = {
  name: string
  color?: string | null
  sort_order?: number
}

export type UpdateGroupInput = {
  id: string
  name?: string
  color?: string | null
  sort_order?: number
}

export type Template = {
  id: string
  name: string
  content: string
  is_default: boolean
  created_at: number
}

export type CreateTemplateInput = {
  name: string
  content: string
  is_default?: boolean
}

export type UpdateTemplateInput = {
  id: string
  name?: string
  content?: string
  is_default?: boolean
}

/** Special id: copy raw affiliate link only (no invitation sentence). */
export const LINK_ONLY_TEMPLATE_ID = '__link_only__' as const

export type CopyProductInput = {
  productId: string
  /** Omit → default template; null / LINK_ONLY_TEMPLATE_ID → chỉ link. */
  templateId?: string | null
}

export type CopyProductResult = {
  /** Clipboard text is NEVER returned to the renderer (anti-circumvention). */
  productName: string
  productId: string
  templateId: string | null
  /** Always false over IPC. */
  usedOwner: boolean
  reason: string
}

export type CopyProductsInput = {
  productIds: string[]
  templateId?: string | null
}

export type CopyProductsResult = {
  copied: number
  failed: number
  templateId: string | null
}

/** Rendered preview for the template editor — placeholder link only. */
export type TemplatePreview = {
  text: string
  productName: string
}

export type LicenseStatus = {
  state: 'trial' | 'expired'
  trialEndsAt: number
  msRemaining: number
  clockTampered: boolean
  tosAcceptedAt: number | null
  tosVersion: string | null
}

/** Aggregate transparency stats from copy_events (FR-1). */
export type CopyStats = {
  total: number
  usedOwner: number
  ratePercent: number | null
  byReason: Array<{ reason: string; count: number }>
}

export type ExcelExportResult = {
  path: string
  count: number
}

export type ExcelExportDialogResult =
  | { cancelled: true }
  | { cancelled: false; result: ExcelExportResult }

export type ImportPreviewRow = {
  rowNumber: number
  status: 'valid' | 'duplicate' | 'invalid'
  reason?: string
  original: Partial<
    Record<
      | 'Tên sản phẩm'
      | 'Link aff'
      | 'URL ảnh'
      | 'Nhóm'
      | 'Sàn'
      | 'Danh mục'
      | 'Giá'
      | 'Tên shop'
      | 'Ghi chú'
      | 'Template'
      | 'Ngày thêm',
      string
    >
  >
}

/** Which sheet / header row / columns the importer recognised. */
export type ColumnDetection = {
  sheetName: string
  /** 1-based header row, or null when the file has no header. */
  headerRowNumber: number | null
  firstDataRow: number
  mapping: Partial<Record<string, string>>
}

export type ImportPreview = {
  filePath: string
  validCount: number
  duplicateCount: number
  invalidCount: number
  totalDataRows: number
  rows: ImportPreviewRow[]
  detection: ColumnDetection
}

export type ExcelPreviewDialogResult =
  | { cancelled: true }
  | { cancelled: false; preview: ImportPreview }

export type ConfirmImportInput = {
  filePath: string
  overwrite?: boolean
}

export type ConfirmImportResult = {
  inserted: number
  updated: number
  skippedDuplicates: number
  invalid: number
  errorFilePath: string | null
  rescrapeQueued: number
}

/** Shopee optional sign-in status (Phase 11) — never includes credentials. */
export type ShopeeAuthStatus = {
  signedIn: boolean
  message: string
}

export type ShopeeLoginResult = {
  signedIn: boolean
  reason: 'signed_in' | 'closed' | 'timeout' | 'error'
  message: string
}

export type ShopeeSignOutResult = {
  signedIn: false
  message: string
}

const api = {
  getDbStatus: (): Promise<IpcResult<DbStatusPayload>> =>
    ipcRenderer.invoke('db:getStatus'),

  products: {
    list: (
      filter?: ListProductsFilter | null,
    ): Promise<IpcResult<ProductListItem[]>> =>
      ipcRenderer.invoke('products:list', filter ?? null),

    /** Sidebar counters: total + cần xử lý buckets. */
    counts: (): Promise<IpcResult<ProductCounts>> =>
      ipcRenderer.invoke('products:counts'),

    /** Distinct categories already used, most frequent first. */
    categories: (): Promise<IpcResult<string[]>> =>
      ipcRenderer.invoke('products:categories'),

    /** Full category hierarchy with per-branch counts. */
    categoryTree: (): Promise<IpcResult<CategoryNode[]>> =>
      ipcRenderer.invoke('products:categoryTree'),

    get: (id: string): Promise<IpcResult<Product | null>> =>
      ipcRenderer.invoke('products:get', { id }),

    create: (input: CreateProductInput): Promise<IpcResult<Product>> =>
      ipcRenderer.invoke('products:create', input),

    update: (input: UpdateProductInput): Promise<IpcResult<Product>> =>
      ipcRenderer.invoke('products:update', input),

    rescrape: (id: string): Promise<IpcResult<Product>> =>
      ipcRenderer.invoke('products:rescrape', { id }),

    delete: (id: string): Promise<IpcResult<{ deleted: boolean }>> =>
      ipcRenderer.invoke('products:delete', { id }),

    /** Bulk delete from the list-view selection bar. */
    deleteMany: (ids: string[]): Promise<IpcResult<{ deleted: number }>> =>
      ipcRenderer.invoke('products:deleteMany', { ids }),

    /** Pick an image file from disk and copy it into the local cache. */
    pickImage: (input?: {
      productId?: string
    }): Promise<
      IpcResult<{
        cancelled: boolean
        image_local: string | null
        product: Product | null
      }>
    > => ipcRenderer.invoke('products:pickImage', input ?? {}),

    /** Paste clipboard image (or image URL) into cache; optionally attach to product. */
    pasteImage: (input?: {
      productId?: string
      imageUrl?: string
    }): Promise<
      IpcResult<{
        image_local: string
        image_url: string | null
        product: Product | null
      }>
    > => ipcRenderer.invoke('products:pasteImage', input ?? {}),

    /** Open product page in a visible window on the Shopee session partition. */
    openProductPage: (
      url: string,
    ): Promise<IpcResult<{ opened: boolean; message: string }>> =>
      ipcRenderer.invoke('products:openProductPage', { url }),
  },

  groups: {
    list: (): Promise<IpcResult<GroupWithCount[]>> =>
      ipcRenderer.invoke('groups:list'),

    create: (input: CreateGroupInput): Promise<IpcResult<Group>> =>
      ipcRenderer.invoke('groups:create', input),

    update: (input: UpdateGroupInput): Promise<IpcResult<Group>> =>
      ipcRenderer.invoke('groups:update', input),

    delete: (id: string): Promise<IpcResult<{ deleted: boolean }>> =>
      ipcRenderer.invoke('groups:delete', { id }),

    assign: (
      productId: string,
      groupId: string,
    ): Promise<IpcResult<{ ok: true }>> =>
      ipcRenderer.invoke('groups:assign', { productId, groupId }),

    /** Add many products to one group (bulk bar). */
    assignMany: (
      productIds: string[],
      groupId: string,
    ): Promise<IpcResult<{ added: number }>> =>
      ipcRenderer.invoke('groups:assignMany', { productIds, groupId }),

    unassign: (
      productId: string,
      groupId: string,
    ): Promise<IpcResult<{ removed: boolean }>> =>
      ipcRenderer.invoke('groups:unassign', { productId, groupId }),

    listForProduct: (productId: string): Promise<IpcResult<Group[]>> =>
      ipcRenderer.invoke('groups:listForProduct', { productId }),

    setProductGroups: (
      productId: string,
      groupIds: string[],
    ): Promise<IpcResult<Group[]>> =>
      ipcRenderer.invoke('groups:setProductGroups', {
        productId,
        groupIds,
      }),
  },

  templates: {
    list: (): Promise<IpcResult<Template[]>> =>
      ipcRenderer.invoke('templates:list'),

    getDefault: (): Promise<IpcResult<Template | null>> =>
      ipcRenderer.invoke('templates:getDefault'),

    create: (input: CreateTemplateInput): Promise<IpcResult<Template>> =>
      ipcRenderer.invoke('templates:create', input),

    update: (input: UpdateTemplateInput): Promise<IpcResult<Template>> =>
      ipcRenderer.invoke('templates:update', input),

    setDefault: (id: string): Promise<IpcResult<Template>> =>
      ipcRenderer.invoke('templates:setDefault', { id }),

    delete: (id: string): Promise<IpcResult<{ deleted: boolean }>> =>
      ipcRenderer.invoke('templates:delete', { id }),

    /** Render a template with sample/real product data + placeholder link. */
    preview: (input: {
      content: string
      productId?: string | null
    }): Promise<IpcResult<TemplatePreview>> =>
      ipcRenderer.invoke('templates:preview', input),
  },

  files: {
    /**
     * Absolute path of a file the user dropped onto the window.
     * Electron 32+ removed File.path, so this must go through webUtils.
     */
    getPath: (file: File): string => webUtils.getPathForFile(file),
  },

  clipboard: {
    /** Marketplace links found in the clipboard — nothing else is returned. */
    readLinks: (): Promise<IpcResult<string[]>> =>
      ipcRenderer.invoke('clipboard:readLinks'),
  },

  copy: {
    product: (
      input: CopyProductInput,
    ): Promise<IpcResult<CopyProductResult>> =>
      ipcRenderer.invoke('copy:product', input),

    /** Copy many products at once — clipboard write stays in main. */
    products: (
      input: CopyProductsInput,
    ): Promise<IpcResult<CopyProductsResult>> =>
      ipcRenderer.invoke('copy:products', input),
  },

  license: {
    getStatus: (): Promise<IpcResult<LicenseStatus>> =>
      ipcRenderer.invoke('license:getStatus'),

    acceptTos: (): Promise<IpcResult<LicenseStatus>> =>
      ipcRenderer.invoke('license:acceptTos'),

    getCopyStats: (): Promise<IpcResult<CopyStats>> =>
      ipcRenderer.invoke('license:getCopyStats'),
  },

  excel: {
    /** Pass productIds to export only the current selection. */
    export: (input?: {
      productIds?: string[]
    }): Promise<IpcResult<ExcelExportDialogResult>> =>
      ipcRenderer.invoke('excel:export', input ?? null),

    previewImport: (): Promise<IpcResult<ExcelPreviewDialogResult>> =>
      ipcRenderer.invoke('excel:previewImport'),

    /**
     * Progress of the background rescrape that runs after an import.
     * Returns an unsubscribe function.
     */
    onRescrapeProgress: (
      cb: (progress: { done: number; total: number }) => void,
    ): (() => void) => {
      const listener = (
        _e: unknown,
        progress: { done: number; total: number },
      ): void => cb(progress)
      ipcRenderer.on('products:rescrapeProgress', listener)
      return () => {
        ipcRenderer.removeListener('products:rescrapeProgress', listener)
      }
    },

    /** Preview a file the user dropped, skipping the open dialog. */
    previewImportPath: (
      filePath: string,
    ): Promise<IpcResult<ExcelPreviewDialogResult>> =>
      ipcRenderer.invoke('excel:previewImportPath', { filePath }),

    confirmImport: (
      input: ConfirmImportInput,
    ): Promise<IpcResult<ConfirmImportResult>> =>
      ipcRenderer.invoke('excel:confirmImport', input),
  },

  /**
   * Optional Shopee account session on this machine.
   * Never accepts or returns username/password — only status + open/clear.
   */
  shopeeAuth: {
    getStatus: (): Promise<IpcResult<ShopeeAuthStatus>> =>
      ipcRenderer.invoke('shopeeAuth:getStatus'),

    openLogin: (): Promise<IpcResult<ShopeeLoginResult>> =>
      ipcRenderer.invoke('shopeeAuth:openLogin'),

    signOut: (): Promise<IpcResult<ShopeeSignOutResult>> =>
      ipcRenderer.invoke('shopeeAuth:signOut'),
  },
} as const

contextBridge.exposeInMainWorld('ezaff', api)

export type EzaffApi = typeof api
