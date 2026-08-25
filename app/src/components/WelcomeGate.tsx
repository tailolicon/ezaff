import { useEffect, useId, useRef, useState } from 'react'
import { BrandLockup } from './BrandMark'
import { hasSeenWelcome, markWelcomeSeen } from '../lib/welcome'

type Props = {
  onDismissed?: () => void
}

export function WelcomeGate({ onDismissed }: Props) {
  const [open, setOpen] = useState(() =>
    typeof window === 'undefined' ? false : !hasSeenWelcome(),
  )
  const sheetRef = useRef<HTMLDivElement>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descId = useId()

  useEffect(() => {
    if (!open) return
    primaryRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        dismiss()
        return
      }
      if (e.key !== 'Tab' || !sheetRef.current) return
      const focusable = sheetRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled])',
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  function dismiss(): void {
    markWelcomeSeen()
    setOpen(false)
    onDismissed?.()
  }

  if (!open) return null

  return (
    <div className="welcome" role="presentation">
      <div className="welcome__veil" onClick={dismiss} aria-hidden />
      <div
        ref={sheetRef}
        className="welcome__sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
      >
        <div className="welcome__bloom" aria-hidden>
          <span className="welcome__bloom-ring welcome__bloom-ring--a" />
          <span className="welcome__bloom-ring welcome__bloom-ring--b" />
        </div>

        <header className="welcome__top">
          <BrandLockup markSize={26} tagline />
          <div className="welcome__seal" aria-hidden>
            <span className="welcome__seal-price">0₫</span>
            <span className="welcome__seal-label">Miễn phí</span>
          </div>
        </header>

        <h1 id={titleId} className="welcome__title">
          Ứng dụng này
          <span className="welcome__title-em">Hoàn toàn miễn phí.</span>
        </h1>

        <p id={descId} className="welcome__lede">
          Không gói Pro, không khóa tính năng, không
          hết hạn.
        </p>

        <blockquote className="welcome__ask">
          <p>Thấy hữu ích? Hãy chia sẻ với mọi người.</p>
          <p className="welcome__ask-sub">
            Một lời giới thiệu đáng hơn mọi banner.
          </p>
        </blockquote>

        <div className="welcome__actions">
          <button
            ref={primaryRef}
            type="button"
            className="welcome__go"
            onClick={dismiss}
          >
            Bắt đầu dùng
          </button>
        </div>
      </div>
    </div>
  )
}
