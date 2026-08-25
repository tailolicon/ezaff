/**
 * Parse the "Lấy link sản phẩm hàng loạt" CSV exported from the Shopee
 * Affiliate dashboard into owner-link mappings.
 *
 * Export columns (2026-08):
 *   Mã sản phẩm, Tên sản phẩm, Giá, Doanh thu, Tên cửa hàng,
 *   Tỉ lệ hoa hồng, Hoa hồng, Link sản phẩm, Link ưu đãi
 *
 * `Link sản phẩm` carries the shopId that `Mã sản phẩm` alone does not:
 *   https://shopee.vn/product/{shopId}/{itemId}
 * `Link ưu đãi` is the author's affiliate short link.
 *
 * Pure — no I/O, no Worker globals — so it is unit tested and never bundled
 * into the Worker (nothing reachable from src/index.ts imports it).
 */

export type OwnerMapping = {
  platform: 'shopee'
  shopId: string
  itemId: string
  ownerUrl: string
  /** KV key the mappingTable provider reads. */
  key: string
  /** Commission percent when the export includes it — used for prioritising. */
  commissionPercent: number | null
}

export type ParseReport = {
  mappings: OwnerMapping[]
  /** Rows the parser refused, with a reason, so nothing fails silently. */
  skipped: Array<{ row: number; reason: string }>
  /** Later rows replace earlier ones for the same product. */
  duplicates: number
}

/** Minimal RFC4180 reader: handles quoted fields, embedded commas and "". */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!

    if (quoted) {
      if (c === '"') {
        if (clean[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += c
      }
      continue
    }

    if (c === '"') {
      quoted = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') {
      field += c
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

/** shopId + itemId out of https://shopee.vn/product/{shopId}/{itemId}. */
export function extractIdsFromProductUrl(
  url: string,
): { shopId: string; itemId: string } | null {
  const m = url.trim().match(/\/product\/(\d+)\/(\d+)/)
  if (m) return { shopId: m[1]!, itemId: m[2]! }
  // Slug form: …-i.{shopId}.{itemId}
  const slug = url.trim().match(/-i\.(\d+)\.(\d+)/)
  if (slug) return { shopId: slug[1]!, itemId: slug[2]! }
  return null
}

/** "12%" → 12; "" / garbage → null. */
export function parseCommissionPercent(raw: string): number | null {
  const m = raw.trim().match(/(\d+(?:[.,]\d+)?)\s*%/)
  if (!m) return null
  const n = Number(m[1]!.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

function isShopeeShortLink(url: string): boolean {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase().replace(/^www\./, '')
    return (
      host === 's.shopee.vn' ||
      host === 'shp.ee' ||
      host === 'shope.ee' ||
      host.endsWith('.shopee.vn')
    )
  } catch {
    return false
  }
}

/** Column header → index, tolerant of case and surrounding spaces. */
function headerIndex(header: string[]): Map<string, number> {
  const map = new Map<string, number>()
  header.forEach((name, i) => {
    map.set(name.trim().toLowerCase(), i)
  })
  return map
}

export const KEY_PREFIX = 'owner'

export function mappingKey(shopId: string, itemId: string): string {
  return `${KEY_PREFIX}:shopee:${shopId}:${itemId}`
}

/**
 * Turn one exported CSV into owner-link mappings.
 * Bad rows are reported, never silently dropped.
 */
export function parseAffiliateCsv(text: string): ParseReport {
  const rows = parseCsv(text)
  const skipped: Array<{ row: number; reason: string }> = []

  if (rows.length === 0) {
    return { mappings: [], skipped: [{ row: 0, reason: 'File rỗng' }], duplicates: 0 }
  }

  const idx = headerIndex(rows[0]!)
  const productCol = idx.get('link sản phẩm')
  const ownerCol = idx.get('link ưu đãi')
  const itemCol = idx.get('mã sản phẩm')
  const rateCol = idx.get('tỉ lệ hoa hồng')

  if (productCol === undefined || ownerCol === undefined) {
    return {
      mappings: [],
      skipped: [
        {
          row: 1,
          reason:
            'Thiếu cột «Link sản phẩm» hoặc «Link ưu đãi» — hãy dùng file xuất từ Shopee Affiliate',
        },
      ],
      duplicates: 0,
    }
  }

  const byKey = new Map<string, OwnerMapping>()
  let duplicates = 0

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!
    const rowNumber = r + 1
    const productUrl = (row[productCol] ?? '').trim()
    const ownerUrl = (row[ownerCol] ?? '').trim()

    if (!productUrl && !ownerUrl) continue

    if (!ownerUrl) {
      skipped.push({ row: rowNumber, reason: 'Thiếu «Link ưu đãi»' })
      continue
    }
    if (!isShopeeShortLink(ownerUrl)) {
      skipped.push({ row: rowNumber, reason: `Link ưu đãi không hợp lệ: ${ownerUrl}` })
      continue
    }

    let ids = extractIdsFromProductUrl(productUrl)
    // Fall back to the item-id column when the product URL is an odd shape.
    if (!ids && itemCol !== undefined) {
      const itemId = (row[itemCol] ?? '').trim()
      if (/^\d+$/.test(itemId)) {
        skipped.push({
          row: rowNumber,
          reason: `Không lấy được shopId từ «Link sản phẩm» (itemId ${itemId})`,
        })
        continue
      }
    }
    if (!ids) {
      skipped.push({ row: rowNumber, reason: 'Không đọc được shopId/itemId' })
      continue
    }

    const key = mappingKey(ids.shopId, ids.itemId)
    if (byKey.has(key)) duplicates++

    byKey.set(key, {
      platform: 'shopee',
      shopId: ids.shopId,
      itemId: ids.itemId,
      ownerUrl,
      key,
      commissionPercent:
        rateCol !== undefined ? parseCommissionPercent(row[rateCol] ?? '') : null,
    })
  }

  return { mappings: [...byKey.values()], skipped, duplicates }
}

/** Shape accepted by `wrangler kv bulk put`. */
export function toKvBulk(
  mappings: OwnerMapping[],
): Array<{ key: string; value: string }> {
  return mappings.map((m) => ({ key: m.key, value: m.ownerUrl }))
}
