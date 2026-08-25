/**
 * Pure template renderer for invitation sentences (FR-7).
 * Supported variables: {link} {ten} {gia} {shop} {danhgia}
 */

export type TemplateVars = {
  link?: string | null
  ten?: string | null
  gia?: number | null
  shop?: string | null
  /** Star rating, e.g. 4.9. */
  danhgia?: number | null
  /** Units sold — rendered next to the rating. */
  daban?: number | null
}

const KNOWN = new Set(['link', 'ten', 'gia', 'shop', 'danhgia', 'daban'])

/** Variables offered as one-click chips in Cài đặt → Mẫu câu. */
export const TEMPLATE_VARIABLES = [
  'ten',
  'gia',
  'shop',
  'danhgia',
  'link',
] as const

/** Format integer price as Vietnamese đồng (e.g. 99.000 ₫). */
export function formatVnd(price: number): string {
  const formatted = new Intl.NumberFormat('vi-VN').format(price)
  return `${formatted} ₫`
}

/** Compact sold count in Vietnamese style: 12,3k / 1,2tr. */
export function formatSoldShort(sold: number): string {
  const n = Math.round(sold)
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace('.', ',').replace(/,0$/, '')}tr`
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1).replace('.', ',').replace(/,0$/, '')}k`
  }
  return new Intl.NumberFormat('vi-VN').format(n)
}

/** "4,9★ · 12,3k đã bán" — empty when neither value is known. */
export function formatRatingSold(
  rating: number | null | undefined,
  sold: number | null | undefined,
): string {
  const parts: string[] = []
  if (rating !== null && rating !== undefined && rating > 0) {
    parts.push(`${rating.toFixed(1).replace('.', ',')}★`)
  }
  if (sold !== null && sold !== undefined && sold > 0) {
    parts.push(`${formatSoldShort(sold)} đã bán`)
  }
  return parts.join(' · ')
}

function valueFor(name: string, vars: TemplateVars): string {
  switch (name) {
    case 'link':
      return vars.link ?? ''
    case 'ten':
      return vars.ten ?? ''
    case 'shop':
      return vars.shop ?? ''
    case 'gia':
      return vars.gia === null || vars.gia === undefined
        ? ''
        : formatVnd(vars.gia)
    case 'danhgia':
      return formatRatingSold(vars.danhgia, vars.daban)
    case 'daban':
      return vars.daban === null || vars.daban === undefined
        ? ''
        : `${formatSoldShort(vars.daban)} đã bán`
    default:
      return ''
  }
}

/**
 * After empty substitutions, collapse double spaces and strip dangling
 * separators such as " - ", " | ", " · " left with nothing on one side.
 * Unknown placeholders like {foo} are never touched.
 */
function cleanupRendered(text: string): string {
  let out = text

  // Collapse horizontal whitespace runs
  out = out.replace(/[ \t]{2,}/g, ' ')

  // Dangling separator tokens between empty parts: " - - ", " | ", etc.
  // Repeat until stable for chains of empty segments.
  for (let i = 0; i < 8; i++) {
    const next = out
      // " - " / " | " / " · " / " / " / " – " with empty sides → drop separator
      .replace(/(^|[\s])[-–—|·/](?=[\s]|$)/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
    if (next === out) break
    out = next
  }

  // Space immediately before punctuation after empty prefix: " :" → ":"
  out = out.replace(/[ \t]+([,;:.])/g, '$1')

  return out.replace(/[ \t]{2,}/g, ' ').trim()
}

/**
 * Render a template string with product variables.
 *
 * Rules:
 * - Known vars {link} {ten} {gia} {shop} {danhgia} are substituted.
 * - {gia} is Vietnamese currency formatting.
 * - Missing/null values become empty string (no crash).
 * - Unknown variables e.g. {foo} stay as literal text.
 * - If content does not contain {link}, the link is appended at the end.
 * - Empty substitutions do not leave double spaces or dangling separators.
 */
export function renderTemplate(
  content: string,
  vars: TemplateVars,
): string {
  const link = vars.link ?? ''
  const originalHasLink = content.includes('{link}')

  const substituted = content.replace(
    /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g,
    (full, name: string) => {
      if (!KNOWN.has(name)) {
        return full
      }
      return valueFor(name, vars)
    },
  )

  let result = cleanupRendered(substituted)

  if (!originalHasLink) {
    if (link) {
      result = result ? `${result} ${link}` : link
    }
  }

  return result
}
