/** Format integer price as Vietnamese đồng (e.g. 99.000 ₫). */
export function formatPrice(
  price: number | null | undefined,
  currency = 'VND',
): string {
  if (price === null || price === undefined) {
    return 'Chưa có giá'
  }
  const formatted = new Intl.NumberFormat('vi-VN').format(price)
  if (currency === 'VND') {
    return `${formatted} ₫`
  }
  return `${formatted} ${currency}`
}

/** Mask affiliate URL for display: https://s.shopee.vn/****** */
export function maskAffiliateUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}/******`
  } catch {
    return '******'
  }
}

const PLATFORM_LABELS: Record<string, string> = {
  shopee: 'Shopee',
  lazada: 'Lazada',
  tiki: 'Tiki',
  tiktok: 'TikTok',
  sendo: 'Sendo',
  other: 'Khác',
}

export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform
}

/**
 * Resolve product image for <img src>.
 * Prefer remote https CDN URLs — sandboxed Electron renderer cannot load bare
 * Windows paths like C:\\Users\\...\\images\\x.jpg (that's why cards showed empty).
 * Local paths are converted to file:// when remote is missing.
 */
export function productImageSrc(
  imageLocal: string | null | undefined,
  imageUrl: string | null | undefined,
): string | null {
  const remote = imageUrl?.trim() || ''
  if (/^https?:\/\//i.test(remote)) return remote

  const local = imageLocal?.trim() || ''
  if (!local) return remote || null
  if (/^https?:\/\//i.test(local) || /^file:/i.test(local)) return local

  // Windows absolute path → file URL
  const normalized = local.replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`
  }
  if (normalized.startsWith('/')) {
    return `file://${encodeURI(normalized)}`
  }
  return local
}

/** Format product rating for cards, e.g. "★ 4.89 (34.988)". */
export function formatRating(
  rating: number | null | undefined,
  ratingCount?: number | null,
): string | null {
  if (rating == null || !Number.isFinite(rating) || rating <= 0) return null
  const stars = Number.isInteger(rating)
    ? String(rating)
    : rating.toFixed(2).replace(/\.?0+$/, '')
  if (ratingCount != null && Number.isFinite(ratingCount) && ratingCount > 0) {
    const count = new Intl.NumberFormat('vi-VN').format(Math.round(ratingCount))
    return `★ ${stars} (${count})`
  }
  return `★ ${stars}`
}

/** Format sold count, e.g. "Đã bán 1.2k" / "Đã bán 500". */
export function formatSold(sold: number | null | undefined): string | null {
  if (sold == null || !Number.isFinite(sold) || sold < 0) return null
  const n = Math.round(sold)
  if (n >= 1_000_000) {
    return `Đã bán ${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}tr`
  }
  if (n >= 1_000) {
    return `Đã bán ${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  }
  return `Đã bán ${new Intl.NumberFormat('vi-VN').format(n)}`
}

/** Thousands-separated Vietnamese integer, e.g. 1.248. */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '0'
  return new Intl.NumberFormat('vi-VN').format(Math.round(n))
}

/** Compact sold count in the mockup's style: 12,3k / 1,2tr / 500. */
export function formatSoldShort(sold: number | null | undefined): string | null {
  if (sold == null || !Number.isFinite(sold) || sold <= 0) return null
  const n = Math.round(sold)
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace('.', ',').replace(/,0$/, '')}tr`
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1).replace('.', ',').replace(/,0$/, '')}k`
  }
  return formatCount(n)
}

/**
 * Card meta line exactly as the mockup renders it: "4,9★ · 12,3k đã bán".
 * The star sits after the number, which is how both the mockup and Shopee
 * itself write it — a bare "4,9" reads like a price or a count.
 * Returns null when neither value is known.
 */
export function formatRatingSoldLine(
  rating: number | null | undefined,
  sold: number | null | undefined,
): string | null {
  const parts: string[] = []
  if (rating != null && Number.isFinite(rating) && rating > 0) {
    parts.push(`${rating.toFixed(1).replace('.', ',')}★`)
  }
  const soldText = formatSoldShort(sold)
  if (soldText) {
    parts.push(`${soldText} đã bán`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

export function formatRatingNumber(
  rating: number | null | undefined,
): string | null {
  if (rating == null || !Number.isFinite(rating) || rating <= 0) return null
  return rating.toFixed(1).replace('.', ',')
}

export function formatSoldSuffix(
  sold: number | null | undefined,
): string | null {
  const soldText = formatSoldShort(sold)
  return soldText ? `${soldText} đã bán` : null
}

/** dd/MM/yyyy — the format used in the list view's "NGÀY THÊM" column. */
export function formatDateShort(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
}

/** dd/MM/yyyy · HH:mm — footer of the edit dialog. */
export function formatDateTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${formatDateShort(ms)} · ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "1.500.000 ₫" without the "Chưa có giá" fallback (filter chips). */
export function formatVndPlain(value: number): string {
  return `${new Intl.NumberFormat('vi-VN').format(value)} ₫`
}

/** Shorten a URL for the add-links progress list: "s.shopee.vn/2q8xK1a9Zv". */
export function shortUrl(url: string): string {
  const trimmed = url.trim()
  try {
    const u = new URL(trimmed)
    const path = `${u.pathname}${u.search}`.replace(/\/$/, '')
    return `${u.host.replace(/^www\./, '')}${path}`
  } catch {
    return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed
  }
}
