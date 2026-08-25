type Props = {
  checked: boolean
  /** Some — but not all — rows selected. */
  indeterminate?: boolean
  label: string
  disabled?: boolean
  onChange: () => void
}

/** Square selection box matching the mockup's list view. */
export function Checkbox({
  checked,
  indeterminate = false,
  label,
  disabled = false,
  onChange,
}: Props) {
  const className = indeterminate
    ? 'checkbox checkbox--mixed'
    : checked
      ? 'checkbox checkbox--on'
      : 'checkbox'

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label}
      className={className}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onChange()
      }}
    >
      {indeterminate ? '–' : checked ? '✓' : ''}
    </button>
  )
}
