import { type ReactNode } from 'react'

type Lvl = 'h1' | 'h2' | 'h3'

/** Display/md heading — visual scale is decoupled from semantic level, so the
 *  same look is used on h2 (section heading) and h3 (column/sub heading).
 *  `muted` switches the color to --ds-text-2 (used by the CTA body). */
export function DisplayHeading({
  as: As = 'h2',
  id,
  muted = false,
  className = '',
  children,
}: {
  as?: Lvl
  id?: string
  muted?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <As id={id} className={`ds-display-md ${muted ? 'ds-display-md--muted' : ''} ${className}`.trim()}>
      {children}
    </As>
  )
}
