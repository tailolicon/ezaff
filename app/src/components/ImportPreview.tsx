import { useEffect, useId, useState } from 'react'
import { formatCount } from '../lib/format'

export type ImportPreviewData = {
  filePath: string
  validCount: number
  duplicateCount: number
  invalidCount: number
  totalDataRows: number
  detection: ColumnDetection
}

/** Columns worth reporting back to the user, in reading order. */
const REPORTED_COLUMNS = [
  'Link aff',
  'Tên sản phẩm',
  'Giá',
  'URL ảnh',
  'Tên shop',
  'Danh mục',
  'Nhóm',
  'Ghi chú',
  'Ngày thêm',
] as const

type Props = {
  preview: ImportPreviewData | null
  open: boolean
  busy?: boolean
  onPickAnother: () => void
  onCancel: () => void
  onConfirm: (overwrite: boolean) => Promise<void>
}

function splitPath(full: string): { dir: string; name: string } {
  const parts = full.split(/[/\\]/)
  const name = parts.pop() || full
  return { dir: parts.join('\\') || '—', name }
}

/** Error workbook name shown before the import runs. */
function errorFileName(filePath: string): string {
  const { name } = splitPath(filePath)
  return name.replace(/\.xlsx$/i, '') + '-loi.xlsx'
}

/**
 * Shows how the file was read: which sheet, where the header row was found (or
 * that there was none) and which column became which field. Users arrange
 * their sheets freely, so this is the only way to confirm we guessed right.
 */
function DetectionNote({ detection }: { detection: ColumnDetection }) {
  const mapped = REPORTED_COLUMNS.filter((key) => detection.mapping[key])
  const headerText =
    detection.headerRowNumber === null
      ? 'không có dòng tiêu đề — nhận diện theo nội dung'
      : `tiêu đề ở dòng ${detection.headerRowNumber}`

  return (
    <div className="detect">
      <div className="detect__head">
        <span className="detect__label">Đã nhận diện</span>
        <span className="detect__meta">
          Sheet «{detection.sheetName}» · {headerText} · dữ liệu từ dòng{' '}
          {detection.firstDataRow}
        </span>
      </div>
      <div className="detect__map">
        {mapped.map((key) => (
          <span className="detect__pair" key={key}>
            <span className="detect__to">{key}</span>
            <span className="detect__arrow" aria-hidden>
              ←
            </span>
            <span className="detect__from">{detection.mapping[key]}</span>
          </span>
        ))}
      </div>
      {mapped.length <= 2 && (
        <p className="detect__hint">
          Chỉ nhận ra cột link. Các thông tin còn thiếu (tên, giá, ảnh) sẽ được
          tự quét sau khi nhập.
        </p>
      )}
    </div>
  )
}

/**
 * "Nhập từ Excel" preview (mockup frame E). Nothing is written to the
 * database until the user confirms — duplicates are skipped by default.
 */
export function ImportPreview({
  preview,
  open,
  busy = false,
  onPickAnother,
  onCancel,
  onConfirm,
}: Props) {
  const titleId = useId()
  const [overwrite, setOverwrite] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setOverwrite(false)
      setError(null)
    }
  }, [open, preview?.filePath])

  if (!open || !preview) return null

  const { dir, name } = splitPath(preview.filePath)

  async function handleConfirm(): Promise<void> {
    setError(null)
    try {
      await onConfirm(overwrite)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const importable =
    preview.validCount + (overwrite ? preview.duplicateCount : 0)

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel()
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
            Nhập từ Excel
          </h2>
          <button
            type="button"
            className="dialog__close"
            onClick={onCancel}
            disabled={busy}
            aria-label="Đóng"
          >
            ✕
          </button>
        </div>

        <div className="dialog__body">
          <div className="import__file">
            <div className="import__icon" aria-hidden>
              XLS
            </div>
            <div className="import__file-meta">
              <div className="import__file-name" title={preview.filePath}>
                {name}
              </div>
              <div className="import__file-path">
                {dir} · {formatCount(preview.totalDataRows)} dòng dữ liệu
              </div>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={onPickAnother}
              disabled={busy}
            >
              Đổi file
            </button>
          </div>

          <DetectionNote detection={preview.detection} />

          <div className="import__stats" role="status">
            <div className="import__stat import__stat--valid">
              <div className="import__stat-label">Hợp lệ</div>
              <div className="import__stat-value">
                {formatCount(preview.validCount)}
              </div>
            </div>
            <div className="import__stat">
              <div className="import__stat-label">Trùng link</div>
              <div className="import__stat-value">
                {formatCount(preview.duplicateCount)}
              </div>
            </div>
            <div className="import__stat import__stat--invalid">
              <div className="import__stat-label">Lỗi định dạng</div>
              <div className="import__stat-value">
                {formatCount(preview.invalidCount)}
              </div>
            </div>
            <div className="import__stat">
              <div className="import__stat-label">Tổng dòng</div>
              <div className="import__stat-value">
                {formatCount(preview.totalDataRows)}
              </div>
            </div>
          </div>

          {preview.duplicateCount > 0 && (
            <div className="field">
              <span className="field-label">
                Với {formatCount(preview.duplicateCount)} link trùng
              </span>
              <div
                className="radio-list"
                role="radiogroup"
                aria-label="Cách xử lý link trùng"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={!overwrite}
                  className={
                    overwrite ? 'radio-option' : 'radio-option radio-option--on'
                  }
                  disabled={busy}
                  onClick={() => setOverwrite(false)}
                >
                  <span className="radio-option__mark" aria-hidden />
                  <span>Bỏ qua — giữ nguyên dữ liệu đang có</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={overwrite}
                  className={
                    overwrite ? 'radio-option radio-option--on' : 'radio-option'
                  }
                  disabled={busy}
                  onClick={() => setOverwrite(true)}
                >
                  <span className="radio-option__mark" aria-hidden />
                  <span>Ghi đè — cập nhật tên, giá, ảnh, ghi chú từ file</span>
                </button>
              </div>
            </div>
          )}

          {preview.invalidCount > 0 && (
            <p className="import__note">
              {formatCount(preview.invalidCount)} dòng lỗi sẽ được xuất ra{' '}
              <span className="code-inline">
                {errorFileName(preview.filePath)}
              </span>{' '}
              để bạn sửa và nhập lại.
            </p>
          )}

          {error && (
            <p className="dialog__error" role="alert">
              {error}
            </p>
          )}

          <div className="dialog__footer">
            <button
              type="button"
              className="btn btn-lg"
              onClick={onCancel}
              disabled={busy}
            >
              Huỷ
            </button>
            <button
              type="button"
              className="btn btn-lg btn-primary"
              onClick={() => void handleConfirm()}
              disabled={busy || importable === 0}
            >
              {busy
                ? 'Đang nhập…'
                : `Nhập ${formatCount(importable)} sản phẩm`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
