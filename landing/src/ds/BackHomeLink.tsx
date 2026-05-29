import { type CSSProperties } from 'react'

/** The only nav chrome on a standalone design-system page: a back-to-site link
 *  with an animated arrow. Focus ring uses a 4px offset (vs the 3px default). */
export function BackHomeLink({
  href = '/',
  label,
  ariaLabel,
}: {
  href?: string
  label: string
  ariaLabel: string
}) {
  return (
    <a
      className="ds-home ds-focus"
      href={href}
      aria-label={ariaLabel}
      style={{ '--ds-focus-offset': '4px' } as CSSProperties}
    >
      <span className="ds-home__arrow" aria-hidden="true">←</span>
      {label}
    </a>
  )
}
