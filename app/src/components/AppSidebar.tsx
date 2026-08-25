import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { formatCount } from '../lib/format'
import { groupColor } from '../lib/product'
import { BrandLockup } from './BrandMark'

export type SidebarGroup = {
  id: string
  name: string
  color: string | null
  product_count: number
}

export type SidebarCounts = {
  total: number
  missing: number
  error: number
  ungrouped: number
}

/** Saved views in the THƯ VIỆN section. */
export type LibraryView = 'all' | 'most_used' | 'recent'

type Props = {
  collapsed: boolean
  onToggleCollapsed: () => void

  groups: SidebarGroup[]
  counts: SidebarCounts
  categories: CategoryNode[]

  view: LibraryView
  selectedGroupId: string | null
  selectedBucket: ProductBucket | null
  selectedCategoryPath: string | null

  /** Products counted as "hay dùng" / "mới thêm" for the badges. */
  mostUsedCount: number
  recentCount: number

  busy?: boolean
  onSelectView: (view: LibraryView) => void
  onSelectGroup: (groupId: string | null) => void
  onSelectBucket: (bucket: ProductBucket | null) => void
  onSelectCategory: (path: string | null) => void
  onCreateGroup: (name: string) => Promise<void>
  onRenameGroup: (id: string, name: string) => Promise<void>
  onDeleteGroup: (id: string) => Promise<void>
  onOpenExcel: () => void
}

/*
 * "Cần xử lý" is only for things that are actually wrong. Being ungrouped is
 * not — a group is optional — so it lives under NHÓM as a plain filter.
 */
const BUCKETS: Array<{
  key: ProductBucket
  label: string
  color: string
  countKey: keyof SidebarCounts
}> = [
  { key: 'missing', label: 'Thiếu thông tin', color: '#b47814', countKey: 'missing' },
  { key: 'error', label: 'Lỗi quét', color: '#a33', countKey: 'error' },
]

/** Parent path of a category node, or '' when it is top level. */
function parentOf(path: string): string {
  const i = path.lastIndexOf(' > ')
  return i === -1 ? '' : path.slice(0, i)
}

/**
 * Left rail from mockup frame 2A: collapsible, saved views on top, then
 * groups, category tree, "cần xử lý", Excel.
 * Cài đặt moved to the header — it was buried at the bottom of the rail.
 */
export function AppSidebar({
  collapsed,
  onToggleCollapsed,
  groups,
  counts,
  categories,
  view,
  selectedGroupId,
  selectedBucket,
  selectedCategoryPath,
  mostUsedCount,
  recentCount,
  busy = false,
  onSelectView,
  onSelectGroup,
  onSelectBucket,
  onSelectCategory,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onOpenExcel,
}: Props) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [showBuckets, setShowBuckets] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [addingGroup, setAddingGroup] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const pending = counts.missing + counts.error

  function clearOthers(): void {
    onSelectGroup(null)
    onSelectBucket(null)
    onSelectCategory(null)
  }

  async function handleCreate(e: FormEvent): Promise<void> {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    setLocalError(null)
    try {
      await onCreateGroup(name)
      setNewName('')
      setAddingGroup(false)
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  async function commitRename(): Promise<void> {
    if (!editingId) return
    const name = editName.trim()
    if (!name) {
      setEditingId(null)
      return
    }
    setLocalError(null)
    try {
      await onRenameGroup(editingId, name)
      setEditingId(null)
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err))
    }
  }

  function onEditKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      void commitRename()
    } else if (e.key === 'Escape') {
      setEditingId(null)
    }
  }

  async function handleDeleteGroup(group: SidebarGroup): Promise<void> {
    const ok = window.confirm(
      `Xoá nhóm «${group.name}»? Sản phẩm không bị xoá, chỉ gỡ khỏi nhóm.`,
    )
    if (!ok) return
    setLocalError(null)
    try {
      await onDeleteGroup(group.id)
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err))
    }
  }

  function isCategoryVisible(node: CategoryNode): boolean {
    if (node.depth === 0) return true
    let parent = parentOf(node.path)
    while (parent) {
      if (!expandedPaths.has(parent)) return false
      parent = parentOf(parent)
    }
    return true
  }

  const hasChildren = (path: string): boolean =>
    categories.some((c) => c.path !== path && c.path.startsWith(`${path} > `))

  const noFilter =
    selectedGroupId === null &&
    selectedBucket === null &&
    selectedCategoryPath === null

  // ── Collapsed rail ──────────────────────────────────────────────────────
  if (collapsed) {
    return (
      <aside className="rail rail--collapsed" aria-label="Thanh điều hướng">
        <div className="rail__brand">
          <BrandLockup collapsed markSize={22} />
          <button
            type="button"
            className="rail__toggle"
            onClick={onToggleCollapsed}
            aria-label="Mở rộng thanh bên"
            title="Mở rộng"
          >
            »
          </button>
        </div>

        <button
          type="button"
          className={
            view === 'all' && noFilter
              ? 'rail__mini rail__mini--active'
              : 'rail__mini'
          }
          title={`Tất cả link (${formatCount(counts.total)})`}
          onClick={() => {
            onSelectView('all')
            clearOthers()
          }}
        >
          {counts.total >= 1000
            ? `${(counts.total / 1000).toFixed(1).replace('.0', '')}k`
            : formatCount(counts.total)}
        </button>
        <button
          type="button"
          className={view === 'most_used' ? 'rail__mini rail__mini--active' : 'rail__mini'}
          title={`Hay dùng (${formatCount(mostUsedCount)})`}
          onClick={() => {
            onSelectView('most_used')
            clearOthers()
          }}
        >
          {formatCount(mostUsedCount)}
        </button>
        <button
          type="button"
          className={view === 'recent' ? 'rail__mini rail__mini--active' : 'rail__mini'}
          title={`Mới thêm (${formatCount(recentCount)})`}
          onClick={() => {
            onSelectView('recent')
            clearOthers()
          }}
        >
          {formatCount(recentCount)}
        </button>

        <div className="rail__mini-sep" aria-hidden />

        {groups.slice(0, 6).map((g, i) => (
          <button
            key={g.id}
            type="button"
            className="rail__mini-dot"
            style={{ background: groupColor(g.color, i) }}
            title={`${g.name} (${formatCount(g.product_count)})`}
            aria-label={g.name}
            onClick={() => {
              onSelectGroup(selectedGroupId === g.id ? null : g.id)
              onSelectBucket(null)
              onSelectCategory(null)
            }}
          />
        ))}

        <div className="rail__spacer" />

        {pending > 0 && (
          <button
            type="button"
            className="rail__mini-badge"
            title={`${formatCount(pending)} sản phẩm cần xử lý`}
            onClick={() => {
              onSelectBucket('missing')
              onSelectGroup(null)
              onSelectCategory(null)
            }}
          >
            {formatCount(pending)}
          </button>
        )}
      </aside>
    )
  }

  // ── Expanded rail ───────────────────────────────────────────────────────
  return (
    <aside className="rail" aria-label="Thanh điều hướng">
      <div className="rail__brand">
        <BrandLockup markSize={20} />
        <button
          type="button"
          className="rail__toggle"
          onClick={onToggleCollapsed}
          aria-label="Thu gọn thanh bên"
          title="Thu gọn"
        >
          «
        </button>
      </div>

      <div className="rail__scroll">
        <div className="rail__heading">THƯ VIỆN</div>
        <div className="rail__list">
          <button
            type="button"
            className={
              view === 'all' && noFilter
                ? 'rail__item rail__item--active'
                : 'rail__item'
            }
            onClick={() => {
              onSelectView('all')
              clearOthers()
            }}
          >
            <span className="rail__label">Tất cả link</span>
            <span className="rail__count">{formatCount(counts.total)}</span>
          </button>
          <button
            type="button"
            className={
              view === 'most_used' ? 'rail__item rail__item--active' : 'rail__item'
            }
            onClick={() => {
              onSelectView('most_used')
              clearOthers()
            }}
          >
            <span className="rail__label">Hay dùng</span>
            <span className="rail__count">{formatCount(mostUsedCount)}</span>
          </button>
          <button
            type="button"
            className={
              view === 'recent' ? 'rail__item rail__item--active' : 'rail__item'
            }
            onClick={() => {
              onSelectView('recent')
              clearOthers()
            }}
          >
            <span className="rail__label">Mới thêm</span>
            <span className="rail__count">{formatCount(recentCount)}</span>
          </button>
        </div>

        <div className="rail__heading rail__heading--spaced">
          NHÓM
          <button
            type="button"
            className="rail__row-action"
            style={{ float: 'right', opacity: 1 }}
            title="Tạo nhóm mới"
            aria-label="Tạo nhóm mới"
            onClick={() => setAddingGroup((v) => !v)}
          >
            ＋
          </button>
        </div>
        <div className="rail__list">
          {groups.map((group, index) => {
            if (editingId === group.id) {
              return (
                <div key={group.id} className="rail__row">
                  <input
                    className="input"
                    style={{ height: 32, borderRadius: 9 }}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={onEditKeyDown}
                    onBlur={() => void commitRename()}
                    autoFocus
                    aria-label="Đổi tên nhóm"
                    disabled={busy}
                  />
                </div>
              )
            }
            const active = selectedGroupId === group.id
            return (
              <div key={group.id} className="rail__row">
                <button
                  type="button"
                  className={
                    active
                      ? 'rail__item rail__item--tight rail__item--active'
                      : 'rail__item rail__item--tight'
                  }
                  onClick={() => {
                    onSelectGroup(active ? null : group.id)
                    onSelectBucket(null)
                    onSelectCategory(null)
                  }}
                >
                  <span
                    className="rail__dot"
                    style={{ background: groupColor(group.color, index) }}
                    aria-hidden
                  />
                  <span className="rail__label" title={group.name}>
                    {group.name}
                  </span>
                  <span className="rail__count">
                    {formatCount(group.product_count)}
                  </span>
                </button>
                <div className="rail__row-actions">
                  <button
                    type="button"
                    className="rail__row-action"
                    title="Đổi tên nhóm"
                    aria-label={`Đổi tên nhóm ${group.name}`}
                    disabled={busy}
                    onClick={() => {
                      setEditingId(group.id)
                      setEditName(group.name)
                    }}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="rail__row-action"
                    title="Xoá nhóm"
                    aria-label={`Xoá nhóm ${group.name}`}
                    disabled={busy}
                    onClick={() => void handleDeleteGroup(group)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            )
          })}

          {addingGroup && (
            <form
              className="rail__inline-form"
              onSubmit={(e) => void handleCreate(e)}
            >
              <input
                className="input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Tên nhóm mới…"
                aria-label="Tên nhóm mới"
                maxLength={80}
                autoFocus
                disabled={creating}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setAddingGroup(false)
                    setNewName('')
                  }
                }}
              />
              <button
                type="submit"
                className="btn btn-sm btn-primary"
                disabled={creating || !newName.trim()}
              >
                Tạo
              </button>
            </form>
          )}

          {groups.length === 0 && !addingGroup && (
            <button
              type="button"
              className="rail__item rail__item--tight"
              style={{ color: 'var(--muted-2)' }}
              onClick={() => setAddingGroup(true)}
            >
              <span className="rail__label">＋ Tạo nhóm đầu tiên</span>
            </button>
          )}

          {/* A way to find them, not a warning that they need fixing. */}
          {groups.length > 0 && counts.ungrouped > 0 && (
            <button
              type="button"
              className={
                selectedBucket === 'ungrouped'
                  ? 'rail__item rail__item--tight rail__item--active'
                  : 'rail__item rail__item--tight'
              }
              onClick={() => {
                onSelectBucket(
                  selectedBucket === 'ungrouped' ? null : 'ungrouped',
                )
                onSelectGroup(null)
                onSelectCategory(null)
              }}
            >
              <span className="rail__dot rail__dot--hollow" aria-hidden />
              <span className="rail__label" style={{ color: 'var(--muted-2)' }}>
                Chưa gán nhóm
              </span>
              <span className="rail__count">
                {formatCount(counts.ungrouped)}
              </span>
            </button>
          )}
        </div>

        {categories.length > 0 && (
          <>
            <div className="rail__heading rail__heading--spaced">DANH MỤC</div>
            <div className="rail__list">
              {categories.filter(isCategoryVisible).map((node) => {
                const active = selectedCategoryPath === node.path
                const open = expandedPaths.has(node.path)
                return (
                  <button
                    key={node.path}
                    type="button"
                    className={
                      active
                        ? 'rail__item rail__item--tight rail__item--active'
                        : 'rail__item rail__item--tight'
                    }
                    style={{ paddingLeft: 12 + node.depth * 12 }}
                    title={node.path}
                    onClick={() => {
                      onSelectCategory(active ? null : node.path)
                      onSelectGroup(null)
                      onSelectBucket(null)
                    }}
                  >
                    {hasChildren(node.path) ? (
                      <span
                        className="rail__twisty"
                        role="presentation"
                        onClick={(e) => {
                          e.stopPropagation()
                          setExpandedPaths((prev) => {
                            const next = new Set(prev)
                            if (next.has(node.path)) next.delete(node.path)
                            else next.add(node.path)
                            return next
                          })
                        }}
                      >
                        {open ? '▾' : '▸'}
                      </span>
                    ) : (
                      <span className="rail__twisty" aria-hidden />
                    )}
                    <span className="rail__label">{node.name}</span>
                    <span className="rail__count">
                      {formatCount(node.count)}
                    </span>
                  </button>
                )
              })}
            </div>
          </>
        )}

        <div className="rail__list" style={{ marginTop: 14 }}>
          <button
            type="button"
            className="rail__item"
            style={{ fontWeight: 600, color: 'var(--ink)' }}
            aria-expanded={showBuckets}
            onClick={() => setShowBuckets((v) => !v)}
          >
            <span className="rail__label">Cần xử lý</span>
            {pending > 0 && (
              <span className="rail__pill">{formatCount(pending)}</span>
            )}
          </button>

          {showBuckets &&
            BUCKETS.map((bucket) => {
              const active = selectedBucket === bucket.key
              return (
                <button
                  key={bucket.key}
                  type="button"
                  className={
                    active
                      ? 'rail__item rail__item--tight rail__item--active'
                      : 'rail__item rail__item--tight'
                  }
                  style={{ paddingLeft: 24 }}
                  onClick={() => {
                    onSelectBucket(active ? null : bucket.key)
                    onSelectGroup(null)
                    onSelectCategory(null)
                  }}
                >
                  <span
                    className="rail__dot"
                    style={{ background: bucket.color }}
                    aria-hidden
                  />
                  <span className="rail__label">{bucket.label}</span>
                  <span className="rail__count">
                    {formatCount(counts[bucket.countKey])}
                  </span>
                </button>
              )
            })}

          <button type="button" className="rail__item" onClick={onOpenExcel}>
            <span className="rail__label">Nhập / xuất Excel</span>
          </button>
        </div>

        {localError && (
          <p
            style={{
              margin: '8px 4px 0',
              fontSize: 11.5,
              color: 'var(--danger)',
            }}
            role="alert"
          >
            {localError}
          </p>
        )}
      </div>

      <div className="rail__spacer" />

    </aside>
  )
}
