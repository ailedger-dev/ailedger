import { useEffect, type RefObject } from 'react'

export const REVEAL_THRESHOLD = 0.18
export const REVEAL_ROOT_MARGIN = '0px 0px -8% 0px'

/**
 * Toggle `.is-visible` on every <section> under `rootRef` as it enters the
 * viewport. One-way (no re-hide on scroll-up). A section in view on mount
 * (e.g. the hero) is revealed on the observer's first tick → page-load entry.
 * Falls back to revealing everything if IntersectionObserver is unavailable.
 *
 * Extracted verbatim from /hiring so any design-system page gets the same
 * reveal behavior. Children opt in with `.ds-reveal` (see primitives.css);
 * per-item stagger is owned by the consuming page's CSS.
 */
export function useReveal(rootRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const sections = rootRef.current?.querySelectorAll('section')
    if (!sections || sections.length === 0) return
    if (typeof IntersectionObserver === 'undefined') {
      sections.forEach((s) => s.classList.add('is-visible'))
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible')
            observer.unobserve(entry.target)
          }
        }
      },
      { threshold: REVEAL_THRESHOLD, rootMargin: REVEAL_ROOT_MARGIN },
    )
    sections.forEach((s) => observer.observe(s))
    return () => observer.disconnect()
  }, [rootRef])
}
