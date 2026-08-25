import { useEffect, useId, useState } from 'react'
import { extractLinks } from '../../shared/linkDetect'
import { dragHasFiles, importablePathsFromDrop } from '../lib/fileDrop'

type Props = {
  open: boolean
  busy?: boolean
  /** Shown under the title — explains why the modal opened. */
  reason?: string
  onCancel: () => void
  onSubmit: (urls: string[]) => void
  /** A .csv / .xlsx file was dropped onto the dialog. */
  onFileDropped?: (filePath: string) => void
  /** Open the file picker for a .csv / .xlsx import. */
  onPickFile?: () => void
}

/**
 * "Thêm link affiliate" modal (mockup 2A). Only opens when the clipboard did
 * not already contain a usable link — otherwise adding is one click.
 */
export function AddLinkModal({
  open,
  busy = false,
  reason = 'Clipboard chưa có link hợp lệ — dán link vào đây',
  onCancel,
  onSubmit,
  onFileDropped,
  onPickFile,
}: Props) {
  const titleId = useId()
  const [draft, setDraft] = useState('')
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (open) {
      setDraft('')
      setDragging(false)
    }
  }, [open])

  if (!open) return null

  const links = extractLinks(draft)

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel()
      }}
    >
      <div
        className={dragging ? 'modal modal--dropping' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onDragOver={(e) => {
          if (!onFileDropped || !dragHasFiles(e.nativeEvent)) return
          e.preventDefault()
          e.stopPropagation()
          setDragging(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          setDragging(false)
        }}
        onDrop={(e) => {
          if (!onFileDropped) return
          e.preventDefault()
          e.stopPropagation()
          setDragging(false)
          const paths = importablePathsFromDrop(e.nativeEvent)
          if (paths[0]) onFileDropped(paths[0])
        }}
      >
        <div className="modal__head">
          <div>
            <div className="modal__title" id={titleId}>
              Thêm link affiliate
            </div>
            <div className="modal__sub">{reason}</div>
          </div>
          <button
            type="button"
            className="modal__close"
            onClick={onCancel}
            disabled={busy}
            aria-label="Đóng"
          >
            ✕
          </button>
        </div>

        <div className="modal__body">
          <textarea
            className="modal__area"
            value={draft}
            autoFocus
            spellCheck={false}
            disabled={busy}
            aria-label="Danh sách link"
            placeholder={
              dragging
                ? 'Thả file vào đây để nhập…'
                : 'https://s.shopee.vn/… — mỗi link một dòng'
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                if (links.length > 0) onSubmit(links)
              }
            }}
          />

          <div className="modal__row">
            <span
              className="modal__count"
              style={{
                color: links.length ? 'var(--primary)' : 'var(--muted-2)',
              }}
            >
              {links.length === 0
                ? 'Chưa nhận được link hợp lệ'
                : `Nhận được ${links.length} link hợp lệ`}
            </span>
            <button
              type="button"
              className="pill pill--sm"
              onClick={onCancel}
              disabled={busy}
              style={{ background: 'var(--neutral)' }}
            >
              Huỷ
            </button>
            <button
              type="button"
              className="pill pill--sm"
              style={{
                background: 'var(--primary)',
                color: '#fff',
                boxShadow: 'none',
              }}
              disabled={busy || links.length === 0}
              onClick={() => onSubmit(links)}
            >
              {busy ? 'Đang thêm…' : 'Thêm & quét'}
            </button>
          </div>

          {onPickFile && (
            <div className="modal__filehint">
              <span className="modal__filehint-text">
                Có sẵn file từ Shopee «Lấy link hàng loạt»? Kéo thả file{' '}
                <strong>.csv</strong> / <strong>.xlsx</strong> vào đây
              </span>
              <button
                type="button"
                className="pill pill--sm"
                style={{ background: 'var(--neutral)' }}
                disabled={busy}
                onClick={onPickFile}
              >
                Chọn file…
              </button>
            </div>
          )}

          <p className="modal__note">
            Hỗ trợ Shopee, Lazada, TikTok Shop, Tiki. Link trùng sẽ tự bỏ qua;
            link quét lỗi vẫn được lưu để nhập tay.
          </p>
        </div>
      </div>
    </div>
  )
}
