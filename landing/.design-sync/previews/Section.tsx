import { Section, Eyebrow, DisplayHeading } from 'landing'

// Each export sweeps the `pad` vertical-rhythm tier. Wrapped in .ds-root so the
// --ds-* tokens resolve and the dark surface paints (PageShell does this on a
// real page). min-height is relaxed from the 100vh page-floor for the card.
function Surface({ children }: { children: React.ReactNode }) {
  return (
    <div className="ds-root" style={{ minHeight: 'auto' }}>
      {children}
    </div>
  )
}

export function Standard() {
  return (
    <Surface>
      <Section pad="standard" ariaLabelledby="s-std">
        <Eyebrow>HOW IT WORKS</Eyebrow>
        <DisplayHeading as="h2" id="s-std">
          Standard rhythm — the default body section.
        </DisplayHeading>
      </Section>
    </Surface>
  )
}

export function Hero() {
  return (
    <Surface>
      <Section pad="hero" ariaLabelledby="s-hero">
        <DisplayHeading as="h1" id="s-hero">
          Hero — top of page, no bottom padding.
        </DisplayHeading>
      </Section>
    </Surface>
  )
}

export function Cta() {
  return (
    <Surface>
      <Section pad="cta" ariaLabelledby="s-cta">
        <DisplayHeading as="h2" id="s-cta" muted>
          CTA — deep bottom padding closes the page.
        </DisplayHeading>
      </Section>
    </Surface>
  )
}

export function Topbar() {
  return (
    <Surface>
      <Section pad="topbar">
        <Eyebrow>TOPBAR — TIGHT TOP PADDING FOR NAV CHROME</Eyebrow>
      </Section>
    </Surface>
  )
}
