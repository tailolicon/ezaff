/**
 * Marketplace category chains.
 *
 * Shopee (and friends) expose a hierarchy per product:
 *   Điện Thoại & Phụ Kiện > Phụ kiện điện thoại > Pin dự phòng > Trên 20.000 mAh
 *
 * The whole chain is what makes a library sortable by category, so it is
 * stored verbatim in `products.category_path`. `products.category` keeps a
 * short human leaf for chips and search.
 */

/** Separator used in the stored path — spaces included so it reads naturally. */
export const CATEGORY_SEPARATOR = ' > '

/** Levels that are navigation chrome rather than real categories. */
function isChromeLevel(name: string): boolean {
  const n = name.trim()
  if (!n) return true
  if (/^Shopee(\s*Việt\s*Nam)?$/iu.test(n)) return true
  if (/^(Lazada|Tiki|TikTok\s*Shop|Sendo)$/iu.test(n)) return true
  if (/^(Trang chủ|Home|Danh mục|Tất cả)$/iu.test(n)) return true
  return false
}

/**
 * Join breadcrumb names into a stored path.
 * Drops site chrome and consecutive duplicates; returns null when nothing
 * meaningful is left.
 */
export function buildCategoryPath(names: string[]): string | null {
  const levels: string[] = []
  for (const raw of names) {
    const name = raw?.trim()
    if (!name || name.length > 80) continue
    if (isChromeLevel(name)) continue
    if (levels[levels.length - 1]?.toLowerCase() === name.toLowerCase()) {
      continue
    }
    levels.push(name)
  }
  return levels.length > 0 ? levels.join(CATEGORY_SEPARATOR) : null
}

/** Split a stored path back into levels. Tolerates ">" without spaces. */
export function splitCategoryPath(path: string | null | undefined): string[] {
  const raw = path?.trim()
  if (!raw) return []
  return raw
    .split(/\s*>\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Deepest level of a path — "Trên 20.000 mAh" for the example above. */
export function categoryLeaf(path: string | null | undefined): string | null {
  const levels = splitCategoryPath(path)
  return levels.length > 0 ? levels[levels.length - 1]! : null
}

/** Top level of a path — "Điện Thoại & Phụ Kiện" for the example above. */
export function categoryRoot(path: string | null | undefined): string | null {
  const levels = splitCategoryPath(path)
  return levels.length > 0 ? levels[0]! : null
}

/**
 * Path prefix used for "show everything under this branch" filtering.
 * `isUnderCategory('A > B > C', 'A > B')` → true.
 */
export function isUnderCategory(
  path: string | null | undefined,
  prefix: string,
): boolean {
  const levels = splitCategoryPath(path)
  const wanted = splitCategoryPath(prefix)
  if (wanted.length === 0 || levels.length < wanted.length) return false
  return wanted.every(
    (level, i) => levels[i]!.toLowerCase() === level.toLowerCase(),
  )
}
