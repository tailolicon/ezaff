import { useState, type ReactNode } from 'react'
import { formatCount, platformLabel } from '../lib/format'
import { Menu, MenuItem } from './Menu'
import { SORTS, sortLabel } from './FilterBar'

type SearchRowProps = {
  query: string
  onQueryChange: (value: string) => void
  onOpenSettings: () => void
}

/** Pill search + circular actions, top of the stage (mockup 2A). */
export function SearchRow({
  query,
  onQueryChange,
  onOpenSettings,
}: SearchRowProps) {
  return (
    <div className="topline">
      <div className="searchpill">
        <span className="searchpill__icon" aria-hidden>
          ⌕
        </span>
        <input
          className="searchpill__input"
          type="search"
          value={query}
          placeholder="Tìm link theo tên, shop, ghi chú…"
          aria-label="Tìm link"
          autoComplete="off"
          onChange={(e) => onQueryChange(e.target.value)}
        />
        {query && (
          <button
            type="button"
            className="searchpill__clear"
            aria-label="Xoá từ khoá"
            onClick={() => onQueryChange('')}
          >
            ✕
          </button>
        )}
      </div>

      <button
        type="button"
        className="settingsbtn"
        onClick={onOpenSettings}
      >
        <span aria-hidden>⚙</span>
        Cài đặt
      </button>
    </div>
  )
}

type PageHeadProps = {
  title: string
  subtitle: ReactNode
  sort: ProductSort
  onSortChange: (sort: ProductSort) => void
  addBusy?: boolean
  onAdd: () => void
}

/** "Thư viện của bạn" heading with the sort pill and + Thêm link. */
export function PageHead({
  title,
  subtitle,
  sort,
  onSortChange,
  addBusy = false,
  onAdd,
}: PageHeadProps) {
  const [sortOpen, setSortOpen] = useState(false)

  return (
    <div className="pagehead">
      <div>
        <h1 className="pagehead__title">{title}</h1>
        <p className="pagehead__sub">{subtitle}</p>
      </div>

      <div className="pagehead__actions">
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="pill"
            aria-haspopup="menu"
            aria-expanded={sortOpen}
            onClick={(e) => {
              e.stopPropagation()
              setSortOpen((v) => !v)
            }}
          >
            Sắp xếp: {sortLabel(sort)}
            <span className="pill__caret" aria-hidden>
              ▾
            </span>
          </button>
          <Menu
            open={sortOpen}
            placement="down-right"
            label="Chọn cách sắp xếp"
            onClose={() => setSortOpen(false)}
          >
            {SORTS.map((s) => (
              <MenuItem
                key={s.value}
                badge={s.value === sort ? '✓' : undefined}
                onSelect={() => {
                  setSortOpen(false)
                  onSortChange(s.value)
                }}
              >
                {s.label}
              </MenuItem>
            ))}
          </Menu>
        </div>

        <button
          type="button"
          className="pill pill--primary"
          disabled={addBusy}
          onClick={onAdd}
        >
          ＋ {addBusy ? 'Đang thêm…' : 'Thêm link'}
        </button>
      </div>
    </div>
  )
}

export type PlatformCount = { platform: string; count: number }

type ChipRowProps = {
  platforms: PlatformCount[]
  selected: string
  onSelect: (platform: string) => void
  activeFilterCount: number
  filtersOpen: boolean
  onToggleFilters: () => void
}

/** Platform filter chips + the "Bộ lọc" toggle. */
export function PlatformChips({
  platforms,
  selected,
  onSelect,
  activeFilterCount,
  filtersOpen,
  onToggleFilters,
}: ChipRowProps) {
  return (
    <div className="chiprow">
      <button
        type="button"
        className={
          selected === '' ? 'chip-filter chip-filter--active' : 'chip-filter'
        }
        onClick={() => onSelect('')}
      >
        Tất cả sàn
      </button>

      {platforms.map((p) => (
        <button
          key={p.platform}
          type="button"
          className={
            selected === p.platform
              ? 'chip-filter chip-filter--active'
              : 'chip-filter'
          }
          onClick={() => onSelect(selected === p.platform ? '' : p.platform)}
        >
          {platformLabel(p.platform)}
          <span className="chip-filter__count">{formatCount(p.count)}</span>
        </button>
      ))}

      <div style={{ flex: 1 }} />

      <button
        type="button"
        className={
          filtersOpen ? 'chip-filter chip-filter--active' : 'chip-filter'
        }
        aria-expanded={filtersOpen}
        onClick={onToggleFilters}
      >
        Bộ lọc
        {activeFilterCount > 0 && (
          <span className="chip-filter__badge">{activeFilterCount}</span>
        )}
      </button>
    </div>
  )
}
