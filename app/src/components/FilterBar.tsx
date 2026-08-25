import { useState } from 'react'
import { formatCount, formatVndPlain, platformLabel } from '../lib/format'

export type ViewMode = 'grid' | 'list'

export type FilterState = {
  query: string
  platform: string
  priceMin: string
  priceMax: string
  /** Days back from now; '' means any time. */
  dateRange: string
  sort: ProductSort
}

export const EMPTY_FILTERS: FilterState = {
  query: '',
  platform: '',
  priceMin: '',
  priceMax: '',
  dateRange: '',
  sort: 'newest',
}

export const PLATFORMS = [
  { value: '', label: 'Tất cả sàn' },
  { value: 'shopee', label: 'Shopee' },
  { value: 'lazada', label: 'Lazada' },
  { value: 'tiki', label: 'Tiki' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'sendo', label: 'Sendo' },
  { value: 'other', label: 'Khác' },
] as const

export const DATE_RANGES = [
  { value: '', label: 'Mọi lúc' },
  { value: '7', label: '7 ngày qua' },
  { value: '30', label: '30 ngày qua' },
  { value: '90', label: '90 ngày qua' },
  { value: '365', label: '1 năm qua' },
] as const

export const SORTS: Array<{ value: ProductSort; label: string }> = [
  { value: 'newest', label: 'Mới nhất' },
  { value: 'title', label: 'Tên A-Z' },
  { value: 'price', label: 'Giá thấp → cao' },
  { value: 'most_used', label: 'Hay dùng nhất' },
]

export function sortLabel(sort: ProductSort): string {
  return SORTS.find((s) => s.value === sort)?.label ?? 'Mới nhất'
}

export function dateRangeLabel(value: string): string {
  return DATE_RANGES.find((d) => d.value === value)?.label ?? 'Mọi lúc'
}

/** Number of active constraints, shown as the "Bộ lọc" badge. */
export function countActiveFilters(f: FilterState): number {
  let n = 0
  if (f.query.trim()) n++
  if (f.platform) n++
  if (f.priceMin.trim() || f.priceMax.trim()) n++
  if (f.dateRange) n++
  return n
}

function parsePriceInput(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, '')
  if (!digits) return null
  const n = Number(digits)
  return Number.isFinite(n) ? n : null
}

export function priceRangeLabel(min: string, max: string): string | null {
  const lo = parsePriceInput(min)
  const hi = parsePriceInput(max)
  if (lo === null && hi === null) return null
  if (lo !== null && hi !== null) {
    return `${formatCount(lo)} – ${formatVndPlain(hi)}`
  }
  if (hi !== null) return `≤ ${formatVndPlain(hi)}`
  return `≥ ${formatVndPlain(lo as number)}`
}

type PriceRangeProps = {
  min: string
  max: string
  onChange: (min: string, max: string) => void
}

/** "KHOẢNG GIÁ" control — a labelled trigger with a two-field popover. */
function PriceRange({ min, max, onChange }: PriceRangeProps) {
  const [open, setOpen] = useState(false)
  const [draftMin, setDraftMin] = useState(min)
  const [draftMax, setDraftMax] = useState(max)
  const label = priceRangeLabel(min, max)

  function openPopover(): void {
    setDraftMin(min)
    setDraftMax(max)
    setOpen(true)
  }

  return (
    <div className="pricerange">
      <button
        type="button"
        className={
          label
            ? 'pricerange__trigger'
            : 'pricerange__trigger pricerange__trigger--empty'
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPopover())}
      >
        {label ?? 'Mọi mức giá'}
      </button>

      {open && (
        <>
          <button
            type="button"
            className="popover-backdrop"
            aria-label="Đóng khoảng giá"
            onClick={() => setOpen(false)}
          />
          <div className="pricerange__pop" role="dialog" aria-label="Khoảng giá">
            <div className="pricerange__inputs">
              <input
                className="input num"
                inputMode="numeric"
                placeholder="Từ"
                aria-label="Giá từ"
                value={draftMin}
                onChange={(e) => setDraftMin(e.target.value)}
              />
              <span aria-hidden>–</span>
              <input
                className="input num"
                inputMode="numeric"
                placeholder="Đến"
                aria-label="Giá đến"
                value={draftMax}
                onChange={(e) => setDraftMax(e.target.value)}
              />
            </div>
            <div className="pricerange__actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setDraftMin('')
                  setDraftMax('')
                  onChange('', '')
                  setOpen(false)
                }}
              >
                Xoá
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => {
                  onChange(
                    String(parsePriceInput(draftMin) ?? ''),
                    String(parsePriceInput(draftMax) ?? ''),
                  )
                  setOpen(false)
                }}
              >
                Áp dụng
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

type ViewToggleProps = {
  view: ViewMode
  onChange: (view: ViewMode) => void
}

export function ViewToggle({ view, onChange }: ViewToggleProps) {
  return (
    <div className="viewtoggle" role="group" aria-label="Chế độ hiển thị">
      <button
        type="button"
        className={
          view === 'grid'
            ? 'viewtoggle__btn viewtoggle__btn--active'
            : 'viewtoggle__btn'
        }
        aria-pressed={view === 'grid'}
        onClick={() => onChange('grid')}
      >
        Lưới
      </button>
      <button
        type="button"
        className={
          view === 'list'
            ? 'viewtoggle__btn viewtoggle__btn--active'
            : 'viewtoggle__btn'
        }
        aria-pressed={view === 'list'}
        onClick={() => onChange('list')}
      >
        Danh sách
      </button>
    </div>
  )
}

type Props = {
  filters: FilterState
  view: ViewMode
  /** Rows currently displayed. */
  shown: number
  /** Rows in the library ignoring all filters. */
  total: number
  onChange: (next: FilterState) => void
  onClear: () => void
  onViewChange: (view: ViewMode) => void
}

/**
 * Expanded filter card from mockup frame A: search, platform, price range,
 * date added, sort and the grid/list toggle, plus removable chips.
 */
export function FilterBar({
  filters,
  view,
  shown,
  total,
  onChange,
  onClear,
  onViewChange,
}: Props) {
  const active = countActiveFilters(filters)
  const price = priceRangeLabel(filters.priceMin, filters.priceMax)

  return (
    <div className="filters" aria-label="Tìm kiếm và bộ lọc">
      <div className="filters__row">
        <label className="filters__field filters__field--grow">
          <span className="field-label">Tìm kiếm</span>
          <input
            className="input"
            type="search"
            value={filters.query}
            placeholder="Tìm theo tên, shop, ghi chú, danh mục…"
            autoComplete="off"
            onChange={(e) => onChange({ ...filters, query: e.target.value })}
          />
        </label>

        <label className="filters__field filters__field--platform">
          <span className="field-label">Sàn</span>
          <select
            className="input"
            value={filters.platform}
            onChange={(e) => onChange({ ...filters, platform: e.target.value })}
          >
            {PLATFORMS.map((p) => (
              <option key={p.value || 'all'} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <div className="filters__field filters__field--price">
          <span className="field-label">Khoảng giá</span>
          <PriceRange
            min={filters.priceMin}
            max={filters.priceMax}
            onChange={(priceMin, priceMax) =>
              onChange({ ...filters, priceMin, priceMax })
            }
          />
        </div>

        <label className="filters__field filters__field--date">
          <span className="field-label">Ngày thêm</span>
          <select
            className="input"
            value={filters.dateRange}
            onChange={(e) =>
              onChange({ ...filters, dateRange: e.target.value })
            }
          >
            {DATE_RANGES.map((d) => (
              <option key={d.value || 'any'} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>

        <label className="filters__field filters__field--sort">
          <span className="field-label">Sắp xếp</span>
          <select
            className="input"
            value={filters.sort}
            onChange={(e) =>
              onChange({ ...filters, sort: e.target.value as ProductSort })
            }
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        <ViewToggle view={view} onChange={onViewChange} />
      </div>

      {active > 0 && (
        <div className="filters__chips">
          <span className="filters__showing">
            Hiển thị {formatCount(shown)} / {formatCount(total)}
          </span>

          {filters.query.trim() && (
            <button
              type="button"
              className="filter-chip"
              onClick={() => onChange({ ...filters, query: '' })}
            >
              Từ khoá: {filters.query.trim()}
              <span className="filter-chip__x" aria-hidden>
                ✕
              </span>
            </button>
          )}

          {filters.platform && (
            <button
              type="button"
              className="filter-chip"
              onClick={() => onChange({ ...filters, platform: '' })}
            >
              {platformLabel(filters.platform)}
              <span className="filter-chip__x" aria-hidden>
                ✕
              </span>
            </button>
          )}

          {price && (
            <button
              type="button"
              className="filter-chip"
              onClick={() =>
                onChange({ ...filters, priceMin: '', priceMax: '' })
              }
            >
              {price}
              <span className="filter-chip__x" aria-hidden>
                ✕
              </span>
            </button>
          )}

          {filters.dateRange && (
            <button
              type="button"
              className="filter-chip"
              onClick={() => onChange({ ...filters, dateRange: '' })}
            >
              {dateRangeLabel(filters.dateRange)}
              <span className="filter-chip__x" aria-hidden>
                ✕
              </span>
            </button>
          )}

          <button type="button" className="btn-link" onClick={onClear}>
            Xoá tất cả bộ lọc
          </button>
        </div>
      )}
    </div>
  )
}
