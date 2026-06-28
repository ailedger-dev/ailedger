import { Eyebrow } from 'landing'

// Eyebrow is an uppercase section label (a <p>); it reads its color/letter-
// spacing from .ds-* tokens, so it must mount inside a .ds-root surface.
function Surface({ children }: { children: React.ReactNode }) {
  return (
    <div className="ds-root" style={{ minHeight: 'auto', padding: 32 }}>
      {children}
    </div>
  )
}

export function Default() {
  return (
    <Surface>
      <Eyebrow>WHAT WE BELIEVE</Eyebrow>
    </Surface>
  )
}

/** Often the aria-labelledby target for the heading that follows it. */
export function AsSectionLabel() {
  return (
    <Surface>
      <Eyebrow id="eb-belief">THE STANDARD</Eyebrow>
    </Surface>
  )
}
