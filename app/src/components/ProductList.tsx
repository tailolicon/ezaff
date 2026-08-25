import { useState, type KeyboardEvent } from 'react'
import {
  formatCount,
  formatDateShort,
  formatPrice,
  formatRatingNumber,
  platformLabel,
  productImageSrc,
} from '../lib/format'
import {
  deriveProductState,
  groupChipStyle,
  listSubtitle,
} from '../lib/product'
import { Checkbox } from './Checkbox'
import { Menu, MenuItem } from './Menu'

export type ProductRowData = {
  id: string
  platform: string
  title: string | null
  image_url: string | null
  image_local: string | null
  price: number | null
  currency: string
  shop_name: string | null
  rating?: number | null
  note: string | null
  category: string | null
  scrape_status: string | null
  scrape_error: string | null
  created_at: number
  copy_count: number
  groups: ProductGroupRef[]
}

type Props = {
  products: ProductRowData[]
  totalCount: number
  selectedIds: Set<string>
  rescrapingId?: string | null
  pasteImageId?: string | null
  onToggle: (id: string) => void
  onToggleAll: () => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onRescrape: (id: string) => void
  onPasteImage: (id: string) => void
  onOpenProduct: (id: string) => void
  onCopy: (id: string) => void
}

const COLUMNS = [
  'ẢNH',
  'SẢN PHẨM',
  'SÀN',
  'GIÁ',
  'NHÓM',
  'LƯỢT COPY',
  'NGÀY THÊM',
  'TRẠNG THÁI',
] as const

/**
 * Table view from mockup frame B: multi-select, per-row "⋯" menu and a
 * footer that reports how much of the filtered set is on screen.
 * Space on a focused row opens the quick view (edit dialog).
 */
export function ProductList({
  products,
  totalCount,
  selectedIds,
  rescrapingId = null,
  pasteImageId = null,
  onToggle,
  onToggleAll,
  onEdit,
  onDelete,
  onRescrape,
  onPasteImage,
  onOpenProduct,
  onCopy,
}: Props) {
  const [menuId, setMenuId] = useState<string | null>(null)

  const allSelected =
    products.length > 0 && products.every((p) => selectedIds.has(p.id))
  const someSelected = products.some((p) => selectedIds.has(p.id))

  function handleRowKey(e: KeyboardEvent<HTMLDivElement>, id: string): void {
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault()
      onEdit(id)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onToggle(id)
    }
  }

  return (
    <div className="plist">
      <div className="plist__grid plist__head">
        <div>
          <Checkbox
            checked={allSelected}
            indeterminate={!allSelected && someSelected}
            label="Chọn tất cả sản phẩm đang hiển thị"
            disabled={products.length === 0}
            onChange={onToggleAll}
          />
        </div>
        {COLUMNS.map((label) => (
          <div
            key={label}
            style={
              label === 'GIÁ' || label === 'LƯỢT COPY'
                ? { textAlign: 'right' }
                : undefined
            }
          >
            {label}
          </div>
        ))}
        <div />
      </div>

      <div className="plist__body">
        {products.length === 0 ? (
          <p className="plist__empty">
            Không có sản phẩm nào khớp bộ lọc hiện tại.
          </p>
        ) : (
          products.map((product) => {
            const state = deriveProductState(
              product,
              rescrapingId === product.id,
            )
            const sub = listSubtitle(product, state)
            const imageSrc = productImageSrc(
              product.image_local,
              product.image_url,
            )
            const selected = selectedIds.has(product.id)
            const title = product.title?.trim() || 'Chưa có tên'

            return (
              <div
                key={product.id}
                className={
                  selected
                    ? 'plist__grid plist__row plist__row--selected'
                    : 'plist__grid plist__row'
                }
                role="button"
                tabIndex={0}
                aria-label={`${title} — nhấn Space để xem nhanh`}
                onKeyDown={(e) => handleRowKey(e, product.id)}
                onDoubleClick={() => onEdit(product.id)}
              >
                <div>
                  <Checkbox
                    checked={selected}
                    label={`Chọn ${title}`}
                    onChange={() => onToggle(product.id)}
                  />
                </div>

                <div>
                  {imageSrc ? (
                    <img
                      className="plist__thumb"
                      src={imageSrc}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <div
                      className={
                        state.tone === 'error'
                          ? 'plist__thumb plist__thumb--error'
                          : 'plist__thumb plist__thumb--warn'
                      }
                      aria-hidden
                    />
                  )}
                </div>

                <div className="plist__name">
                  <div className="plist__title" title={title}>
                    {title}
                  </div>
                  <div
                    className={
                      sub.tone === 'error'
                        ? 'plist__sub plist__sub--error'
                        : sub.tone === 'warn'
                          ? 'plist__sub plist__sub--warn'
                          : 'plist__sub'
                    }
                  >
                    {sub.text}
                    {formatRatingNumber(product.rating) && (
                      <span className="plist__rating">
                        <span className="rating-star" aria-hidden>
                          ★
                        </span>
                        {formatRatingNumber(product.rating)}
                      </span>
                    )}
                  </div>
                </div>

                <div className="plist__platform">
                  {platformLabel(product.platform)}
                </div>

                <div
                  className={
                    product.price === null
                      ? 'plist__price plist__price--empty'
                      : 'plist__price'
                  }
                >
                  {product.price === null
                    ? '—'
                    : formatPrice(product.price, product.currency)}
                </div>

                <div className="plist__groups">
                  {/* Ungrouped shows nothing — a group is optional. */}
                  {product.groups.slice(0, 2).map((g, i) => (
                    <span
                      key={g.id}
                      className="chip"
                      style={groupChipStyle(g.color, i)}
                    >
                      {g.name}
                    </span>
                  ))}
                  {product.groups.length > 2 && (
                    <span
                      className="chip chip--muted"
                      title={product.groups.map((g) => g.name).join(', ')}
                    >
                      +{product.groups.length - 2}
                    </span>
                  )}
                </div>

                <div className="plist__copies">
                  {formatCount(product.copy_count)}
                </div>

                <div className="plist__date">
                  {formatDateShort(product.created_at)}
                </div>

                <div>
                  <span className={`status-pill status-pill--${state.tone}`}>
                    {state.label}
                  </span>
                </div>

                <div className="plist__more">
                  <button
                    type="button"
                    className="plist__more-btn"
                    aria-haspopup="menu"
                    aria-expanded={menuId === product.id}
                    aria-label={`Thao tác với ${title}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuId((v) => (v === product.id ? null : product.id))
                    }}
                  >
                    ⋯
                  </button>
                  <Menu
                    open={menuId === product.id}
                    placement="down-right"
                    label={`Thao tác với ${title}`}
                    onClose={() => setMenuId(null)}
                  >
                    <MenuItem
                      onSelect={() => {
                        setMenuId(null)
                        onCopy(product.id)
                      }}
                    >
                      Sao chép
                    </MenuItem>
                    <MenuItem
                      onSelect={() => {
                        setMenuId(null)
                        onEdit(product.id)
                      }}
                    >
                      Sửa sản phẩm
                    </MenuItem>
                    <MenuItem
                      disabled={state.busy}
                      onSelect={() => {
                        setMenuId(null)
                        onRescrape(product.id)
                      }}
                    >
                      Quét lại
                    </MenuItem>
                    <MenuItem
                      disabled={pasteImageId === product.id}
                      onSelect={() => {
                        setMenuId(null)
                        onPasteImage(product.id)
                      }}
                    >
                      Dán ảnh từ clipboard
                    </MenuItem>
                    <MenuItem
                      onSelect={() => {
                        setMenuId(null)
                        onOpenProduct(product.id)
                      }}
                    >
                      Mở trang gốc
                    </MenuItem>
                    <MenuItem
                      danger
                      separated
                      onSelect={() => {
                        setMenuId(null)
                        onDelete(product.id)
                      }}
                    >
                      Xoá sản phẩm
                    </MenuItem>
                  </Menu>
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="plist__footer">
        <span>
          {products.length === 0
            ? 'Không có sản phẩm nào'
            : `Hiển thị 1–${formatCount(products.length)} trong ${formatCount(totalCount)} sản phẩm`}
        </span>
        <span>Cuộn để xem thêm · nhấn Space để xem nhanh</span>
      </div>
    </div>
  )
}
