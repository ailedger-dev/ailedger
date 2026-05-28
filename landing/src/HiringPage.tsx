import './HiringPage.css'

/**
 * Hiring page — separate design language from the rest of the landing.
 * Tokens and layout match Figma frame 5:3 in
 * figma.com/design/XyN2MXiVyGm4ZlriQlATnX/Hiring-Page---First-Draft
 *
 * Sections:
 *   1. Hero          — node 5:4   ✓
 *   2. Principles    — node 5:9   ✓
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
        <HiringPrinciples />
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

const PRINCIPLES: { title: string; body: string }[] = [
  {
    title: 'Principled Boundaries',
    body: "Companies in our refused categories don't get sold to, no matter the contract size. The Charter names them in writing.",
  },
  {
    title: 'Detection thresholds anchor to standards.',
    body: 'EEOC four-fifths rule. FDIC SR 11-7. OCC 2011-12. Customers can tighten thresholds toward stricter detection. They cannot loosen them. The refusal is structural, not policy.',
  },
  {
    title: 'Immutability is structural.',
    body: "Hash-chained records. UPDATE and DELETE raise exceptions at the database layer, even from service accounts. We don't ask people to be careful with history; we make rewriting it impossible.",
  },
  {
    title: 'We facilitate. We do not certify.',
    body: "Compliance is the customer's work. We provide a substrate. The distinction matters because the alternative is audit theater, and audit theater is the failure mode we exist to refuse.",
  },
]

function HiringPrinciples() {
  return (
    <section
      className="hiring-section hiring-principles"
      aria-labelledby="hiring-principles-label"
    >
      <p id="hiring-principles-label" className="hiring-eyebrow">
        WHAT WE BELIEVE
      </p>
      <div className="hiring-principles__list">
        {PRINCIPLES.map((p) => (
          <article key={p.title} className="hiring-principles__item">
            <h2 className="hiring-principles__title">{p.title}</h2>
            <p className="hiring-principles__body">{p.body}</p>
          </article>
        ))}
      </div>
    </section>
  )
}
