/**
 * 1C lockup from EZAFF Logo.dc.html — two linked rings + wordmark.
 * No rotate, no shadow, no gradient.
 */

type MarkProps = {
  size?: number
  /** 'app' = green + ink (default). 'mono' = both ink. */
  tone?: 'app' | 'mono'
}

export function BrandMark({ size = 20, tone = 'app' }: MarkProps) {
  const stroke = Math.max(3, Math.round(size * 0.2))
  const overlap = Math.round(size * 0.3)
  return (
    <span
      className={
        tone === 'mono' ? 'brand-mark brand-mark--mono' : 'brand-mark'
      }
      style={{ height: size }}
      aria-hidden
    >
      <span
        className="brand-mark__ring brand-mark__ring--a"
        style={{
          width: size,
          height: size,
          borderWidth: stroke,
        }}
      />
      <span
        className="brand-mark__ring brand-mark__ring--b"
        style={{
          width: size,
          height: size,
          borderWidth: stroke,
          marginLeft: -overlap,
        }}
      />
    </span>
  )
}

type LockupProps = {
  markSize?: number
  tagline?: boolean
  collapsed?: boolean
}

export function BrandLockup({
  markSize = 20,
  tagline = false,
  collapsed = false,
}: LockupProps) {
  if (collapsed) {
    return (
      <div className="brand-lockup brand-lockup--solo" aria-label="ezaff">
        <BrandMark size={markSize} />
      </div>
    )
  }

  return (
    <div className="brand-lockup" aria-label="ezaff">
      <BrandMark size={markSize} />
      <div className="brand-lockup__text">
        <span className="brand-lockup__name">ezaff</span>
        {tagline && (
          <span className="brand-lockup__tag">link affiliate</span>
        )}
      </div>
    </div>
  )
}
