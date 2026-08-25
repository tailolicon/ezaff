/**
 * Excel export / import (FR-9).
 *
 * Export includes the raw affiliate link — this is the user's own data and
 * is required for backup. Hiding the link is only a UI concern.
 *
 * Import always previews first; nothing is written until confirmImport runs.
 * Invalid rows never crash the app — they land in <ten-file>-loi.xlsx.
 */

import ExcelJS from 'exceljs'
import type Database from 'better-sqlite3'
import { dirname, join } from 'node:path'
import {
  buildCanonicalKey,
  createProduct,
  detectPlatform,
  extractShopeeIds,
  getProductByCanonicalKey,
  listProductsFull,
  listProductsFullByIds,
  normaliseUrl,
  updateProduct,
  type Product,
} from '../db/repositories/productRepo'
import {
  createGroup,
  listGroups,
  listGroupsForProduct,
  setProductGroups,
  type Group,
} from '../db/repositories/groupRepo'
import { getDefaultTemplate } from '../db/repositories/templateRepo'
import { rescrapeProduct } from './scraper/productScrape'
import { logError } from './log'

/** Exact column order for export / import. */
export const EXCEL_HEADERS = [
  'Tên sản phẩm',
  'Link aff',
  'Link gốc',
  'URL ảnh',
  'Nhóm',
  'Sàn',
  'Danh mục',
  'Danh mục đầy đủ',
  'Giá',
  'Tên shop',
  'Đã bán',
  'Ghi chú',
  'Template',
  'Ngày thêm',
] as const

export type ExcelHeader = (typeof EXCEL_HEADERS)[number]

const COLUMN_WIDTHS: Record<ExcelHeader, number> = {
  'Tên sản phẩm': 36,
  'Link aff': 42,
  'Link gốc': 42,
  'URL ảnh': 36,
  Nhóm: 22,
  Sàn: 12,
  'Danh mục': 18,
  'Danh mục đầy đủ': 40,
  Giá: 14,
  'Tên shop': 20,
  'Đã bán': 14,
  'Ghi chú': 28,
  Template: 18,
  'Ngày thêm': 22,
}

const ERROR_REASON_HEADER = 'Lý do'

export type ExportResult = {
  path: string
  count: number
}

export type ParsedImportRow = {
  /** 1-based Excel row number (header is row 1). */
  rowNumber: number
  status: 'valid' | 'duplicate' | 'invalid'
  reason?: string
  /** Original cell values keyed by known header (when present). */
  original: Partial<Record<ExcelHeader, string>>
  /** Validated payload ready for insert/update (valid + duplicate). */
  payload?: ImportRowPayload
}

export type ImportRowPayload = {
  original_url: string
  title: string | null
  image_url: string | null
  groupNames: string[]
  platform: string
  category: string | null
  category_path: string | null
  price: number | null
  shop_name: string | null
  sold: number | null
  note: string | null
  template: string | null
  created_at: number
  canonical_key: string
  shop_id: string | null
  item_id: string | null
}

export type ImportPreview = {
  filePath: string
  validCount: number
  duplicateCount: number
  invalidCount: number
  totalDataRows: number
  rows: ParsedImportRow[]
  /** Which sheet/row/columns the importer recognised. */
  detection: ColumnDetection
}

/** Pause between post-import rescrapes so Shopee does not flag a burst. */
export const RESCRAPE_GAP_MS = 1200

export type ConfirmImportOptions = {
  filePath: string
  /** When true, existing products (by canonical_key) are updated. Default false = skip. */
  overwrite?: boolean
  /**
   * After successful import, queue rescrape for products missing title or image.
   * Default true. Tests may disable to avoid network.
   */
  queueRescrape?: boolean
  /** Inject rescrape (tests). */
  rescrapeFn?: (db: Database.Database, productId: string) => Promise<Product>
  /** Override the pause between rescrapes; 0 disables it (tests). */
  rescrapeGapMs?: number
  /** Called after each product so the UI can refresh as results land. */
  onRescrapeProgress?: (done: number, total: number) => void
}

export type ConfirmImportResult = {
  inserted: number
  updated: number
  skippedDuplicates: number
  invalid: number
  errorFilePath: string | null
  rescrapeQueued: number
}

export type ParseFileResult =
  | { ok: true; preview: ImportPreview }
  | { ok: false; error: string }

// ─── Date helpers (human-readable Vietnamese, round-trips) ───────────────────

/**
 * Format epoch ms as `dd/MM/yyyy HH:mm:ss.SSS` (local time).
 * Milliseconds keep import/export lossless.
 */
export function formatVietnameseDate(ms: number): string {
  const d = new Date(ms)
  if (!Number.isFinite(d.getTime())) return ''
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}`
  )
}

/**
 * Parse human-readable Vietnamese date (and a few fallbacks) back to epoch ms.
 * Accepts:
 * - `dd/MM/yyyy HH:mm:ss.SSS`
 * - `dd/MM/yyyy HH:mm:ss`
 * - `dd/MM/yyyy`
 * - ISO 8601
 * - numeric epoch ms (string or number)
 * - Excel serial date (number, when already converted by caller)
 */
export function parseVietnameseDate(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null

  if (raw instanceof Date) {
    const t = raw.getTime()
    return Number.isFinite(t) ? t : null
  }

  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Epoch ms (plausible range) vs Excel serial day
    if (raw > 1e11) return Math.trunc(raw)
    if (raw > 1e9 && raw < 1e11) return Math.trunc(raw * 1000) // epoch seconds
    // Excel serial: days since 1899-12-30
    if (raw > 20000 && raw < 100000) {
      const excelEpoch = Date.UTC(1899, 11, 30)
      return Math.round(excelEpoch + raw * 86400000)
    }
    return null
  }

  const s = String(raw).trim()
  if (!s) return null

  // Pure numeric string
  if (/^\d+(\.\d+)?$/.test(s)) {
    return parseVietnameseDate(Number(s))
  }

  // dd/MM/yyyy[ HH:mm[:ss[.SSS]]]
  const m = s.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:[.,](\d{1,3}))?)?)?$/,
  )
  if (m) {
    const day = Number(m[1])
    const month = Number(m[2]) - 1
    const year = Number(m[3])
    const hour = m[4] !== undefined ? Number(m[4]) : 0
    const min = m[5] !== undefined ? Number(m[5]) : 0
    const sec = m[6] !== undefined ? Number(m[6]) : 0
    let ms = 0
    if (m[7] !== undefined) {
      ms = Number(m[7].padEnd(3, '0').slice(0, 3))
    }
    const d = new Date(year, month, day, hour, min, sec, ms)
    if (
      d.getFullYear() === year &&
      d.getMonth() === month &&
      d.getDate() === day
    ) {
      return d.getTime()
    }
    return null
  }

  // ISO / Date.parse fallback
  const parsed = Date.parse(s)
  if (Number.isFinite(parsed)) return parsed

  return null
}

// ─── Cell helpers ────────────────────────────────────────────────────────────

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') {
    // Avoid scientific notation for large IDs; keep integers clean
    if (Number.isInteger(value)) return String(value)
    return String(value)
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (value instanceof Date) return formatVietnameseDate(value.getTime())
  if (typeof value === 'object') {
    // Rich text
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText
        .map((r) => r.text)
        .join('')
        .trim()
    }
    // Hyperlink
    if ('text' in value && typeof value.text === 'string') {
      return value.text.trim()
    }
    if ('hyperlink' in value && typeof value.hyperlink === 'string') {
      return value.hyperlink.trim()
    }
    // Formula result
    if ('result' in value) {
      return cellToString(value.result as ExcelJS.CellValue)
    }
    // Error
    if ('error' in value) return ''
  }
  return String(value).trim()
}

/**
 * Vietnamese compact numbers as written by the Shopee affiliate export:
 *   "139,0k" → 139000 · "40k+" → 40000 · "1,2tr" → 1200000 · "6" → 6
 * Returns null when there is no number at all.
 */
export function parseCompactNumber(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/[₫\s+]/g, '')
  if (!s) return null

  const m = s.match(/^([\d.,]+)(k|tr|m|b|nghin|nghìn|trieu|triệu)?$/u)
  if (!m) return null

  let digits = m[1]!
  const unit = m[2]

  if (unit) {
    // With a unit the separator is a decimal comma: "139,0k"
    digits = digits.replace(/\./g, '').replace(',', '.')
  } else {
    // Without a unit both . and , are thousand separators: "1.234.000"
    digits = digits.replace(/[.,]/g, '')
  }

  const n = Number(digits)
  if (!Number.isFinite(n) || n < 0) return null

  const factor =
    unit === 'k' || unit === 'nghin' || unit === 'nghìn'
      ? 1_000
      : unit === 'tr' || unit === 'trieu' || unit === 'triệu' || unit === 'm'
        ? 1_000_000
        : unit === 'b'
          ? 1_000_000_000
          : 1

  return Math.round(n * factor)
}

function parsePrice(raw: string): number | null {
  if (!raw.trim()) return null
  // "139,0k" style must not be read as 1390
  if (/\d\s*(k|tr|m|b)/i.test(raw) || /\d\s*(k|tr|m|b)\+?$/i.test(raw.trim())) {
    const compact = parseCompactNumber(raw)
    if (compact !== null) return compact
  }
  // Strip currency symbols / spaces / thousand separators common in VN
  let s = raw.trim().replace(/[₫đĐ\s]/g, '')
  // 99.000 or 99,000 → 99000; 99.5 → keep if clearly decimal with one sep
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) {
    s = s.replace(/[.,]/g, '')
  } else {
    // mixed: remove thousand dots, keep last comma as decimal? prices are integers
    s = s.replace(/[.,]/g, '')
  }
  // remaining non-digits
  s = s.replace(/[^\d-]/g, '')
  if (!s || s === '-') return null
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.trunc(n)
}

function splitGroupNames(raw: string): string[] {
  if (!raw.trim()) return []
  return raw
    .split(';')
    .map((g) => g.trim())
    .filter((g) => g.length > 0)
}

function isRowEmpty(values: Partial<Record<ExcelHeader, string>>): boolean {
  return EXCEL_HEADERS.every((h) => !values[h]?.trim())
}

function resolvePlatformAndIds(
  url: string,
  platformRaw: string,
): {
  platform: string
  shop_id: string | null
  item_id: string | null
  canonical_key: string
} {
  const platform =
    platformRaw.trim().toLowerCase() || detectPlatform(url)
  let shop_id: string | null = null
  let item_id: string | null = null
  if (platform === 'shopee') {
    const ids = extractShopeeIds(url)
    if (ids) {
      shop_id = ids.shop_id
      item_id = ids.item_id
    }
  }
  const canonical_key = buildCanonicalKey({
    original_url: url,
    platform,
    shop_id,
    item_id,
  })
  return { platform, shop_id, item_id, canonical_key }
}

// ─── Export ──────────────────────────────────────────────────────────────────

/**
 * Write products to an .xlsx file at `filePath`.
 * Pass `productIds` to export only the current selection; omit for everything.
 * Returns count of data rows written.
 */
export async function exportProductsToFile(
  db: Database.Database,
  filePath: string,
  productIds?: string[] | null,
): Promise<ExportResult> {
  const products =
    productIds && productIds.length > 0
      ? listProductsFullByIds(db, productIds)
      : listProductsFull(db)
  const defaultTemplate = getDefaultTemplate(db)
  const templateName = defaultTemplate?.name ?? ''

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'ezaff'
  workbook.created = new Date()
  const sheet = workbook.addWorksheet('Sản phẩm', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })

  sheet.columns = EXCEL_HEADERS.map((header) => ({
    header,
    key: header,
    width: COLUMN_WIDTHS[header],
  }))

  const headerRow = sheet.getRow(1)
  headerRow.font = { bold: true }
  headerRow.commit()

  for (const product of products) {
    const groups = listGroupsForProduct(db, product.id)
    const groupNames = groups.map((g) => g.name).join('; ')
    sheet.addRow({
      'Tên sản phẩm': product.title ?? '',
      'Link aff': product.original_url,
      'URL ảnh': product.image_url ?? '',
      Nhóm: groupNames,
      Sàn: product.platform,
      'Danh mục': product.category ?? '',
      'Danh mục đầy đủ': product.category_path ?? '',
      Giá: product.price ?? '',
      'Link gốc':
        product.shop_id && product.item_id
          ? `https://shopee.vn/product/${product.shop_id}/${product.item_id}`
          : '',
      'Tên shop': product.shop_name ?? '',
      'Đã bán': product.sold ?? '',
      'Ghi chú': product.note ?? '',
      Template: templateName,
      'Ngày thêm': formatVietnameseDate(product.created_at),
    })
  }

  await workbook.xlsx.writeFile(filePath)
  return { path: filePath, count: products.length }
}

// ─── Column detection ────────────────────────────────────────────────────────

/**
 * Strip diacritics/case/punctuation so "Ngày thêm", "NGAY THEM" and
 * "ngay_them" all compare equal.
 */
export function normaliseHeaderText(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

/**
 * Accepted spellings for each column. Users rarely export with ezaff's exact
 * Vietnamese headers — these cover the common hand-made variants.
 */
const HEADER_ALIASES: Record<ExcelHeader, string[]> = {
  'Link aff': [
    // Shopee affiliate export ships BOTH "Link ưu đãi" (has the affiliate
    // code) and "Link sản phẩm" (plain URL). Keep the affiliate one first.
    'linkuudai',
    'linkuudaisanpham',
    'linktiepthi',
    'linkaff',
    'link',
    'links',
    'url',
    'urls',
    'linkaffiliate',
    'affiliatelink',
    'linkafflilate',
    'linkaffilate',
    'linktieptthi',
    'linkmua',
    'linkmuahang',
    'duongdan',
    'duongdansanpham',
    'lienket',
    'diachi',
    'href',
    'linkrutgon',
  ],
  'Tên sản phẩm': [
    'tensanpham',
    'tensp',
    'ten',
    'sanpham',
    'sp',
    'productname',
    'product',
    'name',
    'title',
    'tieude',
    'tenhang',
    'tenmathang',
    'mathang',
  ],
  'URL ảnh': [
    'urlanh',
    'linkanh',
    'anh',
    'hinhanh',
    'hinh',
    'image',
    'images',
    'imageurl',
    'imgurl',
    'img',
    'photo',
    'thumbnail',
    'thumb',
    'anhsanpham',
  ],
  Nhóm: [
    'nhom',
    'nhomsanpham',
    'group',
    'groups',
    'bosuutap',
    'tag',
    'tags',
    'nhan',
    'phanloai',
  ],
  Sàn: [
    'san',
    'santhuongmai',
    'santmdt',
    'santmdtdientu',
    'platform',
    'nentang',
    'marketplace',
    'nguon',
    'source',
    'kenh',
  ],
  'Link gốc': [
    'linksanpham',
    'linkgoc',
    'urlsanpham',
    'producturl',
    'productlink',
    'linksp',
  ],
  'Đã bán': [
    'daban',
    'luotban',
    'doanhthu',
    'sold',
    'soldcount',
    'salevolume',
    'dabantrongthang',
  ],
  'Danh mục đầy đủ': [
    'danhmucdaydu',
    'danhmucphancap',
    'duongdandanhmuc',
    'categorypath',
    'fullcategory',
    'categorytree',
    'breadcrumb',
  ],
  'Danh mục': [
    'danhmuc',
    'category',
    'categories',
    'loai',
    'loaisanpham',
    'nganhhang',
    'nganh',
  ],
  Giá: [
    'gia',
    'giaban',
    'giasp',
    'giasanpham',
    'giatien',
    'dongia',
    'price',
    'amount',
    'cost',
    'giaviet',
    'giavnd',
  ],
  'Tên shop': [
    'tenshop',
    'shop',
    'shopname',
    'cuahang',
    'gianhang',
    'store',
    'storename',
    'seller',
    'nguoiban',
    'nhacungcap',
    'brand',
    'thuonghieu',
  ],
  'Ghi chú': [
    'ghichu',
    'note',
    'notes',
    'comment',
    'comments',
    'mota',
    'description',
    'chuthich',
    'remark',
  ],
  Template: ['template', 'mau', 'maucau', 'maucaumoi', 'mautin', 'mausan'],
  'Ngày thêm': [
    'ngaythem',
    'ngay',
    'ngaytao',
    'ngaynhap',
    'date',
    'createdat',
    'created',
    'thoigian',
    'timestamp',
    'ngaycapnhat',
  ],
}

/**
 * Order used when resolving ambiguous headers: more specific columns claim a
 * cell first, so "Link ảnh" goes to URL ảnh rather than Link aff.
 */
const MATCH_ORDER: ExcelHeader[] = [
  'URL ảnh',
  'Link gốc',
  'Đã bán',
  'Tên shop',
  'Tên sản phẩm',
  'Ngày thêm',
  'Danh mục đầy đủ',
  'Danh mục',
  'Nhóm',
  'Template',
  'Ghi chú',
  'Giá',
  'Sàn',
  'Link aff',
]

/** What the importer worked out about the file — surfaced in the preview. */
export type ColumnDetection = {
  sheetName: string
  /** 1-based row holding the headers, or null when the file has none. */
  headerRowNumber: number | null
  /** First row containing data. */
  firstDataRow: number
  /** Canonical column → label it was recognised from ("URL", "Cột C", …). */
  mapping: Partial<Record<ExcelHeader, string>>
}

type ColumnText = { col: number; raw: string; norm: string }

/** Spreadsheet-style column label: 1 → A, 27 → AA. */
export function columnLabel(col: number): string {
  let n = col
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

function readRowTexts(row: ExcelJS.Row, maxCol: number): ColumnText[] {
  const out: ColumnText[] = []
  for (let col = 1; col <= maxCol; col++) {
    const raw = cellToString(row.getCell(col).value)
    if (!raw) continue
    out.push({ col, raw, norm: normaliseHeaderText(raw) })
  }
  return out
}

/**
 * Rank of a strict match: 0 = best. null = no match.
 *
 * Ranking (not just a boolean) matters because one sheet can hold several
 * plausible columns for the same field — the Shopee affiliate export has both
 * "Link sản phẩm" (plain URL) and "Link ưu đãi" (the affiliate link). The
 * alias order decides which one wins, so the affiliate code is never lost.
 */
function strictRank(header: ExcelHeader, text: ColumnText): number | null {
  if (text.raw.trim() === header) return -1
  const i = HEADER_ALIASES[header].indexOf(text.norm)
  return i === -1 ? null : i
}

/**
 * Short aliases are exact-match only. "san" (Sàn) otherwise matches inside
 * "masanpham" (Mã sản phẩm) and steals that column, which then poisons the
 * platform and the canonical key.
 */
const MIN_LOOSE_ALIAS_LENGTH = 5

function looseRank(header: ExcelHeader, text: ColumnText): number | null {
  const aliases = HEADER_ALIASES[header]
  for (let i = 0; i < aliases.length; i++) {
    const alias = aliases[i]!
    if (alias.length >= MIN_LOOSE_ALIAS_LENGTH && text.norm.includes(alias)) {
      return i
    }
  }
  return null
}

/**
 * Map a candidate header row onto canonical columns.
 * Each spreadsheet column is claimed at most once; strict matches win over
 * fuzzy "contains" matches regardless of column order.
 */
function mapHeaderRow(texts: ColumnText[]): {
  index: Map<ExcelHeader, number>
  labels: Partial<Record<ExcelHeader, string>>
  strictHits: number
} {
  const index = new Map<ExcelHeader, number>()
  const labels: Partial<Record<ExcelHeader, string>> = {}
  const used = new Set<number>()
  let strictHits = 0

  for (const strict of [true, false]) {
    for (const header of MATCH_ORDER) {
      if (index.has(header)) continue

      // Take the column whose alias sits earliest in the list, not merely the
      // leftmost column that matches at all.
      let best: { text: ColumnText; rank: number } | null = null
      for (const text of texts) {
        if (used.has(text.col)) continue
        const rank = strict
          ? strictRank(header, text)
          : looseRank(header, text)
        if (rank === null) continue
        if (!best || rank < best.rank) best = { text, rank }
      }

      if (!best) continue
      index.set(header, best.text.col)
      labels[header] = best.text.raw
      used.add(best.text.col)
      if (strict) strictHits += 1
    }
  }

  return { index, labels, strictHits }
}

const URL_RE = /^https?:\/\/\S+$/i
const IMAGE_URL_RE = /\.(jpe?g|png|webp|gif|avif)(\?|$)/i

/** How many rows to sample when guessing columns in a header-less file. */
const SAMPLE_ROWS = 60

/**
 * No usable header row: work out the columns from the data itself.
 * Only the link column is required; the rest are best-effort and any column we
 * cannot identify is simply left empty for the scraper to fill in later.
 */
function detectHeaderlessColumns(
  sheet: ExcelJS.Worksheet,
  firstRow: number,
  maxCol: number,
): {
  index: Map<ExcelHeader, number>
  labels: Partial<Record<ExcelHeader, string>>
} {
  const lastRow = Math.min(sheet.rowCount, firstRow + SAMPLE_ROWS - 1)
  const stats = new Map<
    number,
    {
      filled: number
      urls: number
      imageUrls: number
      prices: number
      dates: number
      textLen: number
    }
  >()

  for (let r = firstRow; r <= lastRow; r++) {
    const row = sheet.getRow(r)
    for (let col = 1; col <= maxCol; col++) {
      const raw = cellToString(row.getCell(col).value)
      if (!raw) continue
      const s =
        stats.get(col) ??
        { filled: 0, urls: 0, imageUrls: 0, prices: 0, dates: 0, textLen: 0 }
      s.filled += 1
      s.textLen += raw.length
      if (URL_RE.test(raw)) {
        s.urls += 1
        if (IMAGE_URL_RE.test(raw)) s.imageUrls += 1
      } else {
        const price = parsePrice(raw)
        // Guard against quantity/index columns — VN prices are ≥ 1.000 ₫
        if (price !== null && price >= 1000) s.prices += 1
        if (/[/-]/.test(raw) && parseVietnameseDate(raw) !== null) s.dates += 1
      }
      stats.set(col, s)
    }
  }

  const index = new Map<ExcelHeader, number>()
  const labels: Partial<Record<ExcelHeader, string>> = {}
  const used = new Set<number>()

  const claim = (header: ExcelHeader, col: number | undefined): void => {
    if (col === undefined || used.has(col)) return
    index.set(header, col)
    labels[header] = `Cột ${columnLabel(col)}`
    used.add(col)
  }

  const entries = [...stats.entries()]

  // Product link: most non-image URLs.
  const linkCol = entries
    .filter(([, s]) => s.urls - s.imageUrls > 0)
    .sort((a, b) => b[1].urls - b[1].imageUrls - (a[1].urls - a[1].imageUrls))[0]?.[0]
  claim('Link aff', linkCol)

  // Image link: any other column that is mostly URLs.
  const imageCol = entries
    .filter(([col, s]) => !used.has(col) && s.urls >= Math.ceil(s.filled / 2))
    .sort((a, b) => b[1].urls - a[1].urls)[0]?.[0]
  claim('URL ảnh', imageCol)

  const priceCol = entries
    .filter(([col, s]) => !used.has(col) && s.prices >= Math.ceil(s.filled / 2))
    .sort((a, b) => b[1].prices - a[1].prices)[0]?.[0]
  claim('Giá', priceCol)

  const dateCol = entries
    .filter(([col, s]) => !used.has(col) && s.dates >= Math.ceil(s.filled / 2))
    .sort((a, b) => b[1].dates - a[1].dates)[0]?.[0]
  claim('Ngày thêm', dateCol)

  // Longest free text left over is almost always the product name.
  const titleCol = entries
    .filter(([col, s]) => !used.has(col) && s.filled > 0 && s.urls === 0)
    .sort((a, b) => b[1].textLen / b[1].filled - a[1].textLen / a[1].filled)[0]?.[0]
  claim('Tên sản phẩm', titleCol)

  return { index, labels }
}

/** How many rows from the top may hold titles/notes before the real header. */
const HEADER_SEARCH_ROWS = 15

/**
 * Locate the header row (anywhere in the first rows) and map its columns.
 * Falls back to content-based detection when the sheet has no header at all.
 */
function detectColumns(
  sheet: ExcelJS.Worksheet,
):
  | {
      index: Map<ExcelHeader, number>
      detection: ColumnDetection
    }
  | { error: string } {
  const maxCol = Math.max(sheet.columnCount, 1)
  const lastSearchRow = Math.min(sheet.rowCount, HEADER_SEARCH_ROWS)

  let best: {
    rowNumber: number
    index: Map<ExcelHeader, number>
    labels: Partial<Record<ExcelHeader, string>>
    strictHits: number
  } | null = null

  for (let r = 1; r <= lastSearchRow; r++) {
    const texts = readRowTexts(sheet.getRow(r), maxCol)
    if (texts.length === 0) continue
    // A row full of links is data, not a header.
    if (texts.some((t) => URL_RE.test(t.raw))) continue

    const mapped = mapHeaderRow(texts)
    if (!mapped.index.has('Link aff')) continue
    if (mapped.strictHits === 0) continue
    if (!best || mapped.strictHits > best.strictHits) {
      best = { rowNumber: r, ...mapped }
    }
  }

  if (best) {
    return {
      index: best.index,
      detection: {
        sheetName: sheet.name,
        headerRowNumber: best.rowNumber,
        firstDataRow: best.rowNumber + 1,
        mapping: best.labels,
      },
    }
  }

  // No header → find the first row that actually contains a link and guess.
  let firstDataRow = 0
  const scanLimit = Math.min(sheet.rowCount, HEADER_SEARCH_ROWS)
  for (let r = 1; r <= scanLimit; r++) {
    const texts = readRowTexts(sheet.getRow(r), maxCol)
    if (texts.some((t) => URL_RE.test(t.raw))) {
      firstDataRow = r
      break
    }
  }

  if (firstDataRow === 0) {
    return {
      error:
        'Không tìm thấy cột chứa link trong file. Hãy đảm bảo có một cột chứa link sản phẩm (bắt đầu bằng http:// hoặc https://), hoặc đặt tên cột là «Link aff».',
    }
  }

  const guessed = detectHeaderlessColumns(sheet, firstDataRow, maxCol)
  if (!guessed.index.has('Link aff')) {
    return {
      error:
        'Không tìm thấy cột chứa link trong file. Hãy đảm bảo có một cột chứa link sản phẩm (bắt đầu bằng http:// hoặc https://), hoặc đặt tên cột là «Link aff».',
    }
  }

  return {
    index: guessed.index,
    detection: {
      sheetName: sheet.name,
      headerRowNumber: null,
      firstDataRow,
      mapping: guessed.labels,
    },
  }
}

// ─── Parse / preview ─────────────────────────────────────────────────────────

function readOriginalCells(
  row: ExcelJS.Row,
  headerIndex: Map<ExcelHeader, number>,
): Partial<Record<ExcelHeader, string>> {
  const original: Partial<Record<ExcelHeader, string>> = {}
  for (const header of EXCEL_HEADERS) {
    const col = headerIndex.get(header)
    if (col === undefined) {
      original[header] = ''
      continue
    }
    original[header] = cellToString(row.getCell(col).value)
  }
  return original
}

function validateRow(
  original: Partial<Record<ExcelHeader, string>>,
  db: Database.Database,
  seenKeys: Set<string>,
): Pick<ParsedImportRow, 'status' | 'reason' | 'payload'> {
  const link = (original['Link aff'] ?? '').trim()
  if (!link) {
    return { status: 'invalid', reason: 'Thiếu link affiliate (cột «Link aff»).' }
  }

  // Validate URL
  try {
    normaliseUrl(link)
  } catch {
    // also try URL constructor for non-normalisable but valid-ish urls
    try {
      // eslint-disable-next-line no-new
      new URL(link)
    } catch {
      return {
        status: 'invalid',
        reason: `Link không hợp lệ: ${link}`,
      }
    }
  }

  // Must be http(s)
  try {
    const u = new URL(link)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return {
        status: 'invalid',
        reason: 'Link phải bắt đầu bằng http:// hoặc https://.',
      }
    }
  } catch {
    return { status: 'invalid', reason: `Link không hợp lệ: ${link}` }
  }

  const priceRaw = original['Giá'] ?? ''
  let price: number | null = null
  if (priceRaw.trim()) {
    price = parsePrice(priceRaw)
    if (price === null) {
      return {
        status: 'invalid',
        reason: `Giá không hợp lệ: «${priceRaw}».`,
      }
    }
  }

  const dateRaw = original['Ngày thêm'] ?? ''
  let created_at = Date.now()
  if (dateRaw.trim()) {
    const parsed = parseVietnameseDate(dateRaw)
    if (parsed === null) {
      return {
        status: 'invalid',
        reason: `Ngày thêm không hợp lệ: «${dateRaw}». Định dạng: dd/MM/yyyy HH:mm:ss.SSS`,
      }
    }
    created_at = parsed
  }

  const platformRaw = original['Sàn'] ?? ''
  let resolved: ReturnType<typeof resolvePlatformAndIds>
  try {
    // A shortlink (s.shopee.vn/…) hides the ids. When the file also carries the
    // plain product URL, key off that so the row matches products added in-app
    // and lines up with the owner-link mapping.
    const sourceUrl = (original['Link gốc'] ?? '').trim()
    const idsUrl =
      sourceUrl && extractShopeeIds(sourceUrl) ? sourceUrl : link
    resolved = resolvePlatformAndIds(idsUrl, platformRaw)
  } catch (err) {
    return {
      status: 'invalid',
      reason: err instanceof Error ? err.message : String(err),
    }
  }

  const existing = getProductByCanonicalKey(db, resolved.canonical_key)
  const payload: ImportRowPayload = {
    original_url: link.trim(),
    title: (original['Tên sản phẩm'] ?? '').trim() || null,
    image_url: (original['URL ảnh'] ?? '').trim() || null,
    groupNames: splitGroupNames(original['Nhóm'] ?? ''),
    platform: resolved.platform,
    category: (original['Danh mục'] ?? '').trim() || null,
    category_path: (original['Danh mục đầy đủ'] ?? '').trim() || null,
    price,
    shop_name: (original['Tên shop'] ?? '').trim() || null,
    sold: parseCompactNumber(original['Đã bán'] ?? ''),
    note: (original['Ghi chú'] ?? '').trim() || null,
    template: (original['Template'] ?? '').trim() || null,
    created_at,
    canonical_key: resolved.canonical_key,
    shop_id: resolved.shop_id,
    item_id: resolved.item_id,
  }

  if (existing || seenKeys.has(resolved.canonical_key)) {
    seenKeys.add(resolved.canonical_key)
    return {
      status: 'duplicate',
      reason: existing
        ? 'Sản phẩm đã tồn tại (trùng canonical_key).'
        : 'Trùng link với dòng khác trong cùng file (canonical_key).',
      payload,
    }
  }

  seenKeys.add(resolved.canonical_key)
  return { status: 'valid', payload }
}

/**
 * Parse an .xlsx file into a preview (no DB writes).
 * Malformed / non-xlsx files return `{ ok: false, error }` — never throw.
 */
export async function previewImportFromFile(
  db: Database.Database,
  filePath: string,
): Promise<ParseFileResult> {
  try {
    const workbook = new ExcelJS.Workbook()
    const isCsv = filePath.toLowerCase().endsWith('.csv')
    try {
      if (isCsv) {
        // Shopee's affiliate export is UTF-8 with a BOM; ExcelJS keeps the BOM
        // on the first header cell, which would break header matching.
        await workbook.csv.readFile(filePath, {
          parserOptions: { bom: true },
        } as unknown as Parameters<typeof workbook.csv.readFile>[1])
      } else {
        await workbook.xlsx.readFile(filePath)
      }
    } catch {
      return {
        ok: false,
        error: isCsv
          ? 'Không đọc được file CSV. Hãy chọn file xuất từ Shopee Affiliate hoặc từ ezaff.'
          : 'Không đọc được file. Hãy chọn file Excel (.xlsx) hoặc CSV hợp lệ.',
      }
    }

    if (workbook.worksheets.length === 0) {
      return {
        ok: false,
        error: 'File Excel không có sheet nào.',
      }
    }

    // Try every sheet — the links are not always on the first one.
    let sheet: ExcelJS.Worksheet | null = null
    let headerIndex: Map<ExcelHeader, number> | null = null
    let detection: ColumnDetection | null = null
    let lastError = ''

    for (const candidate of workbook.worksheets) {
      if (candidate.rowCount === 0) continue
      const result = detectColumns(candidate)
      if ('error' in result) {
        lastError = result.error
        continue
      }
      sheet = candidate
      headerIndex = result.index
      detection = result.detection
      break
    }

    if (!sheet || !headerIndex || !detection) {
      return {
        ok: false,
        error:
          lastError ||
          'Không tìm thấy cột chứa link trong file. Hãy đảm bảo có một cột chứa link sản phẩm (bắt đầu bằng http:// hoặc https://), hoặc đặt tên cột là «Link aff».',
      }
    }

    const rows: ParsedImportRow[] = []
    let validCount = 0
    let duplicateCount = 0
    let invalidCount = 0
    let totalDataRows = 0
    const seenKeys = new Set<string>()

    const maxRow = sheet.rowCount
    for (let r = detection.firstDataRow; r <= maxRow; r++) {
      const row = sheet.getRow(r)
      const original = readOriginalCells(row, headerIndex)
      if (isRowEmpty(original)) {
        continue
      }
      totalDataRows += 1
      const result = validateRow(original, db, seenKeys)
      const parsed: ParsedImportRow = {
        rowNumber: r,
        status: result.status,
        reason: result.reason,
        original,
        payload: result.payload,
      }
      rows.push(parsed)
      if (result.status === 'valid') validCount += 1
      else if (result.status === 'duplicate') duplicateCount += 1
      else invalidCount += 1
    }

    return {
      ok: true,
      preview: {
        filePath,
        validCount,
        duplicateCount,
        invalidCount,
        totalDataRows,
        rows,
        detection,
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: `Lỗi khi đọc file Excel: ${message}`,
    }
  }
}

// ─── Error file ──────────────────────────────────────────────────────────────

/**
 * "<tên file nguồn>-loi.xlsx" — the name the import preview promises the user
 * before they confirm, so the two never disagree.
 */
export function errorFileName(sourcePath: string): string {
  const base = sourcePath.split(/[/\\]/).pop() || sourcePath
  return `${base.replace(/\.xlsx$/i, '')}-loi.xlsx`
}

async function writeErrorFile(
  sourcePath: string,
  invalidRows: ParsedImportRow[],
): Promise<string | null> {
  if (invalidRows.length === 0) return null

  const errorPath = join(dirname(sourcePath), errorFileName(sourcePath))

  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Dòng lỗi', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })

  const headers = [...EXCEL_HEADERS, ERROR_REASON_HEADER]
  sheet.columns = headers.map((header) => ({
    header,
    key: header,
    width:
      header === ERROR_REASON_HEADER
        ? 40
        : COLUMN_WIDTHS[header as ExcelHeader] ?? 16,
  }))
  sheet.getRow(1).font = { bold: true }

  for (const row of invalidRows) {
    const data: Record<string, string> = {}
    for (const h of EXCEL_HEADERS) {
      data[h] = row.original[h] ?? ''
    }
    data[ERROR_REASON_HEADER] = row.reason ?? 'Không xác định'
    sheet.addRow(data)
  }

  await workbook.xlsx.writeFile(errorPath)
  return errorPath
}

// ─── Confirm import ──────────────────────────────────────────────────────────

function ensureGroupsByName(
  db: Database.Database,
  names: string[],
  cache: Map<string, Group>,
): string[] {
  const ids: string[] = []
  for (const name of names) {
    const key = name.toLowerCase()
    let group = cache.get(key)
    if (!group) {
      // Refresh from DB in case another path created it
      const all = listGroups(db)
      for (const g of all) {
        cache.set(g.name.toLowerCase(), g)
      }
      group = cache.get(key)
    }
    if (!group) {
      try {
        group = createGroup(db, { name })
      } catch (err) {
        // Race: name unique conflict — re-list
        const all = listGroups(db)
        for (const g of all) {
          cache.set(g.name.toLowerCase(), g)
        }
        group = cache.get(key)
        if (!group) {
          throw err
        }
      }
      cache.set(key, group)
    }
    ids.push(group.id)
  }
  return ids
}

/**
 * Commit import after preview. Re-parses the file for safety.
 * Duplicates are skipped unless overwrite=true.
 * Invalid rows → <ten-file>-loi.xlsx next to the source file.
 * Missing title/image → background rescrape queue (non-blocking).
 */
export async function confirmImport(
  db: Database.Database,
  options: ConfirmImportOptions,
): Promise<ConfirmImportResult> {
  const overwrite = options.overwrite === true
  const queueRescrape = options.queueRescrape !== false

  const parsed = await previewImportFromFile(db, options.filePath)
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }

  const { preview } = parsed
  const invalidRows = preview.rows.filter((r) => r.status === 'invalid')
  const errorFilePath = await writeErrorFile(options.filePath, invalidRows)

  let inserted = 0
  let updated = 0
  let skippedDuplicates = 0
  const rescrapeIds: string[] = []

  const groupCache = new Map<string, Group>()
  for (const g of listGroups(db)) {
    groupCache.set(g.name.toLowerCase(), g)
  }

  const run = db.transaction(() => {
    for (const row of preview.rows) {
      if (row.status === 'invalid' || !row.payload) continue

      const p = row.payload
      const existing = getProductByCanonicalKey(db, p.canonical_key)

      if (existing) {
        if (!overwrite) {
          skippedDuplicates += 1
          continue
        }
        const product = updateProduct(db, {
          id: existing.id,
          original_url: p.original_url,
          title: p.title,
          image_url: p.image_url,
          platform: p.platform,
          category: p.category,
          category_path: p.category_path,
          price: p.price,
          shop_name: p.shop_name,
          sold: p.sold,
          note: p.note,
          shop_id: p.shop_id,
          item_id: p.item_id,
          created_at: p.created_at,
          scrape_status: 'manual',
          scrape_error: null,
        })
        const groupIds = ensureGroupsByName(db, p.groupNames, groupCache)
        setProductGroups(db, product.id, groupIds)
        updated += 1
        if (!product.title || !product.image_url) {
          rescrapeIds.push(product.id)
        }
        continue
      }

      const product = createProduct(db, {
        original_url: p.original_url,
        title: p.title,
        image_url: p.image_url,
        platform: p.platform,
        category: p.category,
        price: p.price,
        shop_name: p.shop_name,
        sold: p.sold,
        note: p.note,
        shop_id: p.shop_id,
        item_id: p.item_id,
        created_at: p.created_at,
        // Rows without an image get queued below; show "đang quét" not "nhập tay"
        scrape_status: p.image_url ? 'manual' : 'scraping',
        scrape_error: null,
      })
      const groupIds = ensureGroupsByName(db, p.groupNames, groupCache)
      setProductGroups(db, product.id, groupIds)
      inserted += 1
      if (!product.title || !product.image_url) {
        rescrapeIds.push(product.id)
      }
    }
  })
  run()

  // Background rescrape — one at a time.
  //
  // Firing every import in parallel is what made bulk imports come back empty:
  // Shopee's traffic verification trips on a burst and blocks nearly all of
  // them. Sequential with a small gap is slower but actually returns data.
  if (queueRescrape && rescrapeIds.length > 0) {
    const rescrape = options.rescrapeFn ?? rescrapeProduct
    const onProgress = options.onRescrapeProgress
    void (async () => {
      for (let i = 0; i < rescrapeIds.length; i++) {
        const id = rescrapeIds[i]!
        try {
          await rescrape(db, id)
        } catch (err) {
          logError('[ezaff] Rescrape after import failed:', id, err)
        }
        onProgress?.(i + 1, rescrapeIds.length)
        if (i < rescrapeIds.length - 1 && options.rescrapeGapMs !== 0) {
          await new Promise((r) =>
            setTimeout(r, options.rescrapeGapMs ?? RESCRAPE_GAP_MS),
          )
        }
      }
    })()
  }

  return {
    inserted,
    updated,
    skippedDuplicates,
    invalid: invalidRows.length,
    errorFilePath,
    rescrapeQueued: queueRescrape ? rescrapeIds.length : 0,
  }
}
