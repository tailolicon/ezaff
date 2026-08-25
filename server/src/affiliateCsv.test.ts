import { describe, expect, it } from 'vitest'
import {
  extractIdsFromProductUrl,
  parseAffiliateCsv,
  parseCommissionPercent,
  parseCsv,
  toKvBulk,
} from './affiliateCsv'

const HEADER =
  'Mã sản phẩm,Tên sản phẩm,Giá,Doanh thu,Tên cửa hàng,Tỉ lệ hoa hồng,Hoa hồng,Link sản phẩm,Link ưu đãi'

/** Row shaped exactly like the real Shopee export. */
function row(
  itemId: string,
  name: string,
  shopId: string,
  short: string,
  rate = '12%',
): string {
  return `${itemId},"${name}","139,0k",40k+,Shop A,${rate},₫16.680,https://shopee.vn/product/${shopId}/${itemId},${short}`
}

describe('parseCsv', () => {
  it('handles the BOM, quoted fields and commas inside quotes', () => {
    const text = '﻿a,b\n1,"x, y"\n'
    expect(parseCsv(text)).toEqual([
      ['a', 'b'],
      ['1', 'x, y'],
    ])
  })

  it('handles escaped double quotes', () => {
    expect(parseCsv('a\n"say ""hi"""')).toEqual([['a'], ['say "hi"']])
  })
})

describe('extractIdsFromProductUrl', () => {
  it('reads /product/{shopId}/{itemId}', () => {
    expect(
      extractIdsFromProductUrl('https://shopee.vn/product/1016604648/23258487489'),
    ).toEqual({ shopId: '1016604648', itemId: '23258487489' })
  })

  it('reads the slug form -i.{shopId}.{itemId}', () => {
    expect(extractIdsFromProductUrl('https://shopee.vn/ao-thun-i.111.222')).toEqual({
      shopId: '111',
      itemId: '222',
    })
  })

  it('returns null when there are no ids', () => {
    expect(extractIdsFromProductUrl('https://shopee.vn/mall')).toBeNull()
  })
})

describe('parseCommissionPercent', () => {
  it('reads whole and decimal percents', () => {
    expect(parseCommissionPercent('12%')).toBe(12)
    expect(parseCommissionPercent('5,5%')).toBe(5.5)
    expect(parseCommissionPercent('')).toBeNull()
    expect(parseCommissionPercent('n/a')).toBeNull()
  })
})

describe('parseAffiliateCsv', () => {
  it('maps a real-shaped export to owner links', () => {
    const csv = [
      HEADER,
      row('23258487489', 'Giấy vệ sinh Top Gia', '1016604648', 'https://s.shopee.vn/1BLOJC7PMt'),
      row('51401292730', 'Sạc dự phòng 20000mAh', '1654674476', 'https://s.shopee.vn/1LeoVV6m1w', '53%'),
    ].join('\n')

    const report = parseAffiliateCsv(csv)

    expect(report.skipped).toEqual([])
    expect(report.mappings).toHaveLength(2)
    expect(report.mappings[0]).toEqual({
      platform: 'shopee',
      shopId: '1016604648',
      itemId: '23258487489',
      ownerUrl: 'https://s.shopee.vn/1BLOJC7PMt',
      key: 'owner:shopee:1016604648:23258487489',
      commissionPercent: 12,
    })
    expect(report.mappings[1]!.commissionPercent).toBe(53)
  })

  it('produces the exact KV key the mappingTable provider reads', () => {
    const csv = [HEADER, row('222', 'X', '111', 'https://s.shopee.vn/abc')].join('\n')
    expect(toKvBulk(parseAffiliateCsv(csv).mappings)).toEqual([
      { key: 'owner:shopee:111:222', value: 'https://s.shopee.vn/abc' },
    ])
  })

  it('keeps the last row when the same product appears twice', () => {
    const csv = [
      HEADER,
      row('222', 'X', '111', 'https://s.shopee.vn/old'),
      row('222', 'X', '111', 'https://s.shopee.vn/new'),
    ].join('\n')

    const report = parseAffiliateCsv(csv)
    expect(report.duplicates).toBe(1)
    expect(report.mappings).toHaveLength(1)
    expect(report.mappings[0]!.ownerUrl).toBe('https://s.shopee.vn/new')
  })

  it('reports bad rows instead of dropping them silently', () => {
    const csv = [
      HEADER,
      row('222', 'ok', '111', 'https://s.shopee.vn/good'),
      // owner link missing
      `333,"no link","1k",1,Shop,12%,₫1,https://shopee.vn/product/111/333,`,
      // owner link points somewhere else entirely
      `444,"bad host","1k",1,Shop,12%,₫1,https://shopee.vn/product/111/444,https://evil.com/x`,
      // product URL has no ids
      `555,"no ids","1k",1,Shop,12%,₫1,https://shopee.vn/mall,https://s.shopee.vn/z`,
    ].join('\n')

    const report = parseAffiliateCsv(csv)
    expect(report.mappings).toHaveLength(1)
    expect(report.skipped.map((s) => s.row)).toEqual([3, 4, 5])
  })

  it('rejects a file that is not the Shopee export', () => {
    const report = parseAffiliateCsv('foo,bar\n1,2')
    expect(report.mappings).toEqual([])
    expect(report.skipped[0]!.reason).toMatch(/Link sản phẩm|Link ưu đãi/)
  })
})
