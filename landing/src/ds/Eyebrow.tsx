import { type ReactNode } from 'react'

/** Uppercase section eyebrow (e.g. "WHAT WE BELIEVE"). Renders as a <p> — it is
 *  content (often an aria-labelledby target), styled via .ds-eyebrow / --ds-text-2. */
export function Eyebrow({ id, children }: { id?: string; children: ReactNode }) {
  return <p id={id} className="ds-eyebrow">{children}</p>
}
