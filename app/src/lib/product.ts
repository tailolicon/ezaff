import { productImageSrc } from './format'

/** Palette used when a group has no colour of its own (mockup order). */
export const GROUP_COLORS = [
  '#0f6b4c',
  '#1d4ed8',
  '#b45309',
  '#be123c',
  '#6d28d9',
  '#0e7490',
] as const

/** Deterministic fallback colour so a group looks the same everywhere. */
export function groupColor(
  color: string | null | undefined,
  index = 0,
): string {
  const trimmed = color?.trim()
  if (trimmed) return trimmed
  return GROUP_COLORS[index % GROUP_COLORS.length]
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  let value = m[1]
  if (value.length === 3) {
    value = value
      .split('')
      .map((c) => c + c)
      .join('')
  }
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ]
}

/** Chip style from the mockup: solid text colour on a 12% tint of itself. */
export function groupChipStyle(
  color: string | null | undefined,
  index = 0,
): { color: string; background: string } {
  const base = groupColor(color, index)
  const rgb = hexToRgb(base)
  return {
    color: base,
    background: rgb
      ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.12)`
      : 'rgba(15, 107, 76, 0.12)',
  }
}

export type StatusTone =
  | 'done'
  | 'partial'
  | 'scraping'
  | 'error'
  | 'muted'

export type ProductState = {
  tone: StatusTone
  /** Badge text, e.g. "Xong" / "Thiếu ảnh" / "Lỗi — nhập tay". */
  label: string
  /** True while the scraper is running for this product. */
  busy: boolean
  /** Product has no usable image. */
  needsImage: boolean
  /** Scrape failed or data is incomplete — user should fill it in. */
  needsManual: boolean
}

type StatusInput = {
  scrape_status: string | null
  scrape_error: string | null
  title: string | null
  price: number | null
  image_url: string | null
  image_local: string | null
}

/**
 * Single source of truth for the status badge shown on cards and rows.
 * Mirrors the wording used in the mockup.
 */
export function deriveProductState(
  product: StatusInput,
  rescraping = false,
): ProductState {
  const status = rescraping ? 'scraping' : product.scrape_status
  const needsImage = !productImageSrc(product.image_local, product.image_url)

  if (status === 'scraping') {
    return {
      tone: 'scraping',
      label: 'Đang quét…',
      busy: true,
      needsImage,
      needsManual: false,
    }
  }

  if (status === 'error') {
    return {
      tone: 'error',
      label: 'Lỗi — nhập tay',
      busy: false,
      needsImage,
      needsManual: true,
    }
  }

  const missingTitle = !product.title?.trim()
  const missingPrice = product.price === null || product.price === undefined

  if (needsImage && !missingTitle && !missingPrice) {
    return {
      tone: 'partial',
      label: 'Thiếu ảnh',
      busy: false,
      needsImage,
      needsManual: true,
    }
  }

  if (status === 'partial' || missingTitle || missingPrice || needsImage) {
    return {
      tone: 'partial',
      label: 'Thiếu thông tin',
      busy: false,
      needsImage,
      needsManual: true,
    }
  }

  if (status === 'done') {
    return {
      tone: 'done',
      label: 'Xong',
      busy: false,
      needsImage: false,
      needsManual: false,
    }
  }

  return {
    tone: 'muted',
    label: status?.trim() === 'manual' ? 'Nhập tay' : 'Chưa quét',
    busy: false,
    needsImage,
    needsManual: true,
  }
}

/** What is actually missing — do not say "shop" when the shop name is present. */
export function missingFieldsHint(
  product: StatusInput & { shop_name?: string | null; price?: number | null },
  state: ProductState,
): string {
  const bits: string[] = []
  if (state.needsImage) bits.push('ảnh')
  if (!product.shop_name?.trim()) bits.push('shop')
  if (product.price === null || product.price === undefined) bits.push('giá')
  if (!product.title?.trim()) bits.push('tên')
  if (bits.length === 0) return 'Cần bổ sung thông tin'
  return `Cần bổ sung ${bits.join(', ')}`
}

/** Secondary line under the title in the list view. */
export function listSubtitle(
  product: StatusInput & { shop_name: string | null },
  state: ProductState,
): { text: string; tone: 'muted' | 'warn' | 'error' } {
  if (state.tone === 'error') {
    return { text: 'Không quét được — cần nhập tay', tone: 'error' }
  }
  if (state.label === 'Thiếu ảnh') {
    return { text: 'Thiếu ảnh sản phẩm', tone: 'warn' }
  }
  if (state.tone === 'partial') {
    return { text: missingFieldsHint(product, state), tone: 'warn' }
  }
  return { text: product.shop_name?.trim() || 'Chưa có tên shop', tone: 'muted' }
}
