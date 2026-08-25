import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { formatDateTime, maskAffiliateUrl, productImageSrc } from '../lib/format'
import { groupColor } from '../lib/product'

export type EditableProduct = {
  id: string
  original_url: string
  title: string | null
  price: number | null
  currency: string
  category: string | null
  shop_name: string | null
  note: string | null
  image_url: string | null
  image_local?: string | null
  platform: string
  /** Full marketplace chain, e.g. "A > B > C". */
  category_path?: string | null
  updated_at?: number
}

export type EditProductPayload = {
  id: string
  original_url: string
  title: string | null
  price: number | null
  category: string | null
  shop_name: string | null
  note: string | null
  image_url: string | null
  image_local?: string | null
  category_path: string | null
}

export type DialogGroupOption = {
  id: string
  name: string
  color?: string | null
}

type Props = {
  product: EditableProduct | null
  open: boolean
  busy?: boolean
  allGroups?: DialogGroupOption[]
  selectedGroupIds?: string[]
  onClose: () => void
  onSave: (payload: EditProductPayload, groupIds: string[]) => Promise<void>
  /** Create a group inline from the "+ Nhóm mới" chip. */
  onCreateGroup?: (name: string) => Promise<string | null>
  /** Categories already used in the library, for the input's autocomplete. */
  categorySuggestions?: string[]
}

/** Digits only, formatted with Vietnamese thousand separators while typing. */
function formatPriceInput(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '')
  if (!digits) return ''
  return new Intl.NumberFormat('vi-VN').format(Number(digits))
}

function parsePriceInput(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, '')
  if (!digits) return null
  const n = Number(digits)
  return Number.isFinite(n) ? n : null
}

/**
 * "Sửa sản phẩm" dialog (mockup frame F) — also the manual-entry path when
 * scraping fails. The affiliate link is masked until the user reveals it.
 */
export function EditProductDialog({
  product,
  open,
  busy = false,
  allGroups = [],
  selectedGroupIds = [],
  onClose,
  onSave,
  onCreateGroup,
  categorySuggestions = [],
}: Props) {
  const titleId = useId()
  const categoryListId = useId()
  const titleInputRef = useRef<HTMLInputElement>(null)
  const [originalUrl, setOriginalUrl] = useState('')
  const [title, setTitle] = useState('')
  const [price, setPrice] = useState('')
  const [category, setCategory] = useState('')
  const [categoryPath, setCategoryPath] = useState('')
  const [shopName, setShopName] = useState('')
  const [note, setNote] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [imageLocal, setImageLocal] = useState<string | null>(null)
  const [linkRevealed, setLinkRevealed] = useState(false)
  const [groupIds, setGroupIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pasteBusy, setPasteBusy] = useState(false)
  const [pickBusy, setPickBusy] = useState(false)
  const [openPageBusy, setOpenPageBusy] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupBusy, setNewGroupBusy] = useState(false)

  useEffect(() => {
    if (!product || !open) return
    setOriginalUrl(product.original_url)
    setTitle(product.title ?? '')
    setPrice(
      product.price === null || product.price === undefined
        ? ''
        : new Intl.NumberFormat('vi-VN').format(product.price),
    )
    setCategory(product.category ?? '')
    setCategoryPath(product.category_path ?? '')
    setShopName(product.shop_name ?? '')
    setNote(product.note ?? '')
    setImageUrl(product.image_url ?? '')
    setImageLocal(product.image_local ?? null)
    setGroupIds(selectedGroupIds)
    setLinkRevealed(false)
    setError(null)
    setHint(null)
    setNewGroupOpen(false)
    setNewGroupName('')
    const t = window.setTimeout(() => {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    }, 50)
    return () => window.clearTimeout(t)
  }, [product, open, selectedGroupIds])

  if (!open || !product) {
    return null
  }

  const currentProduct = product

  function toggleGroup(id: string): void {
    setGroupIds((prev) =>
      prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id],
    )
  }

  /**
   * Create a group without leaving the dialog.
   * (Electron has no window.prompt, so this has to be a real input.)
   */
  async function handleNewGroup(): Promise<void> {
    if (!onCreateGroup) return
    const name = newGroupName.trim()
    if (!name) return

    const existing = allGroups.find(
      (g) => g.name.trim().toLowerCase() === name.toLowerCase(),
    )
    if (existing) {
      setGroupIds((prev) =>
        prev.includes(existing.id) ? prev : [...prev, existing.id],
      )
      setNewGroupOpen(false)
      setNewGroupName('')
      setHint(`Nhóm «${existing.name}» đã có sẵn — đã gán cho sản phẩm này`)
      return
    }

    setNewGroupBusy(true)
    setError(null)
    try {
      const id = await onCreateGroup(name)
      if (id) {
        setGroupIds((prev) => [...prev, id])
        setHint(`Đã tạo nhóm «${name}» và gán cho sản phẩm này`)
      }
      setNewGroupOpen(false)
      setNewGroupName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setNewGroupBusy(false)
    }
  }

  async function handlePasteImage(): Promise<void> {
    setPasteBusy(true)
    setError(null)
    setHint(null)
    try {
      const typed = imageUrl.trim()
      const looksLikeUrl = /^https?:\/\//i.test(typed)
      const result = await window.ezaff.products.pasteImage({
        productId: currentProduct.id,
        imageUrl: looksLikeUrl ? typed : undefined,
      })
      if (!result.success) {
        setError(result.error)
        return
      }
      setImageLocal(result.data.image_local)
      if (result.data.image_url) {
        setImageUrl(result.data.image_url)
      }
      setHint('Đã dán ảnh vào sản phẩm')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPasteBusy(false)
    }
  }

  async function handlePickImage(): Promise<void> {
    setPickBusy(true)
    setError(null)
    setHint(null)
    try {
      const result = await window.ezaff.products.pickImage({
        productId: currentProduct.id,
      })
      if (!result.success) {
        setError(result.error)
        return
      }
      if (result.data.cancelled) return
      setImageLocal(result.data.image_local)
      setHint('Đã lưu ảnh vào máy và gán cho sản phẩm')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPickBusy(false)
    }
  }

  async function handleOpenProductPage(): Promise<void> {
    setOpenPageBusy(true)
    setError(null)
    setHint(null)
    try {
      const result = await window.ezaff.products.openProductPage(
        currentProduct.original_url,
      )
      if (!result.success) {
        setError(result.error)
        return
      }
      if (!result.data.opened) {
        setError(result.data.message)
        return
      }
      setHint(result.data.message)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOpenPageBusy(false)
    }
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)

    const trimmedUrl = originalUrl.trim()
    if (!trimmedUrl) {
      setError('Link gốc không được để trống')
      return
    }
    try {
      void new URL(trimmedUrl)
    } catch {
      setError('Link gốc không hợp lệ')
      return
    }

    try {
      await onSave(
        {
          id: currentProduct.id,
          original_url: trimmedUrl,
          title: title.trim() || null,
          price: parsePriceInput(price),
          category: category.trim() || null,
          category_path: categoryPath.trim() || null,
          shop_name: shopName.trim() || null,
          note: note.trim() || null,
          image_url: imageUrl.trim() || null,
          image_local: imageLocal,
        },
        groupIds,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const previewSrc = productImageSrc(imageLocal, imageUrl.trim() || null)
  const formBusy = busy || pasteBusy || pickBusy || openPageBusy

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !formBusy) onClose()
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="dialog__header">
          <h2 className="dialog__title" id={titleId}>
            Sửa sản phẩm
          </h2>
          <button
            type="button"
            className="dialog__close"
            onClick={onClose}
            disabled={formBusy}
            aria-label="Đóng"
          >
            ✕
          </button>
        </div>

        <form className="dialog__body" onSubmit={(e) => void handleSubmit(e)}>
          <div className="field">
            <label className="field-label" htmlFor="edit-link">
              Link gốc
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                id="edit-link"
                type="text"
                className="input mono"
                style={{ height: 36, background: 'var(--surface-sunken)' }}
                value={linkRevealed ? originalUrl : maskAffiliateUrl(originalUrl)}
                readOnly={!linkRevealed}
                disabled={formBusy}
                spellCheck={false}
                autoComplete="off"
                aria-label={
                  linkRevealed ? 'Link gốc' : 'Link gốc (đã che)'
                }
                onChange={(e) => setOriginalUrl(e.target.value)}
              />
              <button
                type="button"
                className="btn"
                style={{ height: 36 }}
                onClick={() => setLinkRevealed((v) => !v)}
                disabled={formBusy}
                aria-pressed={linkRevealed}
              >
                {linkRevealed ? 'Ẩn' : '👁 Hiện'}
              </button>
            </div>
          </div>

          <div className="dialog__grid-main">
            <div className="field">
              <label className="field-label" htmlFor="edit-title">
                Tên sản phẩm
              </label>
              <input
                ref={titleInputRef}
                id="edit-title"
                className="input"
                style={{ height: 36 }}
                value={title}
                disabled={formBusy}
                placeholder="Nhập tên sản phẩm"
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="edit-price">
                Giá (VND)
              </label>
              <input
                id="edit-price"
                className="input num"
                style={{ height: 36 }}
                inputMode="numeric"
                value={price}
                disabled={formBusy}
                placeholder="1.050.000"
                onChange={(e) => setPrice(formatPriceInput(e.target.value))}
              />
            </div>
          </div>

          <div className="dialog__grid-2">
            <div className="field">
              <label className="field-label" htmlFor="edit-shop">
                Shop
              </label>
              <input
                id="edit-shop"
                className="input"
                style={{ height: 36 }}
                value={shopName}
                disabled={formBusy}
                placeholder="Chưa có"
                onChange={(e) => setShopName(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="edit-category">
                Danh mục
              </label>
              <input
                id="edit-category"
                className="input"
                style={{ height: 36 }}
                value={category}
                disabled={formBusy}
                placeholder="Ví dụ: Nhà bếp"
                list={categoryListId}
                autoComplete="off"
                onChange={(e) => setCategory(e.target.value)}
              />
              <datalist id={categoryListId}>
                {categorySuggestions.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="edit-category-path">
              Danh mục đầy đủ (phân cấp)
            </label>
            <input
              id="edit-category-path"
              className="input"
              style={{ height: 36 }}
              value={categoryPath}
              disabled={formBusy}
              spellCheck={false}
              placeholder="Điện Thoại &amp; Phụ Kiện > Phụ kiện điện thoại > Pin dự phòng"
              onChange={(e) => setCategoryPath(e.target.value)}
            />
            {categoryPath.trim() ? (
              <div className="crumbs">
                {categoryPath
                  .split('>')
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0)
                  .map((level, i, all) => (
                    <span className="crumbs__item" key={`${level}-${i}`}>
                      {level}
                      {i < all.length - 1 && (
                        <span className="crumbs__sep" aria-hidden>
                          ›
                        </span>
                      )}
                    </span>
                  ))}
              </div>
            ) : (
              <p className="field-hint">
                Ngăn cách các cấp bằng dấu <code>&gt;</code>. Dùng để chia danh
                mục trong thanh bên.
              </p>
            )}
          </div>

          <div className="field">
            <label className="field-label" htmlFor="edit-note">
              Ghi chú
            </label>
            <textarea
              id="edit-note"
              className="input"
              rows={2}
              value={note}
              disabled={formBusy}
              placeholder="Ghi chú riêng: hoa hồng, kỳ sale, ghi nhớ khi giới thiệu…"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          <div className="edit__image-row">
            <div className="field" style={{ flex: 1 }}>
              <span className="field-label">Ảnh sản phẩm</span>
              <div className="edit__image-actions">
                <button
                  type="button"
                  className="btn"
                  style={{ height: 34 }}
                  onClick={() => void handlePasteImage()}
                  disabled={formBusy}
                >
                  {pasteBusy ? 'Đang dán…' : 'Dán từ clipboard'}
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{ height: 34 }}
                  onClick={() => void handlePickImage()}
                  disabled={formBusy}
                >
                  {pickBusy ? 'Đang lưu…' : 'Chọn file…'}
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{ height: 34 }}
                  onClick={() => void handleOpenProductPage()}
                  disabled={formBusy}
                >
                  {openPageBusy ? 'Đang mở…' : 'Mở trang gốc'}
                </button>
              </div>
              <p className="edit__image-note">
                Ảnh mới sẽ được lưu vào máy, không phụ thuộc CDN của sàn.
              </p>
              <input
                className="input mono"
                style={{ height: 32, marginTop: 4, fontSize: 12 }}
                value={imageUrl}
                disabled={formBusy}
                spellCheck={false}
                placeholder="hoặc dán URL ảnh https://…"
                aria-label="URL ảnh"
                onChange={(e) => setImageUrl(e.target.value)}
              />
            </div>
            <div className="edit__thumb">
              {previewSrc ? (
                <img src={previewSrc} alt="Xem trước ảnh sản phẩm" />
              ) : (
                'Chưa có ảnh'
              )}
            </div>
          </div>

          <div className="edit__groups">
            <span className="field-label">Nhóm</span>
            {allGroups.length === 0 && !newGroupOpen && (
              <p className="edit__groups-empty">
                Chưa có nhóm nào. Tạo nhóm đầu tiên để lọc và sao chép hàng
                loạt theo chủ đề.
              </p>
            )}
            <div className="edit__groups-list">
              {allGroups.map((g, i) => {
                const on = groupIds.includes(g.id)
                return (
                  <button
                    key={g.id}
                    type="button"
                    className={
                      on ? 'group-toggle group-toggle--on' : 'group-toggle'
                    }
                    aria-pressed={on}
                    disabled={formBusy}
                    onClick={() => toggleGroup(g.id)}
                  >
                    <span
                      className="group-toggle__dot"
                      style={{ background: groupColor(g.color, i) }}
                      aria-hidden
                    />
                    {g.name}
                  </button>
                )
              })}

              {onCreateGroup &&
                (newGroupOpen ? (
                  <span className="group-new">
                    <input
                      className="input group-new__input"
                      value={newGroupName}
                      placeholder="Tên nhóm mới…"
                      aria-label="Tên nhóm mới"
                      maxLength={80}
                      autoFocus
                      disabled={newGroupBusy}
                      onChange={(e) => setNewGroupName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void handleNewGroup()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          setNewGroupOpen(false)
                          setNewGroupName('')
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-xs btn-primary"
                      disabled={newGroupBusy || !newGroupName.trim()}
                      onClick={() => void handleNewGroup()}
                    >
                      {newGroupBusy ? '…' : 'Tạo'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-xs"
                      disabled={newGroupBusy}
                      onClick={() => {
                        setNewGroupOpen(false)
                        setNewGroupName('')
                      }}
                    >
                      Huỷ
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="group-toggle group-toggle--new"
                    disabled={formBusy}
                    onClick={() => setNewGroupOpen(true)}
                  >
                    + Nhóm mới
                  </button>
                ))}
            </div>
          </div>

          {hint && !error && <p className="dialog__hint">{hint}</p>}
          {error && (
            <p className="dialog__error" role="alert">
              {error}
            </p>
          )}

          <div className="dialog__footer">
            <span className="dialog__footer-note">
              Sửa lần cuối: {formatDateTime(currentProduct.updated_at)}
            </span>
            <button
              type="button"
              className="btn btn-lg"
              onClick={onClose}
              disabled={formBusy}
            >
              Huỷ
            </button>
            <button
              type="submit"
              className="btn btn-lg btn-primary"
              disabled={formBusy}
            >
              {busy ? 'Đang lưu…' : 'Lưu thay đổi'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
