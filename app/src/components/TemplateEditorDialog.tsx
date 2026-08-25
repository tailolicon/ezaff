import { useEffect, useRef, useState } from 'react'

/** Tokens buildCopyText substitutes. Kept in step with the main process. */
export const TEMPLATE_VARIABLES = [
  { token: '{ten}', label: 'Tên sản phẩm' },
  { token: '{gia}', label: 'Giá' },
  { token: '{shop}', label: 'Tên shop' },
  { token: '{danhgia}', label: 'Đánh giá' },
  { token: '{link}', label: 'Link' },
] as const

type Props = {
  open: boolean
  /** Editing an existing template, or null to create a new one. */
  existing?: { id: string; name: string; content: string } | null
  onClose: () => void
  onSaved: () => void
  onError: (message: string) => void
}

/**
 * Compact template editor opened straight from the copy button.
 *
 * Templates used to live only on the settings page, which meant leaving the
 * library to change the sentence you were about to paste. This puts it where
 * the decision actually happens.
 */
export function TemplateEditorDialog({
  open,
  existing = null,
  onClose,
  onSaved,
  onError,
}: Props) {
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [makeDefault, setMakeDefault] = useState(false)
  const [saving, setSaving] = useState(false)
  const contentRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!open) return
    setName(existing?.name ?? '')
    setMakeDefault(false)
    setContent(existing?.content ?? '{ten}\n\n👉 {link}')
  }, [open, existing])

  if (!open) return null

  /**
   * Insert at the caret rather than appending — a variable belongs mid
   * sentence far more often than at the end.
   */
  function insertVariable(token: string): void {
    const el = contentRef.current
    if (!el) {
      setContent((c) => c + token)
      return
    }
    const start = el.selectionStart ?? content.length
    const end = el.selectionEnd ?? content.length
    const next = content.slice(0, start) + token + content.slice(end)
    setContent(next)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + token.length, start + token.length)
    })
  }

  async function handleSave(): Promise<void> {
    const trimmedName = name.trim()
    const trimmedContent = content.trim()
    if (!trimmedName) {
      onError('Đặt tên cho mẫu câu đã')
      return
    }
    if (!trimmedContent.includes('{link}')) {
      // Without it the copied text has no link at all — silently useless.
      onError('Mẫu câu phải chứa {link}, nếu không người đọc không bấm vào đâu được')
      return
    }

    setSaving(true)
    try {
      const result = existing
        ? await window.ezaff.templates.update({
            id: existing.id,
            name: trimmedName,
            content: trimmedContent,
          })
        : await window.ezaff.templates.create({
            name: trimmedName,
            content: trimmedContent,
          })

      if (!result.success) {
        onError(result.error)
        return
      }

      /*
       * The main Copy button always uses the default template, so a new one
       * is invisible until it becomes the default. Without this the only way
       * to actually use what you just wrote was the dropdown, every time.
       */
      if (makeDefault && 'id' in result.data) {
        const promoted = await window.ezaff.templates.setDefault(result.data.id)
        if (!promoted.success) {
          onError(promoted.error)
          return
        }
      }

      onSaved()
      onClose()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="dialog dialog--narrow"
        role="dialog"
        aria-modal="true"
        aria-label={existing ? 'Sửa mẫu câu' : 'Tạo mẫu câu mới'}
      >
        <div className="dialog__header">
          <h2 className="dialog__title">
            {existing ? 'Sửa mẫu câu' : 'Mẫu câu mới'}
          </h2>
          <button
            type="button"
            className="dialog__close"
            aria-label="Đóng"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="dialog__body">
          <div className="field">
            <label className="field-label" htmlFor="tpl-name">
              Tên mẫu
            </label>
            <input
              id="tpl-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ví dụ: Bài đăng Facebook"
              maxLength={80}
              autoFocus
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="tpl-content">
              Nội dung
            </label>
            <div className="tplvars">
              {TEMPLATE_VARIABLES.map((v) => (
                <button
                  key={v.token}
                  type="button"
                  className="tplvars__chip"
                  title={`Chèn ${v.label}`}
                  onClick={() => insertVariable(v.token)}
                >
                  {v.token}
                </button>
              ))}
            </div>
            <textarea
              id="tpl-content"
              ref={contentRef}
              className="input input--area"
              rows={7}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Câu mời chào của bạn…"
            />
            <p className="field-hint">
              Bấm vào biến ở trên để chèn vào chỗ đang gõ. Bắt buộc có{' '}
              <code>{'{link}'}</code>.
            </p>
          </div>

          <label className="tpldefault">
            <input
              type="checkbox"
              checked={makeDefault}
              onChange={(e) => setMakeDefault(e.target.checked)}
            />
            <span>
              Đặt làm mẫu mặc định
              <span className="tpldefault__hint">
                — nút “Sao chép” sẽ dùng mẫu này
              </span>
            </span>
          </label>
        </div>

        <div className="dialog__footer">
          <button type="button" className="btn btn-lg" onClick={onClose}>
            Huỷ
          </button>
          <button
            type="button"
            className="btn btn-lg btn-primary"
            disabled={saving}
            onClick={() => void handleSave()}
          >
            {saving ? 'Đang lưu…' : 'Lưu mẫu'}
          </button>
        </div>
      </div>
    </div>
  )
}
