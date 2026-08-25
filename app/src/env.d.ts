/// <reference types="vite/client" />

/**
 * Ambient renderer types. Everything lives inside `declare global` so the
 * components can use these names without importing them.
 */
declare global {
  /** Injected at build time from package.json (see electron.vite.config.ts). */
  declare const __APP_VERSION__: string

  type DbStatusPayload = {
    ok: boolean
    path: string
    tables: string[]
    error?: string
  }

  type IpcResult<T> =
    | { success: true; data: T }
    | { success: false; error: string }

  type CopyProductResult = {
    productName: string
    productId: string
    templateId: string | null
    usedOwner: boolean
    reason: string
  }

  type Product = {
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

  /** List/card payload — never includes original_url. */
  type ProductSummary = Omit<Product, 'original_url'>

  /** Group chip rendered on cards / list rows. */
  type ProductGroupRef = {
    id: string
    name: string
    color: string | null
  }

  /** Summary + real copy count + group chips. */
  type ProductListItem = ProductSummary & {
    copy_count: number
    groups: ProductGroupRef[]
  }

  type ProductSort = 'newest' | 'title' | 'price' | 'most_used'

  /** "Cần xử lý" buckets in the sidebar. */
  type ProductBucket = 'missing' | 'error' | 'ungrouped'

  type ProductCounts = {
    total: number
    missing: number
    error: number
    ungrouped: number
  }

  type ListProductsFilter = {
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
  type CategoryNode = {
    path: string
    name: string
    depth: number
    count: number
  }

  type CreateProductInput = {
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

  type UpdateProductInput = {
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

  type Group = {
    id: string
    name: string
    color: string | null
    sort_order: number
    created_at: number
  }

  type GroupWithCount = Group & {
    product_count: number
  }

  type CreateGroupInput = {
    name: string
    color?: string | null
    sort_order?: number
  }

  type UpdateGroupInput = {
    id: string
    name?: string
    color?: string | null
    sort_order?: number
  }

  type Template = {
    id: string
    name: string
    content: string
    is_default: boolean
    created_at: number
  }

  type CreateTemplateInput = {
    name: string
    content: string
    is_default?: boolean
  }

  type UpdateTemplateInput = {
    id: string
    name?: string
    content?: string
    is_default?: boolean
  }

  type CopyProductInput = {
    productId: string
    templateId?: string | null
  }

  type CopyProductsInput = {
    productIds: string[]
    templateId?: string | null
  }

  type CopyProductsResult = {
    copied: number
    failed: number
    templateId: string | null
  }

  /** Rendered preview for the template editor — placeholder link only. */
  type TemplatePreview = {
    text: string
    productName: string
  }

  type LicenseStatus = {
    state: 'trial' | 'expired'
    trialEndsAt: number
    msRemaining: number
    clockTampered: boolean
    tosAcceptedAt: number | null
    tosVersion: string | null
  }

  type CopyStats = {
    total: number
    usedOwner: number
    ratePercent: number | null
    byReason: Array<{ reason: string; count: number }>
  }

  type ExcelExportResult = {
    path: string
    count: number
  }

  type ExcelExportDialogResult =
    | { cancelled: true }
    | { cancelled: false; result: ExcelExportResult }

  type ImportPreviewRow = {
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
  type ColumnDetection = {
    sheetName: string
    /** 1-based header row, or null when the file has no header. */
    headerRowNumber: number | null
    firstDataRow: number
    mapping: Partial<Record<string, string>>
  }

  type ImportPreview = {
    filePath: string
    validCount: number
    duplicateCount: number
    invalidCount: number
    totalDataRows: number
    rows: ImportPreviewRow[]
    detection: ColumnDetection
  }

  type ExcelPreviewDialogResult =
    | { cancelled: true }
    | { cancelled: false; preview: ImportPreview }

  type ConfirmImportInput = {
    filePath: string
    overwrite?: boolean
  }

  type ConfirmImportResult = {
    inserted: number
    updated: number
    skippedDuplicates: number
    invalid: number
    errorFilePath: string | null
    rescrapeQueued: number
  }

  /** Shopee optional sign-in status — never includes credentials. */
  type ShopeeAuthStatus = {
    signedIn: boolean
    message: string
  }

  type ShopeeLoginResult = {
    signedIn: boolean
    reason: 'signed_in' | 'closed' | 'timeout' | 'error'
    message: string
  }

  type ShopeeSignOutResult = {
    signedIn: false
    message: string
  }

  type EzaffApi = {
    getDbStatus: () => Promise<IpcResult<DbStatusPayload>>
    products: {
      list: (
        filter?: ListProductsFilter | null,
      ) => Promise<IpcResult<ProductListItem[]>>
      counts: () => Promise<IpcResult<ProductCounts>>
    categories: () => Promise<IpcResult<string[]>>
    categoryTree: () => Promise<IpcResult<CategoryNode[]>>
      get: (id: string) => Promise<IpcResult<Product | null>>
      create: (input: CreateProductInput) => Promise<IpcResult<Product>>
      update: (input: UpdateProductInput) => Promise<IpcResult<Product>>
      rescrape: (id: string) => Promise<IpcResult<Product>>
      delete: (id: string) => Promise<IpcResult<{ deleted: boolean }>>
      deleteMany: (ids: string[]) => Promise<IpcResult<{ deleted: number }>>
      pickImage: (input?: { productId?: string }) => Promise<
        IpcResult<{
          cancelled: boolean
          image_local: string | null
          product: Product | null
        }>
      >
      pasteImage: (input?: {
        productId?: string
        imageUrl?: string
      }) => Promise<
        IpcResult<{
          image_local: string
          image_url: string | null
          product: Product | null
        }>
      >
      openProductPage: (
        url: string,
      ) => Promise<IpcResult<{ opened: boolean; message: string }>>
    }
    groups: {
      list: () => Promise<IpcResult<GroupWithCount[]>>
      create: (input: CreateGroupInput) => Promise<IpcResult<Group>>
      update: (input: UpdateGroupInput) => Promise<IpcResult<Group>>
      delete: (id: string) => Promise<IpcResult<{ deleted: boolean }>>
      assign: (
        productId: string,
        groupId: string,
      ) => Promise<IpcResult<{ ok: true }>>
      assignMany: (
        productIds: string[],
        groupId: string,
      ) => Promise<IpcResult<{ added: number }>>
      unassign: (
        productId: string,
        groupId: string,
      ) => Promise<IpcResult<{ removed: boolean }>>
      listForProduct: (productId: string) => Promise<IpcResult<Group[]>>
      setProductGroups: (
        productId: string,
        groupIds: string[],
      ) => Promise<IpcResult<Group[]>>
    }
    templates: {
      list: () => Promise<IpcResult<Template[]>>
      getDefault: () => Promise<IpcResult<Template | null>>
      create: (input: CreateTemplateInput) => Promise<IpcResult<Template>>
      update: (input: UpdateTemplateInput) => Promise<IpcResult<Template>>
      setDefault: (id: string) => Promise<IpcResult<Template>>
      delete: (id: string) => Promise<IpcResult<{ deleted: boolean }>>
      preview: (input: {
        content: string
        productId?: string | null
      }) => Promise<IpcResult<TemplatePreview>>
    }
    files: {
      getPath: (file: File) => string
    }
    clipboard: {
      /** Marketplace links found in the clipboard — nothing else. */
      readLinks: () => Promise<IpcResult<string[]>>
    }
    copy: {
      product: (input: CopyProductInput) => Promise<IpcResult<CopyProductResult>>
      products: (
        input: CopyProductsInput,
      ) => Promise<IpcResult<CopyProductsResult>>
    }
    license: {
      getStatus: () => Promise<IpcResult<LicenseStatus>>
      acceptTos: () => Promise<IpcResult<LicenseStatus>>
      getCopyStats: () => Promise<IpcResult<CopyStats>>
    }
    excel: {
      export: (input?: {
        productIds?: string[]
      }) => Promise<IpcResult<ExcelExportDialogResult>>
      previewImport: () => Promise<IpcResult<ExcelPreviewDialogResult>>
      previewImportPath: (
        filePath: string,
      ) => Promise<IpcResult<ExcelPreviewDialogResult>>
      onRescrapeProgress: (
        cb: (progress: { done: number; total: number }) => void,
      ) => () => void
      confirmImport: (
        input: ConfirmImportInput,
      ) => Promise<IpcResult<ConfirmImportResult>>
    }
    shopeeAuth: {
      getStatus: () => Promise<IpcResult<ShopeeAuthStatus>>
      openLogin: () => Promise<IpcResult<ShopeeLoginResult>>
      signOut: () => Promise<IpcResult<ShopeeSignOutResult>>
    }
  }

  interface Window {
    ezaff: EzaffApi
  }
}

export {}
