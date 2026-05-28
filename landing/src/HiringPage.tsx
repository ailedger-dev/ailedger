import './HiringPage.css'

/**
 * Hiring page — separate design language from the rest of the landing.
 * Tokens and layout match Figma frame 5:3 in
 * figma.com/design/XyN2MXiVyGm4ZlriQlATnX/Hiring-Page---First-Draft
 *
 * Sections (Hero is implemented now; the rest land in follow-up prompts):
 *   1. Hero          — node 5:4   (this file)
 *   2. Principles    — node 5:9   (TODO)
 *   3. Refusals      — node 7:45  (TODO)
 *   4. Open roles    — node 11:67 (TODO)
 *   5. CTA           — node 13:83 (TODO)
 *
 * Each section is its own component and is a direct child of <main>, so future
 * sections drop in without restructuring the page.
 */
export default function HiringPage() {
  return (
    <div className="hiring-page">
      <main>
        <HiringHero />
        {/* Future sections render here, in the order above. */}
      </main>
    </div>
  )
}

function HiringHero() {
  return (
    <section className="hiring-section hiring-hero" aria-labelledby="hiring-hero-title">
      <div className="hiring-hero__intro">
        <h1 id="hiring-hero-title" className="hiring-hero__title">
          Audit-grade evidence for
          <br aria-hidden="true" />
          AI-influenced decisions
        </h1>
        <p className="hiring-hero__lede">
          The substrate that makes AI systems in regulated and adversarial contexts
          admissible under Federal Rule of Evidence 707 and the EU AI Act.
        </p>
        <a className="hiring-hero__cta" href="#open-roles">
          See open roles →
        </a>
      </div>
    </section>
  )
}
