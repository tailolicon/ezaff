import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import ExcelJS from 'exceljs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createGroup,
  listGroupsForProduct,
  setProductGroups,
} from '../db/repositories/groupRepo'
import {
  createProduct,
  getProductByCanonicalKey,
  listProductsFull,
} from '../db/repositories/productRepo'
import { createTemplate } from '../db/repositories/templateRepo'
import { createTestDb } from '../db/repositories/testDb'
import {
  EXCEL_HEADERS,
  confirmImport,
  parseCompactNumber,
  exportProductsToFile,
  formatVietnameseDate,
  parseVietnameseDate,
  previewImportFromFile,
} from './excel.service'

describe('formatVietnameseDate / parseVietnameseDate', () => {
  it('round-trips epoch ms with milliseconds', () => {
    const ms = new Date(2026, 7, 6, 14, 30, 45, 123).getTime() // local Aug 6
    const formatted = formatVietnameseDate(ms)
    expect(formatted).toMatch(/^\d{2}\/\d{2}\/2026 \d{2}:\d{2}:\d{2}\.123$/)
    expect(parseVietnameseDate(formatted)).toBe(ms)
  })

  it('parses date-only and ISO', () => {
    const d = parseVietnameseDate('06/08/2026')
    expect(d).not.toBeNull()
    const iso = parseVietnameseDate('2026-08-06T10:00:00.000Z')
    expect(iso).toBe(Date.parse('2026-08-06T10:00:00.000Z'))
  })
})

describe('excel.service', () => {
  let db: Database.Database
  let tmpDir: string

  beforeEach(() => {
    db = createTestDb()
    tmpDir = mkdtempSync(join(tmpdir(), 'ezaff-excel-'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  /**
   * Build a row in EXCEL_HEADERS order from named fields, so adding a column
   * to the export never silently shifts these fixtures.
   */
  function row(
    values: Partial<Record<(typeof EXCEL_HEADERS)[number], string>>,
  ): string[] {
    return EXCEL_HEADERS.map((h) => values[h] ?? '')
  }

  async function writeCustomWorkbook(
    filePath: string,
    headers: string[],
    rows: unknown[][],
  ): Promise<void> {
    const wb = new ExcelJS.Workbook()
    const sheet = wb.addWorksheet('Sản phẩm')
    sheet.addRow(headers)
    for (const row of rows) {
      sheet.addRow(row)
    }
    await wb.xlsx.writeFile(filePath)
  }

  it('round-trip: xuất rồi nhập lại giữ nguyên mọi trường (nhóm, giá, ghi chú, ngày, template cột)', async () => {
    // Template exists in library (export fills Template column with default name)
    createTemplate(db, {
      name: 'Video TikTok',
      content: 'sản phẩm em dùng trong video:{link}',
      is_default: true,
    })

    const g1 = createGroup(db, { name: 'Skincare', color: '#0f6b4c' })
    const g2 = createGroup(db, { name: 'Hot deal', color: '#b45309' })

    const fixedMs = new Date(2026, 0, 15, 9, 5, 30, 456).getTime()

    const p1 = createProduct(db, {
      original_url: 'https://shopee.vn/product/111/222',
      title: 'Serum vitamin C',
      price: 199000,
      category: 'Làm đẹp',
      shop_name: 'Shop A',
      note: 'Dùng buổi sáng',
      image_url: 'https://example.com/serum.jpg',
      platform: 'shopee',
      created_at: fixedMs,
    })
    setProductGroups(db, p1.id, [g1.id, g2.id])

    const p2 = createProduct(db, {
      original_url: 'https://www.lazada.vn/products/ao-thun-i123.html',
      title: 'Áo thun basic',
      price: 89000,
      note: null,
      image_url: null,
      platform: 'lazada',
      created_at: fixedMs + 1000,
    })
    setProductGroups(db, p2.id, [g1.id])

    const exportPath = join(tmpDir, 'backup.xlsx')
    const exported = await exportProductsToFile(db, exportPath)
    expect(exported.count).toBe(2)
    expect(existsSync(exportPath)).toBe(true)

    // Clean database — simulate import on another machine
    db.close()
    db = createTestDb()
    createTemplate(db, {
      name: 'Video TikTok',
      content: 'sản phẩm em dùng trong video:{link}',
      is_default: true,
    })

    const preview = await previewImportFromFile(db, exportPath)
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.preview.validCount).toBe(2)
    expect(preview.preview.duplicateCount).toBe(0)
    expect(preview.preview.invalidCount).toBe(0)

    const result = await confirmImport(db, {
      filePath: exportPath,
      queueRescrape: false,
    })
    expect(result.inserted).toBe(2)
    expect(result.invalid).toBe(0)
    expect(result.errorFilePath).toBeNull()

    const products = listProductsFull(db)
    expect(products).toHaveLength(2)

    const serum = getProductByCanonicalKey(db, 'shopee:111:222')
    expect(serum).not.toBeNull()
    expect(serum!.title).toBe('Serum vitamin C')
    expect(serum!.original_url).toBe('https://shopee.vn/product/111/222')
    expect(serum!.price).toBe(199000)
    expect(serum!.category).toBe('Làm đẹp')
    expect(serum!.shop_name).toBe('Shop A')
    expect(serum!.note).toBe('Dùng buổi sáng')
    expect(serum!.image_url).toBe('https://example.com/serum.jpg')
    expect(serum!.platform).toBe('shopee')
    expect(serum!.created_at).toBe(fixedMs)

    const serumGroups = listGroupsForProduct(db, serum!.id).map((g) => g.name)
    expect(serumGroups.sort()).toEqual(['Hot deal', 'Skincare'])

    const ao = products.find((p) => p.platform === 'lazada')
    expect(ao).toBeDefined()
    expect(ao!.title).toBe('Áo thun basic')
    expect(ao!.price).toBe(89000)
    expect(ao!.created_at).toBe(fixedMs + 1000)
    const aoGroups = listGroupsForProduct(db, ao!.id).map((g) => g.name)
    expect(aoGroups).toEqual(['Skincare'])

    // Template column present in exported file
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(exportPath)
    const sheet = wb.worksheets[0]
    const headers = (sheet.getRow(1).values as unknown[])
      .slice(1)
      .map(String)
    expect(headers).toEqual([...EXCEL_HEADERS])
    // Template column value = default template name
    const templateCol = headers.indexOf('Template') + 1
    const cell = sheet.getRow(2).getCell(templateCol).value
    expect(String(cell)).toBe('Video TikTok')
  })

  it('duplicate rows are detected and skipped by default', async () => {
    createProduct(db, {
      original_url: 'https://shopee.vn/product/1/2',
      title: 'Đã có',
      price: 1000,
    })

    const path = join(tmpDir, 'dup.xlsx')
    await writeCustomWorkbook(
      path,
      [...EXCEL_HEADERS],
      [
        row({
          'Tên sản phẩm': 'Mới',
          'Link aff': 'https://shopee.vn/product/1/2',
          Sàn: 'shopee',
          Giá: '2000',
          'Ngày thêm': formatVietnameseDate(Date.now()),
        }),
        row({
          'Tên sản phẩm': 'Khác',
          'Link aff': 'https://shopee.vn/product/9/8',
          Nhóm: 'Nhóm mới',
          Sàn: 'shopee',
          Giá: '3000',
          'Ngày thêm': formatVietnameseDate(Date.now()),
        }),
      ],
    )

    const preview = await previewImportFromFile(db, path)
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.preview.duplicateCount).toBe(1)
    expect(preview.preview.validCount).toBe(1)

    const result = await confirmImport(db, {
      filePath: path,
      overwrite: false,
      queueRescrape: false,
    })
    expect(result.skippedDuplicates).toBe(1)
    expect(result.inserted).toBe(1)
    expect(result.updated).toBe(0)

    const existing = getProductByCanonicalKey(db, 'shopee:1:2')
    expect(existing!.title).toBe('Đã có')
    expect(existing!.price).toBe(1000)
    expect(listProductsFull(db)).toHaveLength(2)
  })

  it('overwrite checkbox path updates duplicate rows', async () => {
    createProduct(db, {
      original_url: 'https://shopee.vn/product/1/2',
      title: 'Cũ',
      price: 1000,
    })

    const path = join(tmpDir, 'overwrite.xlsx')
    await writeCustomWorkbook(
      path,
      [...EXCEL_HEADERS],
      [
        row({
          'Tên sản phẩm': 'Mới',
          'Link aff': 'https://shopee.vn/product/1/2',
          'URL ảnh': 'https://img.example/a.jpg',
          Nhóm: 'Flash',
          Sàn: 'shopee',
          'Danh mục': 'Cat',
          Giá: '9999',
          'Tên shop': 'Shop X',
          'Ghi chú': 'Note X',
          'Ngày thêm': formatVietnameseDate(1_700_000_000_000),
        }),
      ],
    )

    const result = await confirmImport(db, {
      filePath: path,
      overwrite: true,
      queueRescrape: false,
    })
    expect(result.updated).toBe(1)
    expect(result.inserted).toBe(0)

    const p = getProductByCanonicalKey(db, 'shopee:1:2')!
    expect(p.title).toBe('Mới')
    expect(p.price).toBe(9999)
    expect(p.note).toBe('Note X')
    expect(listGroupsForProduct(db, p.id).map((g) => g.name)).toEqual([
      'Flash',
    ])
  })

  it('invalid rows land in error file with Vietnamese reason', async () => {
    const path = join(tmpDir, 'mixed.xlsx')
    await writeCustomWorkbook(
      path,
      [...EXCEL_HEADERS],
      [
        row({
          'Tên sản phẩm': 'OK',
          'Link aff': 'https://shopee.vn/product/5/6',
          Sàn: 'shopee',
          Giá: '100',
          'Ngày thêm': formatVietnameseDate(Date.now()),
        }),
        row({ 'Tên sản phẩm': 'Bad link', 'Link aff': 'not-a-url' }),
        row({
          'Tên sản phẩm': 'Bad price',
          'Link aff': 'https://shopee.vn/product/7/8',
          Sàn: 'shopee',
          Giá: 'abc',
        }),
      ],
    )

    const preview = await previewImportFromFile(db, path)
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.preview.validCount).toBe(1)
    expect(preview.preview.invalidCount).toBe(2)

    const result = await confirmImport(db, {
      filePath: path,
      queueRescrape: false,
    })
    expect(result.inserted).toBe(1)
    expect(result.invalid).toBe(2)
    expect(result.errorFilePath).not.toBeNull()
    expect(existsSync(result.errorFilePath!)).toBe(true)
    expect(result.errorFilePath!).toMatch(/-loi\.xlsx$/)

    const errWb = new ExcelJS.Workbook()
    await errWb.xlsx.readFile(result.errorFilePath!)
    const errSheet = errWb.worksheets[0]
    // Header + 2 invalid rows
    expect(errSheet.rowCount).toBeGreaterThanOrEqual(3)
    // "Lý do" is appended after every data column — find it rather than
    // hard-coding an index that shifts whenever a column is added.
    const reasonCol = EXCEL_HEADERS.length + 1
    const reasonHeader = String(errSheet.getRow(1).getCell(reasonCol).value)
    expect(reasonHeader).toBe('Lý do')
    const reason1 = String(errSheet.getRow(2).getCell(reasonCol).value)
    const reason2 = String(errSheet.getRow(3).getCell(reasonCol).value)
    expect(reason1.length).toBeGreaterThan(0)
    expect(reason2.length).toBeGreaterThan(0)
    // At least one mentions link or price
    const reasons = `${reason1} ${reason2}`
    expect(/link|giá|hợp lệ/i.test(reasons)).toBe(true)

    // File sits next to import source
    const siblings = readdirSync(tmpDir)
    expect(siblings.some((f) => f.endsWith('-loi.xlsx'))).toBe(true)
  })

  it('malformed / non-xlsx file produces error result rather than throwing', async () => {
    const badPath = join(tmpDir, 'not-excel.xlsx')
    writeFileSync(badPath, 'this is not a real xlsx file at all')

    const preview = await previewImportFromFile(db, badPath)
    expect(preview.ok).toBe(false)
    if (preview.ok) return
    expect(preview.error).toMatch(/không đọc được|hợp lệ|excel/i)

    // Also missing file
    const missing = await previewImportFromFile(
      db,
      join(tmpDir, 'does-not-exist.xlsx'),
    )
    expect(missing.ok).toBe(false)
  })

  it('missing and reordered columns are handled', async () => {
    // Reordered: Link aff first, then title; missing optional columns OK
    const path = join(tmpDir, 'reordered.xlsx')
    await writeCustomWorkbook(
      path,
      ['Link aff', 'Tên sản phẩm', 'Giá', 'Nhóm', 'Extra Col'],
      [
        [
          'https://shopee.vn/product/33/44',
          'SP reorder',
          '50000',
          'Auto Group',
          'ignored',
        ],
        // empty row should be skipped
        ['', '', '', '', ''],
        // numbers as text
        [
          'https://shopee.vn/product/55/66',
          'Giá text',
          '1.250.000',
          '',
          '',
        ],
      ],
    )

    const preview = await previewImportFromFile(db, path)
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.preview.validCount).toBe(2)
    expect(preview.preview.invalidCount).toBe(0)

    const result = await confirmImport(db, {
      filePath: path,
      queueRescrape: false,
    })
    expect(result.inserted).toBe(2)

    const a = getProductByCanonicalKey(db, 'shopee:33:44')!
    expect(a.title).toBe('SP reorder')
    expect(a.price).toBe(50000)
    expect(listGroupsForProduct(db, a.id).map((g) => g.name)).toEqual([
      'Auto Group',
    ])

    const b = getProductByCanonicalKey(db, 'shopee:55:66')!
    expect(b.price).toBe(1250000)
  })

  it('file missing Link aff column returns clear Vietnamese error', async () => {
    const path = join(tmpDir, 'no-link-col.xlsx')
    await writeCustomWorkbook(
      path,
      ['Tên sản phẩm', 'Giá'],
      [['ABC', '100']],
    )

    const preview = await previewImportFromFile(db, path)
    expect(preview.ok).toBe(false)
    if (preview.ok) return
    expect(preview.error).toMatch(/Link aff/i)
  })

  it('creates missing groups automatically on import', async () => {
    const path = join(tmpDir, 'groups.xlsx')
    await writeCustomWorkbook(
      path,
      [...EXCEL_HEADERS],
      [
        row({
          'Tên sản phẩm': 'P',
          'Link aff': 'https://shopee.vn/product/70/80',
          Nhóm: 'Alpha; Beta; Alpha',
          Sàn: 'shopee',
        }),
      ],
    )

    await confirmImport(db, { filePath: path, queueRescrape: false })
    const p = getProductByCanonicalKey(db, 'shopee:70:80')!
    const names = listGroupsForProduct(db, p.id).map((g) => g.name).sort()
    expect(names).toEqual(['Alpha', 'Beta'])
  })
  // ─── Flexible column detection ────────────────────────────────────────────

  /** Write a sheet with an arbitrary shape (extra rows above, any names). */
  async function writeRawSheet(
    filePath: string,
    rows: unknown[][],
    sheetName = 'Sheet1',
  ): Promise<void> {
    const wb = new ExcelJS.Workbook()
    const sheet = wb.addWorksheet(sheetName)
    for (const row of rows) sheet.addRow(row)
    await wb.xlsx.writeFile(filePath)
  }

  it('nhận diện cột dù tên khác, thiếu dấu và đảo thứ tự', async () => {
    const path = join(tmpDir, 'khac-ten.xlsx')
    await writeRawSheet(path, [
      ['GIA BAN', 'Ten SP', 'URL', 'Cua hang'],
      ['199.000', 'Serum vitamin C', 'https://shopee.vn/product/11/22', 'Shop A'],
    ])

    const parsed = await previewImportFromFile(db, path)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.preview.validCount).toBe(1)
    expect(parsed.preview.detection.headerRowNumber).toBe(1)
    const row = parsed.preview.rows[0]
    expect(row.payload?.title).toBe('Serum vitamin C')
    expect(row.payload?.price).toBe(199000)
    expect(row.payload?.shop_name).toBe('Shop A')
  })

  it('bỏ qua các dòng tiêu đề/ghi chú phía trên bảng', async () => {
    const path = join(tmpDir, 'co-dong-thua.xlsx')
    await writeRawSheet(path, [
      ['BẢNG LINK AFFILIATE THÁNG 7'],
      [],
      ['Tên sản phẩm', 'Link aff', 'Giá'],
      ['Nồi chiên', 'https://shopee.vn/product/33/44', '1290000'],
      ['Kem chống nắng', 'https://shopee.vn/product/33/45', '520000'],
    ])

    const parsed = await previewImportFromFile(db, path)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.preview.detection.headerRowNumber).toBe(3)
    expect(parsed.preview.detection.firstDataRow).toBe(4)
    expect(parsed.preview.validCount).toBe(2)
    expect(parsed.preview.totalDataRows).toBe(2)
  })

  it('file chỉ có link, không có tiêu đề → vẫn nhập được', async () => {
    const path = join(tmpDir, 'chi-co-link.xlsx')
    await writeRawSheet(path, [
      ['https://shopee.vn/product/55/66'],
      ['https://shopee.vn/product/55/67'],
      ['https://shopee.vn/product/55/68'],
    ])

    const parsed = await previewImportFromFile(db, path)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.preview.detection.headerRowNumber).toBeNull()
    expect(parsed.preview.detection.firstDataRow).toBe(1)
    expect(parsed.preview.validCount).toBe(3)
  })

  it('không tiêu đề: đoán được cột tên, giá và ảnh theo nội dung', async () => {
    const path = join(tmpDir, 'khong-tieu-de.xlsx')
    await writeRawSheet(path, [
      [
        'Nồi chiên không dầu Lock&Lock 5.5L điện tử',
        'https://shopee.vn/product/77/88',
        '1290000',
        'https://cdn.example.com/a.jpg',
      ],
      [
        'Kem chống nắng Anessa Perfect UV 60ml',
        'https://shopee.vn/product/77/89',
        '520000',
        'https://cdn.example.com/b.jpg',
      ],
    ])

    const parsed = await previewImportFromFile(db, path)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.preview.validCount).toBe(2)
    const row = parsed.preview.rows[0]
    expect(row.payload?.title).toBe(
      'Nồi chiên không dầu Lock&Lock 5.5L điện tử',
    )
    expect(row.payload?.price).toBe(1290000)
    expect(row.payload?.image_url).toBe('https://cdn.example.com/a.jpg')
  })

  it('tìm sang sheet khác khi sheet đầu không có link', async () => {
    const path = join(tmpDir, 'nhieu-sheet.xlsx')
    const wb = new ExcelJS.Workbook()
    const intro = wb.addWorksheet('Hướng dẫn')
    intro.addRow(['Điền link vào sheet "Data"'])
    const data = wb.addWorksheet('Data')
    data.addRow(['Ten', 'Link'])
    data.addRow(['Bàn phím Akko', 'https://shopee.vn/product/99/11'])
    await wb.xlsx.writeFile(path)

    const parsed = await previewImportFromFile(db, path)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.preview.detection.sheetName).toBe('Data')
    expect(parsed.preview.validCount).toBe(1)
  })

  it('"Link ảnh" không bị nhầm thành cột link sản phẩm', async () => {
    const path = join(tmpDir, 'link-anh.xlsx')
    await writeRawSheet(path, [
      ['Tên', 'Link ảnh', 'Link mua hàng'],
      [
        'Loa JBL Go 4',
        'https://cdn.example.com/jbl.jpg',
        'https://shopee.vn/product/12/34',
      ],
    ])

    const parsed = await previewImportFromFile(db, path)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const row = parsed.preview.rows[0]
    expect(row.payload?.original_url).toBe('https://shopee.vn/product/12/34')
    expect(row.payload?.image_url).toBe('https://cdn.example.com/jbl.jpg')
  })

  it('báo lỗi rõ ràng khi file hoàn toàn không có link', async () => {
    const path = join(tmpDir, 'khong-co-link.xlsx')
    await writeRawSheet(path, [
      ['Họ tên', 'Số điện thoại'],
      ['Nguyễn Văn A', '0900000000'],
    ])

    const parsed = await previewImportFromFile(db, path)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('link')
  })

  it('nhập thật được từ file tên cột lạ (end-to-end)', async () => {
    const path = join(tmpDir, 'e2e-la.xlsx')
    await writeRawSheet(path, [
      ['STT', 'Product Name', 'Affiliate Link', 'Price', 'Store'],
      [1, 'Chuột Logitech M331', 'https://shopee.vn/product/21/43', 315000, 'Logitech Official'],
    ])

    const result = await confirmImport(db, {
      filePath: path,
      queueRescrape: false,
    })
    expect(result.inserted).toBe(1)

    const p = getProductByCanonicalKey(db, 'shopee:21:43')!
    expect(p.title).toBe('Chuột Logitech M331')
    expect(p.price).toBe(315000)
    expect(p.shop_name).toBe('Logitech Official')
  })

  // ─── Shopee Affiliate CSV export ──────────────────────────────────────────

  it('parseCompactNumber đọc số rút gọn kiểu Việt', () => {
    expect(parseCompactNumber('139,0k')).toBe(139_000)
    expect(parseCompactNumber('356,0k')).toBe(356_000)
    expect(parseCompactNumber('40k+')).toBe(40_000)
    expect(parseCompactNumber('1,2tr')).toBe(1_200_000)
    expect(parseCompactNumber('6')).toBe(6)
    expect(parseCompactNumber('1.234.000')).toBe(1_234_000)
    expect(parseCompactNumber('')).toBeNull()
    expect(parseCompactNumber('n/a')).toBeNull()
  })

  it('nhập được file CSV thật xuất từ Shopee Affiliate', async () => {
    const fixture = join(
      __dirname,
      '__fixtures__',
      'shopee-affiliate-export.csv',
    )
    const parsed = await previewImportFromFile(db, fixture)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.preview.validCount).toBe(4)
    expect(parsed.preview.invalidCount).toBe(0)

    const first = parsed.preview.rows[0]!.payload!
    // "Link ưu đãi" must win over "Link sản phẩm" — otherwise the affiliate
    // code is silently dropped and the user loses their commission.
    expect(first.original_url).toBe('https://s.shopee.vn/1BLOJC7PMt')
    // ids come from the plain product URL a shortlink cannot carry
    expect(first.canonical_key).toBe('shopee:1016604648:23258487489')
    expect(first.shop_id).toBe('1016604648')
    expect(first.item_id).toBe('23258487489')
    // "139,0k" is 139.000đ, not 1.390
    expect(first.price).toBe(139_000)
    expect(first.title).toContain('Giấy vệ sinh treo tường Top Gia')
    expect(first.shop_name).toBe('TopGia HCM Store')
    expect(first.sold).toBe(40_000)
  })


  it('quét lại tuần tự sau khi nhập, không dội cùng lúc', async () => {
    const fixture = join(
      __dirname,
      '__fixtures__',
      'shopee-affiliate-export.csv',
    )

    let inFlight = 0
    let maxInFlight = 0
    const order: string[] = []
    const progress: Array<[number, number]> = []

    const result = await confirmImport(db, {
      filePath: fixture,
      queueRescrape: true,
      rescrapeGapMs: 0,
      rescrapeFn: async (_db, id) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        order.push(id)
        await new Promise((r) => setTimeout(r, 5))
        inFlight -= 1
        return getProductByCanonicalKey(db, 'shopee:1016604648:23258487489')!
      },
      onRescrapeProgress: (done, total) => progress.push([done, total]),
    })

    // CSV carries no image, so every imported row needs a scrape
    expect(result.rescrapeQueued).toBe(4)

    await vi.waitFor(() => expect(progress).toHaveLength(4))
    // The whole point: never more than one request to Shopee at a time
    expect(maxInFlight).toBe(1)
    expect(order).toHaveLength(4)
    expect(progress.at(-1)).toEqual([4, 4])
  })

  it('sản phẩm nhập từ CSV hiện trạng thái đang quét, không phải nhập tay', async () => {
    const fixture = join(
      __dirname,
      '__fixtures__',
      'shopee-affiliate-export.csv',
    )
    await confirmImport(db, { filePath: fixture, queueRescrape: false })
    const p = getProductByCanonicalKey(db, 'shopee:1016604648:23258487489')!
    expect(p.scrape_status).toBe('scraping')
  })

  it('nhập CSV Shopee vào thư viện (end-to-end)', async () => {
    const fixture = join(
      __dirname,
      '__fixtures__',
      'shopee-affiliate-export.csv',
    )
    const result = await confirmImport(db, {
      filePath: fixture,
      queueRescrape: false,
    })
    expect(result.inserted).toBe(4)
    expect(result.invalid).toBe(0)

    const p = getProductByCanonicalKey(db, 'shopee:1654674476:51401292730')!
    expect(p.original_url).toBe('https://s.shopee.vn/1LeoVV6m1w')
    expect(p.price).toBe(356_000)
    expect(p.shop_name).toBe('Cửa hàng bán buôn hàng điện tử')
    expect(p.platform).toBe('shopee')
  })

})
