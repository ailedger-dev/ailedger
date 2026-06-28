import { PageShell, Section, Eyebrow, DisplayHeading } from 'landing'

/** The canonical use: PageShell establishes the dark .ds-root surface (tokens +
 *  Inter) and owns the reveal observer; everything else composes inside it. */
export function PageHero() {
  return (
    <PageShell>
      <Section pad="hero" ariaLabelledby="ph-hero">
        <Eyebrow>WHAT WE BELIEVE</Eyebrow>
        <DisplayHeading as="h1" id="ph-hero">
          Evidence you can take to court.
        </DisplayHeading>
        <p className="ds-lede">
          AILedger turns every model decision into a tamper-evident record —
          admissible under FRE&nbsp;707 and aligned to the EU AI Act.
        </p>
      </Section>
    </PageShell>
  )
}
