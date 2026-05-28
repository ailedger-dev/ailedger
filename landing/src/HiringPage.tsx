import './HiringPage.css'

/**
 * Hiring page — separate design language from the rest of the landing.
 * Tokens and layout match Figma frame 5:3 in
 * figma.com/design/XyN2MXiVyGm4ZlriQlATnX/Hiring-Page---First-Draft
 *
 * Sections:
 *   1. Hero          — node 5:4   ✓
 *   2. Principles    — node 5:9   ✓
 *   3. Refusals      — node 7:45  ✓
 *   4. Open roles    — node 11:67 ✓
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
        <HiringRefusals />
        <HiringOpenRoles />
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

/* Refusals copy mirrors CHARTER.md in this same public repo and the published
   Charter at ailedger.dev/charter — sourced verbatim from Figma node 7:45. */
const REFUSED_CUSTOMERS: readonly string[] = [
  'Companies whose underlying AI use is itself the harm: predictive policing, social scoring, deceptive targeting of vulnerable populations.',
  'Companies that request detection configurations designed to suppress findings.',
  'Companies whose primary purpose is paperwork generation rather than catching problems.',
  'Companies under active enforcement action seeking AILedger as bad-faith litigation defense.',
]

const REFUSED_FEATURES: readonly string[] = [
  'Configurable thresholds that allow suppression below standards-aligned defaults.',
  '“Compliance mode” that generates reports without underlying detection.',
  'Removal of required-action workflows for detected events.',
  'Selective logging that excludes decision categories at customer request.',
]

function HiringRefusals() {
  return (
    <section
      className="hiring-section hiring-refusals"
      aria-labelledby="hiring-refusals-heading"
    >
      <header className="hiring-refusals__header">
        <p className="hiring-eyebrow">THE CHARTER</p>
        <h2 id="hiring-refusals-heading" className="hiring-display-md">
          What we won&rsquo;t do
        </h2>
      </header>
      <div className="hiring-refusals__columns">
        <RefusalsColumn title="Customers we refuse" items={REFUSED_CUSTOMERS} />
        <RefusalsColumn title={'Features we won’t build'} items={REFUSED_FEATURES} />
      </div>
    </section>
  )
}

function RefusalsColumn({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div className="hiring-refusals__column">
      <h3 className="hiring-display-md">{title}</h3>
      <ul className="hiring-refusals__items">
        {items.map((item) => (
          <li key={item} className="hiring-refusals__item">
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}

type Role = {
  title: string
  meta: string
  description: string
  href: string
}

const ROLES: readonly Role[] = [
  {
    title: 'Founding Sales',
    meta: 'Go-to-market · Remote (US / EU)',
    description:
      "Identify regulated-industry buyers whose AI compliance posture matches AILedger's substrate. Build the pipeline from scratch. Refuse the wrong customers cheerfully.",
    href: 'mailto:careers@ailedger.dev?subject=Founding%20Sales',
  },
]

function HiringOpenRoles() {
  return (
    <section
      id="open-roles"
      className="hiring-section hiring-open-roles"
      aria-labelledby="hiring-open-roles-heading"
    >
      <header className="hiring-open-roles__header">
        <p className="hiring-eyebrow">OPEN ROLES</p>
        <h2 id="hiring-open-roles-heading" className="hiring-display-md">
          Work on something that refuses easy answers.
        </h2>
      </header>
      <ul className="hiring-open-roles__list">
        {ROLES.map((role) => (
          <li key={role.title} className="hiring-open-roles__row">
            <a className="hiring-open-roles__link" href={role.href}>
              <div className="hiring-open-roles__content">
                <h3 className="hiring-open-roles__title">{role.title}</h3>
                <p className="hiring-open-roles__meta">{role.meta}</p>
                <p className="hiring-open-roles__description">{role.description}</p>
              </div>
              <span className="hiring-open-roles__arrow" aria-hidden="true">
                →
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}
