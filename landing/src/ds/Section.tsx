import { useRef, type ElementType, type ReactNode } from 'react'
import { useReveal } from './useReveal'

/**
 * Dark design-system page container. Establishes the .ds-root surface + Inter
 * (via primitives.css), owns the reveal observer (observes every <section>
 * child), and the single-document-scroll fix applies via :has(.ds-root).
 *
 * A page that does not want reveal animation (e.g. docs) simply puts no
 * `.ds-reveal` elements inside — the observer then toggles an inert class and
 * nothing animates. (If even the observer is unwanted, compose .ds-root /
 * <Section> directly without PageShell.)
 */
export function PageShell({ className = '', children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useReveal(ref)
  return <div ref={ref} className={`ds-root ${className}`.trim()}>{children}</div>
}

type Pad = 'standard' | 'hero' | 'cta' | 'topbar' | 'none'

/**
 * A horizontally-guttered <section> with one of the vertical-rhythm tiers.
 * Vertical gap between children is NOT set here (each section's gap differs) —
 * pass via className or a wrapper.
 */
export function Section({
  as = 'section',
  pad = 'standard',
  id,
  className = '',
  ariaLabelledby,
  children,
}: {
  as?: ElementType
  pad?: Pad
  id?: string
  className?: string
  ariaLabelledby?: string
  children: ReactNode
}) {
  const As = as
  const padClass = pad === 'none' ? '' : `ds-section--${pad}`
  return (
    <As id={id} aria-labelledby={ariaLabelledby} className={`ds-section ${padClass} ${className}`.trim()}>
      {children}
    </As>
  )
}
