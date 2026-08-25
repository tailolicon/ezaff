import { describe, expect, it } from 'vitest'
import { formatVnd, renderTemplate } from './templateRenderer'

describe('templateRenderer', () => {
  it('thay thế đủ bốn biến {link} {ten} {gia} {shop}', () => {
    const out = renderTemplate(
      'Mua {ten} giá {gia} tại {shop}: {link}',
      {
        link: 'https://s.shopee.vn/abc123',
        ten: 'Áo thun',
        gia: 99000,
        shop: 'Shop ABC',
      },
    )
    expect(out).toBe(
      'Mua Áo thun giá 99.000 ₫ tại Shop ABC: https://s.shopee.vn/abc123',
    )
  })

  it('thiếu {link} trong nội dung → tự nối link vào cuối', () => {
    const out = renderTemplate('sản phẩm em dùng trong video', {
      link: 'https://s.shopee.vn/xyz',
      ten: 'SP',
    })
    expect(out).toBe(
      'sản phẩm em dùng trong video https://s.shopee.vn/xyz',
    )
  })

  it('mẫu mặc định: sản phẩm em dùng trong video:{link}', () => {
    const out = renderTemplate(
      'sản phẩm em dùng trong video:{link}',
      { link: 'https://s.shopee.vn/abc123' },
    )
    expect(out).toBe(
      'sản phẩm em dùng trong video:https://s.shopee.vn/abc123',
    )
  })

  it('biến lạ {foo} giữ nguyên, không crash', () => {
    const out = renderTemplate('xin chào {foo} {ten}', {
      ten: 'Lan',
      link: 'https://x.test/l',
    })
    expect(out).toContain('{foo}')
    expect(out).toContain('Lan')
  })

  it('giá trị null/thiếu → chuỗi rỗng, không double space / separator thừa', () => {
    const out = renderTemplate('{ten} - {gia} - {shop} {link}', {
      link: 'https://s.shopee.vn/a',
      ten: null,
      gia: null,
      shop: null,
    })
    expect(out).not.toMatch(/  /)
    expect(out).not.toMatch(/-\s*-/)
    expect(out).toBe('https://s.shopee.vn/a')

    const partial = renderTemplate('Xin chào {ten}! {link}', {
      ten: null,
      link: 'https://x.test/1',
    })
    expect(partial).not.toMatch(/  /)
    expect(partial).toContain('https://x.test/1')
  })

  it('{gia} định dạng tiền Việt', () => {
    expect(formatVnd(1500000)).toBe('1.500.000 ₫')
    const out = renderTemplate('Giá: {gia}', { gia: 25000, link: 'L' })
    expect(out).toContain('25.000 ₫')
  })

  it('nội dung rỗng + không có {link} → chỉ còn link', () => {
    const out = renderTemplate('', { link: 'https://only.link' })
    expect(out).toBe('https://only.link')
  })
})
