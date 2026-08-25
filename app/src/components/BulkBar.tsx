import { useState } from 'react'
import { formatCount } from '../lib/format'
import { groupColor } from '../lib/product'
import { Menu, MenuItem } from './Menu'
import { LINK_ONLY_VALUE, type TemplateOption } from './TemplatePicker'
import type { SidebarGroup } from './AppSidebar'

type Props = {
  selectedCount: number
  /** Rows currently visible under the active filter. */
  filteredCount: number
  groups: SidebarGroup[]
  templates: TemplateOption[]
  busy?: boolean
  onSelectAll: () => void
  onAssignGroup: (groupId: string) => void
  onCopyAll: (templateId: string | null | undefined) => void
  onRescrape: () => void
  onExport: () => void
  onDelete: () => void
}

/**
 * Dark action bar shown while rows are selected (mockup frame B).
 */
export function BulkBar({
  selectedCount,
  filteredCount,
  groups,
  templates,
  busy = false,
  onSelectAll,
  onAssignGroup,
  onCopyAll,
  onRescrape,
  onExport,
  onDelete,
}: Props) {
  const [openMenu, setOpenMenu] = useState<'group' | 'copy' | null>(null)

  return (
    <div className="bulkbar" role="region" aria-label="Thao tác hàng loạt">
      <span className="bulkbar__count">
        Đã chọn {formatCount(selectedCount)} sản phẩm
      </span>
      {selectedCount < filteredCount && (
        <>
          <span className="bulkbar__dot" aria-hidden>
            ·
          </span>
          <button type="button" className="bulkbar__all" onClick={onSelectAll}>
            Chọn tất cả {formatCount(filteredCount)}
          </button>
        </>
      )}

      <div className="bulkbar__spacer" />

      <div className="bulkbar__wrap">
        <button
          type="button"
          className="bulkbar__btn"
          aria-haspopup="menu"
          aria-expanded={openMenu === 'group'}
          disabled={busy || groups.length === 0}
          onClick={(e) => {
            e.stopPropagation()
            setOpenMenu((v) => (v === 'group' ? null : 'group'))
          }}
        >
          Gán nhóm
          <span className="bulkbar__caret" aria-hidden>
            ▾
          </span>
        </button>
        <Menu
          open={openMenu === 'group'}
          placement="down-right"
          label="Chọn nhóm để gán"
          onClose={() => setOpenMenu(null)}
        >
          {groups.map((g, i) => (
            <MenuItem
              key={g.id}
              onSelect={() => {
                setOpenMenu(null)
                onAssignGroup(g.id)
              }}
            >
              <span
                className="group-toggle__dot"
                style={{
                  background: groupColor(g.color, i),
                  display: 'inline-block',
                  marginRight: 6,
                }}
                aria-hidden
              />
              {g.name}
            </MenuItem>
          ))}
        </Menu>
      </div>

      <div className="bulkbar__wrap">
        <button
          type="button"
          className="bulkbar__btn"
          aria-haspopup="menu"
          aria-expanded={openMenu === 'copy'}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation()
            setOpenMenu((v) => (v === 'copy' ? null : 'copy'))
          }}
        >
          Sao chép hàng loạt
          <span className="bulkbar__caret" aria-hidden>
            ▾
          </span>
        </button>
        <Menu
          open={openMenu === 'copy'}
          placement="down-right"
          label="Chọn mẫu câu cho sao chép hàng loạt"
          onClose={() => setOpenMenu(null)}
        >
          <MenuItem
            onSelect={() => {
              setOpenMenu(null)
              onCopyAll(undefined)
            }}
            badge="Mặc định"
          >
            Mẫu mặc định
          </MenuItem>
          {templates
            .filter((t) => !t.is_default)
            .map((t) => (
              <MenuItem
                key={t.id}
                onSelect={() => {
                  setOpenMenu(null)
                  onCopyAll(t.id)
                }}
              >
                {t.name}
              </MenuItem>
            ))}
          <MenuItem
            separated
            onSelect={() => {
              setOpenMenu(null)
              onCopyAll(LINK_ONLY_VALUE)
            }}
          >
            Chỉ link (không câu mời)
          </MenuItem>
        </Menu>
      </div>

      <button
        type="button"
        className="bulkbar__btn"
        disabled={busy}
        title="Quét lại để lấy tên, giá và ảnh còn thiếu"
        onClick={onRescrape}
      >
        Quét lại
      </button>

      <button
        type="button"
        className="bulkbar__btn"
        disabled={busy}
        onClick={onExport}
      >
        Xuất Excel
      </button>

      <button
        type="button"
        className="bulkbar__btn bulkbar__btn--danger"
        disabled={busy}
        onClick={onDelete}
      >
        Xoá
      </button>
    </div>
  )
}
