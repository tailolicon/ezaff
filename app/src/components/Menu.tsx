import { useEffect, type ReactNode } from 'react'

type Props = {
  open: boolean
  /** Where the popup sits relative to its positioned parent. */
  placement?: 'up' | 'down-left' | 'down-right'
  label: string
  onClose: () => void
  children: ReactNode
}

/**
 * Small dropdown used by the copy button, bulk bar and row "⋯" menus.
 * Closes on Escape and on any click outside (transparent backdrop button).
 */
export function Menu({
  open,
  placement = 'down-right',
  label,
  onClose,
  children,
}: Props) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const className =
    placement === 'up'
      ? 'menu menu--up'
      : placement === 'down-left'
        ? 'menu menu--down-left'
        : 'menu menu--down-right'

  return (
    <>
      <button
        type="button"
        className="popover-backdrop"
        aria-label="Đóng menu"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
      />
      <ul className={className} role="menu" aria-label={label}>
        {children}
      </ul>
    </>
  )
}

type ItemProps = {
  onSelect: () => void
  disabled?: boolean
  danger?: boolean
  separated?: boolean
  badge?: string
  children: ReactNode
}

export function MenuItem({
  onSelect,
  disabled = false,
  danger = false,
  separated = false,
  badge,
  children,
}: ItemProps) {
  const classes = ['menu__item']
  if (danger) classes.push('menu__item--danger')
  if (separated) classes.push('menu__item--sep')

  return (
    <li role="none">
      <button
        type="button"
        role="menuitem"
        className={classes.join(' ')}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation()
          onSelect()
        }}
      >
        <span className="menu__name">{children}</span>
        {badge ? <span className="menu__badge">{badge}</span> : null}
      </button>
    </li>
  )
}
