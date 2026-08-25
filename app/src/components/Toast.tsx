import { useEffect } from 'react'

export type ToastData = {
  message: string
  /** Optional inline action, e.g. "Hoàn tác". */
  actionLabel?: string
  onAction?: () => void
}

type Props = {
  toast: ToastData | null
  onDismiss: () => void
  /** Auto-dismiss ms; 0 = sticky until closed. Default 3200. */
  durationMs?: number
}

/** Pill confirmation toast with an optional undo (mockup 2A). */
export function Toast({ toast, onDismiss, durationMs = 3200 }: Props) {
  const message = toast?.message ?? null

  useEffect(() => {
    if (!message || durationMs <= 0) return
    const t = window.setTimeout(onDismiss, durationMs)
    return () => window.clearTimeout(t)
  }, [message, durationMs, onDismiss])

  if (!toast) return null

  return (
    <div className="toast" role="status" aria-live="polite">
      <span className="toast__text">{toast.message}</span>
      {toast.actionLabel && toast.onAction && (
        <button
          type="button"
          className="toast__action"
          onClick={() => {
            toast.onAction?.()
            onDismiss()
          }}
        >
          {toast.actionLabel}
        </button>
      )}
      <button
        type="button"
        className="toast__dismiss"
        onClick={onDismiss}
        aria-label="Đóng thông báo"
      >
        ✕
      </button>
    </div>
  )
}
