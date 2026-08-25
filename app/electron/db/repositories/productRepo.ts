import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import {
  CATEGORY_SEPARATOR,
  splitCategoryPath,
} from '../../services/categoryPath'

/** Full product row as stored in SQLite. */
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
  /** Product star rating (e.g. 4.89). */
  rating: number | null
  /** Number of product reviews. */
  rating_count: number | null
  /** Units sold when known. */
  sold: number | null
  note: string | null
  scrape_status: string | null
  scrape_error: string | null
  created_at: number
  updated_at: number
}

/**
 * List/card payload — intentionally omits original_url so the affiliate
 * link cannot leak into list/grid rendering paths.
 */
export type ProductSummary = Omit<Product, 'original_url'>

/** Compact group reference rendered as a chip on cards / list rows. */
export type ProductGroupRef = {
  id: string
  name: string
  color: string | null
}

/**
 * Summary enriched with the data the library screens render directly:
 * real copy count (from copy_events) and group chips.
 */
export type ProductListItem = ProductSummary & {
  copy_count: number
  groups: ProductGroupRef[]
}

export type CreateProductInput = {
  original_url: string
  /**
   * Optional post-redirect URL used only for ID / canonical_key extraction
   * (shortlinks like s.shopee.vn → category/product page). original_url is
   * always stored as the user's affiliate link.
   */
  resolved_url?: string
  title?: string | null
  price?: number | null
  currency?: string
  category?: string | null
  category_path?: string | null
  shop_name?: string | null
  rating?: number | null
  rating_count?: number | null
  sold?: number | null
  note?: string | null
  image_url?: string | null
  image_local?: string | null
  platform?: string
  item_id?: string | null
  shop_id?: string | null
  scrape_status?: string | null
  scrape_error?: string | null
  /** Optional epoch ms — used by Excel import for date round-trip. */
  created_at?: number
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
  rating?: number | null
  rating_count?: number | null
  sold?: number | null
  note?: string | null
  image_url?: string | null
  image_local?: string | null
  platform?: string
  item_id?: string | null
  shop_id?: string | null
  scrape_status?: string | null
  scrape_error?: string | null
  /** Optional epoch ms — used by Excel import overwrite. */
  created_at?: number
}

/** Sort keys for product list (SQL-side). */
export type ProductSort = 'newest' | 'title' | 'price' | 'most_used'

/**
 * "Cần xử lý" buckets shown in the sidebar.
 * - missing: scraped but incomplete (no title / price / image, or status partial)
 * - error: scraper failed — user must fill in by hand
 * - ungrouped: not assigned to any group yet
 */
export type ProductBucket = 'missing' | 'error' | 'ungrouped'

/**
 * Filters applied in SQL for responsive lists (5k+ products).
 * Empty/missing query means no full-text constraint (return everything matching other filters).
 */
export type ListProductsFilter = {
  query?: string
  groupId?: string | null
  platform?: string | null
  priceMin?: number | null
  priceMax?: number | null
  /** Inclusive lower bound on created_at (unix ms). */
  dateFrom?: number | null
  /** Inclusive upper bound on created_at (unix ms). */
  dateTo?: number | null
  sort?: ProductSort
  /** Sidebar "Cần xử lý" bucket. */
  bucket?: ProductBucket | null
  /**
   * Category branch: matches the exact path and everything below it, so
   * "Điện Thoại & Phụ Kiện" also returns "… > Pin dự phòng > Trên 20.000 mAh".
   */
  categoryPath?: string | null
}

/** One node of the category tree shown in the sidebar. */
export type CategoryNode = {
  /** Full path from the root down to this node. */
  path: string
  /** Label of this level only. */
  name: string
  /** 0 for top-level. */
  depth: number
  /** Products in this branch, including everything below it. */
  count: number
}

/** Counts for the sidebar badges — computed in SQL, never in the renderer. */
export type ProductCounts = {
  total: number
  missing: number
  error: number
  ungrouped: number
}

/** SQL predicate for each "cần xử lý" bucket (kept in one place). */
const BUCKET_SQL: Record<ProductBucket, string> = {
  error: `p.scrape_status = 'error'`,
  missing: `(
    p.scrape_status IS NOT 'error' AND (
      p.scrape_status = 'partial'
      OR p.title IS NULL OR TRIM(p.title) = ''
      OR p.price IS NULL
      OR (
        (p.image_url IS NULL OR TRIM(p.image_url) = '')
        AND (p.image_local IS NULL OR TRIM(p.image_local) = '')
      )
    )
  )`,
  ungrouped: `NOT EXISTS (
    SELECT 1 FROM product_groups pg2 WHERE pg2.product_id = p.id
  )`,
}

/**
 * Escape free-form user text into a safe FTS5 MATCH expression.
 * - Empty / whitespace-only → null (caller skips MATCH → return all)
 * - Strips operators/punctuation that break MATCH
 * - Quotes each token and adds * for prefix (partial-word) match
 */
export function buildFtsMatchQuery(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Remove FTS5 operator / punctuation characters; keep letters, numbers, marks.
  const cleaned = trimmed
    .replace(/[*"(){}[\]:^~!@#$%\\|=<>?/+,.;`'"\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned) return null

  const tokens = cleaned.split(' ').filter((t) => t.length > 0)
  if (tokens.length === 0) return null

  return tokens
    .map((token) => {
      // FTS5 phrase escape: double internal quotes
      const safe = token.replace(/"/g, '""')
      return `"${safe}"*`
    })
    .join(' ')
}

const DUPLICATE_MESSAGE =
  'Sản phẩm đã tồn tại (trùng canonical_key). Vui lòng kiểm tra lại link.'

type ProductRow = {
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

const PRODUCT_COLUMNS = `
  id, platform, original_url, canonical_key, item_id, shop_id,
  title, image_url, image_local, price, currency, category, category_path, shop_name,
  rating, rating_count, sold,
  note, scrape_status, scrape_error, created_at, updated_at
`

const PRODUCT_COLUMNS_P = `
  p.id, p.platform, p.original_url, p.canonical_key, p.item_id, p.shop_id,
  p.title, p.image_url, p.image_local, p.price, p.currency, p.category, p.category_path, p.shop_name,
  p.rating, p.rating_count, p.sold,
  p.note, p.scrape_status, p.scrape_error, p.created_at, p.updated_at
`

function mapRow(row: ProductRow): Product {
  return {
    id: row.id,
    platform: row.platform,
    original_url: row.original_url,
    canonical_key: row.canonical_key,
    item_id: row.item_id,
    shop_id: row.shop_id,
    title: row.title,
    image_url: row.image_url,
    image_local: row.image_local,
    price: row.price,
    currency: row.currency,
    category: row.category,
    category_path: row.category_path,
    shop_name: row.shop_name,
    rating: row.rating ?? null,
    rating_count: row.rating_count ?? null,
    sold: row.sold ?? null,
    note: row.note,
    scrape_status: row.scrape_status,
    scrape_error: row.scrape_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function toSummary(product: Product): ProductSummary {
  const { original_url: _omit, ...summary } = product
  return summary
}

/** Detect marketplace platform from URL hostname. */
export function detectPlatform(url: string): string {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return 'other'
  }
  if (host.includes('shopee')) return 'shopee'
  if (host.includes('lazada')) return 'lazada'
  if (host.includes('tiki')) return 'tiki'
  if (host.includes('tiktok')) return 'tiktok'
  if (host.includes('sendo')) return 'sendo'
  return 'other'
}

/**
 * Extract Shopee shopId/itemId when present in the URL path.
 * Supports:
 *   /product/<shopId>/<itemId>
 *   /<slug>-i.<shopId>.<itemId>
 */
export function extractShopeeIds(
  url: string,
): { shop_id: string; item_id: string } | null {
  try {
    const { pathname } = new URL(url)
    const productMatch = pathname.match(/\/product\/(\d+)\/(\d+)/)
    if (productMatch) {
      return { shop_id: productMatch[1], item_id: productMatch[2] }
    }
    const slugMatch = pathname.match(/-i\.(\d+)\.(\d+)/)
    if (slugMatch) {
      return { shop_id: slugMatch[1], item_id: slugMatch[2] }
    }
  } catch {
    return null
  }
  return null
}

/** Category id from -cat.CATID or /category/CATID (Phase 3.2). */
function extractShopeeCategoryIdLocal(url: string): string | null {
  try {
    const { pathname } = new URL(url)
    const catSlug = pathname.match(/-cat\.(\d+)(?:\b|\/|$)/)
    if (catSlug) return catSlug[1]
    const catPath = pathname.match(/\/category\/(\d+)(?:\b|\/|$)/)
    if (catPath) return catPath[1]
  } catch {
    return null
  }
  return null
}

/** Numeric shop id from /shop/ID. */
function extractShopeeShopIdLocal(url: string): string | null {
  try {
    const { pathname } = new URL(url)
    const m = pathname.match(/\/shop\/(\d+)(?:\b|\/|$)/)
    if (m) return m[1]
  } catch {
    return null
  }
  return null
}

/** Strip tracking query params and normalise URL for canonical comparison. */
export function normaliseUrl(raw: string): string {
  const trimmed = raw.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`URL không hợp lệ: ${raw}`)
  }
  parsed.hash = ''
  const drop = [
    'af_id',
    'smtt',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'pid',
    'sub_id',
    'sp_atk',
    'xptdk',
  ]
  for (const key of drop) {
    parsed.searchParams.delete(key)
  }
  // Sort remaining params for stability
  parsed.searchParams.sort()
  let path = parsed.pathname
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1)
  }
  parsed.pathname = path
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '')
  return parsed.toString()
}

/**
 * Build unique canonical_key.
 * - product: platform:shopId:itemId (both IDs)
 * - category: platform:cat:CATID
 * - shop: platform:shop:SHOPID
 * - else: platform:url:<normalised>
 */
export function buildCanonicalKey(input: {
  original_url: string
  platform: string
  shop_id?: string | null
  item_id?: string | null
}): string {
  const shop = input.shop_id?.trim() || null
  const item = input.item_id?.trim() || null
  if (shop && item) {
    return `${input.platform}:${shop}:${item}`
  }

  // Phase 3.2: stable keys for non-product Shopee kinds
  if (input.platform === 'shopee') {
    const catId = extractShopeeCategoryIdLocal(input.original_url)
    if (catId) {
      return `${input.platform}:cat:${catId}`
    }
    const shopOnly = shop || extractShopeeShopIdLocal(input.original_url)
    if (shopOnly && !item) {
      return `${input.platform}:shop:${shopOnly}`
    }
  } else if (shop && !item) {
    return `${input.platform}:shop:${shop}`
  }

  const normalised = normaliseUrl(input.original_url)
  return `${input.platform}:url:${normalised}`
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return (
    msg.includes('unique constraint failed') ||
    msg.includes('constraint failed: products.canonical_key')
  )
}

function resolveIdsAndPlatform(input: {
  original_url: string
  /** Post-redirect URL for ID/key extraction; defaults to original_url. */
  resolved_url?: string
  platform?: string
  shop_id?: string | null
  item_id?: string | null
}): {
  platform: string
  shop_id: string | null
  item_id: string | null
  original_url: string
  canonical_key: string
} {
  const original_url = input.original_url.trim()
  // Validate URL early
  normaliseUrl(original_url)

  const keySource = (input.resolved_url?.trim() || original_url)
  try {
    normaliseUrl(keySource)
  } catch {
    // Fall back to original if resolved_url is somehow invalid
  }

  const platform =
    input.platform?.trim() ||
    detectPlatform(keySource) ||
    detectPlatform(original_url)
  let shop_id = input.shop_id?.trim() || null
  let item_id = input.item_id?.trim() || null

  if ((!shop_id || !item_id) && platform === 'shopee') {
    const extracted =
      extractShopeeIds(keySource) ?? extractShopeeIds(original_url)
    if (extracted) {
      shop_id = shop_id ?? extracted.shop_id
      item_id = item_id ?? extracted.item_id
    } else if (!shop_id) {
      // Shop-only link: store numeric shop id when present
      shop_id =
        extractShopeeShopIdLocal(keySource) ??
        extractShopeeShopIdLocal(original_url)
    }
  }

  // Prefer keySource so category shortlinks resolve to platform:cat:CATID
  const canonical_key = buildCanonicalKey({
    original_url: keySource,
    platform,
    shop_id,
    item_id,
  })

  return { platform, shop_id, item_id, original_url, canonical_key }
}

export function createProduct(
  db: Database.Database,
  input: CreateProductInput,
): Product {
  const resolved = resolveIdsAndPlatform({
    original_url: input.original_url,
    resolved_url: input.resolved_url,
    platform: input.platform,
    shop_id: input.shop_id,
    item_id: input.item_id,
  })
  const now = Date.now()
  const id = randomUUID()
  const createdAt =
    input.created_at !== undefined &&
    Number.isFinite(input.created_at) &&
    input.created_at > 0
      ? Math.trunc(input.created_at)
      : now

  const product: Product = {
    id,
    platform: resolved.platform,
    original_url: resolved.original_url,
    canonical_key: resolved.canonical_key,
    item_id: resolved.item_id,
    shop_id: resolved.shop_id,
    title: input.title?.trim() || null,
    image_url: input.image_url?.trim() || null,
    image_local:
      input.image_local !== undefined
        ? input.image_local?.trim() || null
        : null,
    price: input.price ?? null,
    currency: input.currency?.trim() || 'VND',
    category: input.category?.trim() || null,
    category_path: input.category_path?.trim() || null,
    shop_name: input.shop_name?.trim() || null,
    rating: input.rating ?? null,
    rating_count: input.rating_count ?? null,
    sold: input.sold ?? null,
    note: input.note?.trim() || null,
    scrape_status: input.scrape_status?.trim() || 'manual',
    scrape_error:
      input.scrape_error !== undefined
        ? input.scrape_error?.trim() || null
        : null,
    created_at: createdAt,
    updated_at: now,
  }

  try {
    db.prepare(
      `INSERT INTO products (
        id, platform, original_url, canonical_key, item_id, shop_id,
        title, image_url, image_local, price, currency, category, category_path, shop_name,
        rating, rating_count, sold,
        note, scrape_status, scrape_error, created_at, updated_at
      ) VALUES (
        @id, @platform, @original_url, @canonical_key, @item_id, @shop_id,
        @title, @image_url, @image_local, @price, @currency, @category, @category_path, @shop_name,
        @rating, @rating_count, @sold,
        @note, @scrape_status, @scrape_error, @created_at, @updated_at
      )`,
    ).run(product)
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new Error(DUPLICATE_MESSAGE)
    }
    throw err
  }

  return product
}

export function getProductById(
  db: Database.Database,
  id: string,
): Product | null {
  const row = db
    .prepare(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ?`)
    .get(id) as ProductRow | undefined
  return row ? mapRow(row) : null
}

/** Lookup by unique canonical_key (used by Excel import duplicate detection). */
export function getProductByCanonicalKey(
  db: Database.Database,
  canonicalKey: string,
): Product | null {
  const row = db
    .prepare(
      `SELECT ${PRODUCT_COLUMNS} FROM products WHERE canonical_key = ?`,
    )
    .get(canonicalKey) as ProductRow | undefined
  return row ? mapRow(row) : null
}

/**
 * Full product rows including original_url, ordered newest-first.
 * Used by Excel export (list/summary path deliberately omits the link).
 */
export function listProductsFull(db: Database.Database): Product[] {
  const rows = db
    .prepare(
      `SELECT ${PRODUCT_COLUMNS} FROM products ORDER BY created_at DESC`,
    )
    .all() as ProductRow[]
  return rows.map(mapRow)
}

/**
 * Build the shared WHERE clause for list + counts so both stay in sync.
 */
function buildListWhere(filter: ListProductsFilter): {
  where: string
  params: Record<string, string | number>
} {
  const conditions: string[] = []
  const params: Record<string, string | number> = {}

  const fts =
    filter.query !== undefined && filter.query !== null
      ? buildFtsMatchQuery(filter.query)
      : null
  if (fts) {
    conditions.push(
      `p.rowid IN (SELECT rowid FROM products_fts WHERE products_fts MATCH @fts)`,
    )
    params.fts = fts
  }

  if (filter.groupId) {
    conditions.push(
      `EXISTS (
        SELECT 1 FROM product_groups pg
        WHERE pg.product_id = p.id AND pg.group_id = @groupId
      )`,
    )
    params.groupId = filter.groupId
  }

  if (filter.platform) {
    conditions.push(`p.platform = @platform`)
    params.platform = filter.platform
  }

  if (filter.priceMin !== undefined && filter.priceMin !== null) {
    conditions.push(`p.price IS NOT NULL AND p.price >= @priceMin`)
    params.priceMin = filter.priceMin
  }

  if (filter.priceMax !== undefined && filter.priceMax !== null) {
    conditions.push(`p.price IS NOT NULL AND p.price <= @priceMax`)
    params.priceMax = filter.priceMax
  }

  if (filter.dateFrom !== undefined && filter.dateFrom !== null) {
    conditions.push(`p.created_at >= @dateFrom`)
    params.dateFrom = filter.dateFrom
  }

  if (filter.dateTo !== undefined && filter.dateTo !== null) {
    conditions.push(`p.created_at <= @dateTo`)
    params.dateTo = filter.dateTo
  }

  if (filter.bucket) {
    conditions.push(BUCKET_SQL[filter.bucket])
  }

  if (filter.categoryPath?.trim()) {
    // Exact branch, or any deeper level under it.
    conditions.push(
      `(p.category_path = @categoryPath OR p.category_path LIKE @categoryPathPrefix)`,
    )
    params.categoryPath = filter.categoryPath.trim()
    params.categoryPathPrefix = `${filter.categoryPath.trim()}${CATEGORY_SEPARATOR}%`
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  }
}

/**
 * Group chips for a set of products, keyed by product id.
 * One query for the whole page — never N+1 from the renderer.
 */
function loadGroupRefs(
  db: Database.Database,
  productIds: string[],
): Map<string, ProductGroupRef[]> {
  const map = new Map<string, ProductGroupRef[]>()
  if (productIds.length === 0) return map

  const rows = db
    .prepare(
      `SELECT pg.product_id AS product_id, g.id AS id, g.name AS name, g.color AS color
       FROM product_groups pg
       INNER JOIN groups g ON g.id = pg.group_id
       ORDER BY g.sort_order ASC, g.name COLLATE NOCASE ASC`,
    )
    .all() as Array<{
    product_id: string
    id: string
    name: string
    color: string | null
  }>

  const wanted = new Set(productIds)
  for (const row of rows) {
    if (!wanted.has(row.product_id)) continue
    const list = map.get(row.product_id)
    const ref: ProductGroupRef = {
      id: row.id,
      name: row.name,
      color: row.color,
    }
    if (list) {
      list.push(ref)
    } else {
      map.set(row.product_id, [ref])
    }
  }
  return map
}

/**
 * List products with optional FTS search, group/platform/price/date/bucket
 * filters, and sort. All filtering runs in SQL (not in the renderer).
 */
export function listProducts(
  db: Database.Database,
  filter: ListProductsFilter = {},
): ProductListItem[] {
  const { where, params } = buildListWhere(filter)

  let orderBy: string
  switch (filter.sort) {
    case 'title':
      orderBy =
        'ORDER BY p.title COLLATE NOCASE ASC, p.created_at DESC'
      break
    case 'price':
      // Null prices last; SQLite has no NULLS LAST on all builds
      orderBy =
        'ORDER BY (p.price IS NULL), p.price ASC, p.created_at DESC'
      break
    case 'most_used':
      // Real copy counts from copy_events (idx_copy_events_product_id).
      orderBy = 'ORDER BY copy_count DESC, p.created_at DESC'
      break
    case 'newest':
    default:
      orderBy = 'ORDER BY p.created_at DESC'
      break
  }

  const sql = `
    SELECT ${PRODUCT_COLUMNS_P},
      (SELECT COUNT(*) FROM copy_events ce WHERE ce.product_id = p.id) AS copy_count
    FROM products p
    ${where}
    ${orderBy}
  `

  const rows = db.prepare(sql).all(params) as Array<
    ProductRow & { copy_count: number }
  >
  const groupsByProduct = loadGroupRefs(
    db,
    rows.map((r) => r.id),
  )

  return rows.map((row) => ({
    ...toSummary(mapRow(row)),
    copy_count: Number(row.copy_count ?? 0),
    groups: groupsByProduct.get(row.id) ?? [],
  }))
}

/** Number of products matching a filter — used for "Hiển thị X / Y". */
export function countProducts(
  db: Database.Database,
  filter: ListProductsFilter = {},
): number {
  const { where, params } = buildListWhere(filter)
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM products p ${where}`)
    .get(params) as { n: number }
  return Number(row.n)
}

/**
 * Distinct categories already in the library, most used first.
 * Feeds the autocomplete in the edit dialog so the same category is not
 * re-typed five slightly different ways.
 */
export function listCategories(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT TRIM(category) AS name, COUNT(*) AS n
       FROM products
       WHERE category IS NOT NULL AND TRIM(category) <> ''
       GROUP BY LOWER(TRIM(category))
       ORDER BY n DESC, name COLLATE NOCASE ASC`,
    )
    .all() as Array<{ name: string; n: number }>
  return rows.map((r) => r.name)
}

/**
 * Category tree built from every stored `category_path`.
 * Each node counts the whole branch beneath it, so the parent total always
 * covers its children — that is what makes the sidebar tree add up.
 */
export function listCategoryTree(db: Database.Database): CategoryNode[] {
  const rows = db
    .prepare(
      `SELECT category_path AS path, COUNT(*) AS n
       FROM products
       WHERE category_path IS NOT NULL AND TRIM(category_path) <> ''
       GROUP BY category_path`,
    )
    .all() as Array<{ path: string; n: number }>

  // path (lowercased) → node
  const nodes = new Map<string, CategoryNode>()

  for (const row of rows) {
    const levels = splitCategoryPath(row.path)
    const count = Number(row.n)
    for (let depth = 0; depth < levels.length; depth++) {
      const path = levels.slice(0, depth + 1).join(CATEGORY_SEPARATOR)
      const key = path.toLowerCase()
      const existing = nodes.get(key)
      if (existing) {
        existing.count += count
      } else {
        nodes.set(key, {
          path,
          name: levels[depth]!,
          depth,
          count,
        })
      }
    }
  }

  // Depth-first so children sit directly under their parent in the sidebar.
  return [...nodes.values()].sort((a, b) =>
    a.path.localeCompare(b.path, 'vi', { sensitivity: 'base' }),
  )
}

/** Sidebar counters — one round trip instead of four list queries. */
export function getProductCounts(db: Database.Database): ProductCounts {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN ${BUCKET_SQL.missing} THEN 1 ELSE 0 END), 0) AS missing,
         COALESCE(SUM(CASE WHEN ${BUCKET_SQL.error} THEN 1 ELSE 0 END), 0) AS err,
         COALESCE(SUM(CASE WHEN ${BUCKET_SQL.ungrouped} THEN 1 ELSE 0 END), 0) AS ungrouped
       FROM products p`,
    )
    .get() as {
    total: number
    missing: number
    err: number
    ungrouped: number
  }
  return {
    total: Number(row.total),
    missing: Number(row.missing),
    error: Number(row.err),
    ungrouped: Number(row.ungrouped),
  }
}

export function updateProduct(
  db: Database.Database,
  input: UpdateProductInput,
): Product {
  const existing = getProductById(db, input.id)
  if (!existing) {
    throw new Error('Không tìm thấy sản phẩm')
  }

  const nextUrl = input.original_url?.trim() ?? existing.original_url
  const urlChanged =
    input.original_url !== undefined &&
    input.original_url.trim() !== existing.original_url

  const nextPlatform =
    input.platform?.trim() ||
    (urlChanged ? detectPlatform(nextUrl) : existing.platform)

  let nextShop: string | null
  let nextItem: string | null

  if (input.shop_id !== undefined || input.item_id !== undefined) {
    nextShop =
      input.shop_id !== undefined
        ? input.shop_id?.trim() || null
        : existing.shop_id
    nextItem =
      input.item_id !== undefined
        ? input.item_id?.trim() || null
        : existing.item_id
  } else if (urlChanged) {
    // Re-derive IDs from the new URL (do not keep stale shop/item).
    const extracted =
      nextPlatform === 'shopee' ? extractShopeeIds(nextUrl) : null
    nextShop = extracted?.shop_id ?? null
    nextItem = extracted?.item_id ?? null
  } else {
    nextShop = existing.shop_id
    nextItem = existing.item_id
  }

  if (
    (!nextShop || !nextItem) &&
    nextPlatform === 'shopee' &&
    (urlChanged || input.shop_id !== undefined || input.item_id !== undefined)
  ) {
    const extracted = extractShopeeIds(nextUrl)
    if (extracted) {
      nextShop = nextShop ?? extracted.shop_id
      nextItem = nextItem ?? extracted.item_id
    }
  }

  const canonical_key = buildCanonicalKey({
    original_url: nextUrl,
    platform: nextPlatform,
    shop_id: nextShop,
    item_id: nextItem,
  })

  const nextCreatedAt =
    input.created_at !== undefined &&
    Number.isFinite(input.created_at) &&
    input.created_at > 0
      ? Math.trunc(input.created_at)
      : existing.created_at

  const updated: Product = {
    ...existing,
    original_url: nextUrl,
    platform: nextPlatform,
    shop_id: nextShop,
    item_id: nextItem,
    canonical_key,
    title:
      input.title !== undefined ? input.title?.trim() || null : existing.title,
    price: input.price !== undefined ? input.price : existing.price,
    currency:
      input.currency !== undefined
        ? input.currency.trim() || 'VND'
        : existing.currency,
    category:
      input.category !== undefined
        ? input.category?.trim() || null
        : existing.category,
    category_path:
      input.category_path !== undefined
        ? input.category_path?.trim() || null
        : existing.category_path,
    shop_name:
      input.shop_name !== undefined
        ? input.shop_name?.trim() || null
        : existing.shop_name,
    rating: input.rating !== undefined ? input.rating : existing.rating,
    rating_count:
      input.rating_count !== undefined
        ? input.rating_count
        : existing.rating_count,
    sold: input.sold !== undefined ? input.sold : existing.sold,
    note: input.note !== undefined ? input.note?.trim() || null : existing.note,
    image_url:
      input.image_url !== undefined
        ? input.image_url?.trim() || null
        : existing.image_url,
    image_local:
      input.image_local !== undefined
        ? input.image_local?.trim() || null
        : existing.image_local,
    scrape_status:
      input.scrape_status !== undefined
        ? input.scrape_status?.trim() || null
        : existing.scrape_status,
    scrape_error:
      input.scrape_error !== undefined
        ? input.scrape_error?.trim() || null
        : existing.scrape_error,
    created_at: nextCreatedAt,
    updated_at: Date.now(),
  }

  try {
    db.prepare(
      `UPDATE products SET
        platform = @platform,
        original_url = @original_url,
        canonical_key = @canonical_key,
        item_id = @item_id,
        shop_id = @shop_id,
        title = @title,
        image_url = @image_url,
        image_local = @image_local,
        price = @price,
        currency = @currency,
        category = @category,
        category_path = @category_path,
        shop_name = @shop_name,
        rating = @rating,
        rating_count = @rating_count,
        sold = @sold,
        note = @note,
        scrape_status = @scrape_status,
        scrape_error = @scrape_error,
        created_at = @created_at,
        updated_at = @updated_at
      WHERE id = @id`,
    ).run(updated)
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new Error(DUPLICATE_MESSAGE)
    }
    throw err
  }

  return updated
}

export function deleteProduct(db: Database.Database, id: string): boolean {
  const result = db.prepare('DELETE FROM products WHERE id = ?').run(id)
  return result.changes > 0
}

/** Delete many products in one transaction (bulk bar in list view). */
export function deleteProducts(
  db: Database.Database,
  ids: string[],
): number {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return 0
  const stmt = db.prepare('DELETE FROM products WHERE id = ?')
  const run = db.transaction((list: string[]) => {
    let removed = 0
    for (const id of list) {
      removed += stmt.run(id).changes
    }
    return removed
  })
  return run(unique) as number
}

/**
 * Full product rows (with original_url) for an explicit id list, ordered
 * newest-first. Used by "Xuất Excel" on a selection.
 */
export function listProductsFullByIds(
  db: Database.Database,
  ids: string[],
): Product[] {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []
  const stmt = db.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ?`,
  )
  const rows = unique
    .map((id) => stmt.get(id) as ProductRow | undefined)
    .filter((row): row is ProductRow => row !== undefined)
  return rows
    .map(mapRow)
    .sort((a, b) => b.created_at - a.created_at)
}
