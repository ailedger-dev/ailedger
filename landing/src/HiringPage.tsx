import { useEffect, useRef } from 'react'
import './HiringPage.css'

/**
 * Hiring page — separate design language from the rest of the landing.
 * Tokens and layout match Figma frame 5:3 in
 * figma.com/design/XyN2MXiVyGm4ZlriQlATnX/Hiring-Page---First-Draft
 *
 * Repositioned 2026-05-30: lead with the opportunity, then the role, then how
 * we operate. The principled boundaries are retained — they're a recruiting
 * asset and they mirror the canonical Charter — but they're framed as the moat
 * that makes the evidence worth selling, not as a creed, and they sit below the
 * "why this is a smart bet to join" case rather than above it.
 *
 * Sections (top to bottom):
 *   1. Hero        — the product, in one line of buyer value
 *   2. Why now     — the category, the timing, why early matters
 *   3. Open roles  — what you'd own
 *   4. How we win  — operating principles + Charter refusals, reframed
 *   5. CTA
 *
 * Each section is its own component and is a direct child of <main>. The
 * page uses the normal single document scroll (no snap, no nested scroll
 * container); an IntersectionObserver toggles the .is-visible class as
 * sections cross the viewport to drive a fade + translate entrance (CSS
 * handles the transition). The hero is pre-marked visible on mount so it
 * animates in on page load.
 */
export default function HiringPage() {
  const pageRef = useRef<HTMLDivElement>(null)

  // Reveal each section as it enters the viewport. The hero is in view on
  // mount, so the observer fires for it on the first tick — that produces
  // the page-load entry animation. One-way: once revealed, a section stays
  // revealed (no flicker on scroll-up).
  useEffect(() => {
    const sections = pageRef.current?.querySelectorAll('section')
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
      { threshold: 0.18, rootMargin: '0px 0px -8% 0px' },
    )
    sections.forEach((s) => observer.observe(s))
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={pageRef} className="hiring-page">
      <header className="hiring-section hiring-topbar">
        <a className="hiring-home" href="/" aria-label="Back to AILedger home">
          <span className="hiring-home__arrow" aria-hidden="true">←</span>
          AILedger
        </a>
      </header>
      <main>
        <HiringHero />
        <HiringWhyNow />
        <HiringOpenRoles />
        <HiringPrinciples />
        <HiringCTA />
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
          admissible under Federal Rule of Evidence 707 and the EU AI Act — and a
          category being written into law right now. We&rsquo;re early, and we&rsquo;re hiring.
        </p>
        <a className="hiring-hero__cta" href="#open-roles">
          See open roles →
        </a>
      </div>
    </section>
  )
}

/* Why now — the case for joining, before any doctrine. Reuses the principles
   card grid so it inherits existing styling; no new CSS required. */
const WHY_NOW: { title: string; body: string }[] = [
  {
    title: 'The rules just arrived.',
    body: "Federal Rule of Evidence 707 and the EU AI Act turned 'we monitor our AI' into something you now have to prove. Regulated buyers need evidence that holds up in front of a regulator or a court — not assurances.",
  },
  {
    title: 'Budget exists. Good options don’t.',
    body: 'Most governance tools ship a static PDF that goes stale the moment a model retrains. Continuous, tamper-evident, standards-anchored evidence is the gap — and it’s what buyers are actually trying to fund.',
  },
  {
    title: 'Early enough to own the category.',
    body: 'This market is forming, not formed. The work here is shaping how defensible AI evidence gets built and sold — early enough to define the category, real enough to sell today.',
  },
]

function HiringWhyNow() {
  return (
    <section
      className="hiring-section hiring-principles"
      aria-labelledby="hiring-whynow-label"
    >
      <p id="hiring-whynow-label" className="hiring-eyebrow">
        WHY NOW
      </p>
      <div className="hiring-principles__list">
        {WHY_NOW.map((p) => (
          <article key={p.title} className="hiring-principles__item">
            <h2 className="hiring-principles__title">{p.title}</h2>
            <p className="hiring-principles__body">{p.body}</p>
          </article>
        ))}
      </div>
    </section>
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
      'Own go-to-market from zero. Find the regulated-industry buyers who need defensible AI evidence, build the pipeline, and shape how a new category gets sold. You’ll work directly with compliance leaders, general counsel, and risk owners — and you’ll qualify hard, because the deals that fit our substrate compound and the ones that don’t cost more than they pay.',
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
          Build the go-to-market for a category that didn&rsquo;t exist last year.
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

const PRINCIPLES: { title: string; body: string }[] = [
  {
    title: 'Boundaries that protect the evidence.',
    body: "We don't sell to companies in our refused categories, whatever the contract size — and it isn't idealism. A customer who games the audit turns our evidence into their liability and our reputation into collateral. The discipline is what keeps the record worth buying. The Charter names the lines in writing.",
  },
  {
    title: 'Detection thresholds anchor to standards.',
    body: 'EEOC four-fifths rule. Federal Reserve SR 11-7. OCC 2011-12. Customers can tighten thresholds toward stricter detection; they can’t loosen them. That’s precisely why a regulator trusts the output — and why it commands a premium.',
  },
  {
    title: 'Immutability is structural.',
    body: "Hash-chained records. UPDATE and DELETE raise exceptions at the database layer, even from service accounts. We don't ask people to be careful with history; we make rewriting it impossible.",
  },
  {
    title: 'We facilitate. We do not certify.',
    body: "Compliance is the customer's work; we provide the substrate. The distinction matters commercially: the alternative is audit theater, and audit theater is the failure mode that gets customers sued. Refusing to ship it is what makes our evidence defensible.",
  },
]

/* Refusals copy mirrors the canonical Charter in ailedger-dev/charter
   (CHARTER.md) and the published Charter at ailedger.dev/charter. Kept here
   verbatim and framed as the commercial moat; if the Charter is repositioned,
   update both in step. */
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

function HiringPrinciples() {
  return (
    <section
      className="hiring-section hiring-principles"
      aria-labelledby="hiring-principles-label"
    >
      <p id="hiring-principles-label" className="hiring-eyebrow">
        HOW WE WIN
      </p>
      <div className="hiring-principles__list">
        {PRINCIPLES.map((p) => (
          <article key={p.title} className="hiring-principles__item">
            <h2 className="hiring-principles__title">{p.title}</h2>
            <p className="hiring-principles__body">{p.body}</p>
          </article>
        ))}
      </div>

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

function HiringCTA() {
  return (
    <section className="hiring-section hiring-cta" aria-labelledby="hiring-cta-heading">
      <h2 id="hiring-cta-heading" className="hiring-display-md hiring-cta__question">
        Want to work on this?
      </h2>
      <p className="hiring-cta__body">
        See the open roles above, or send a note to{' '}
        <a className="hiring-cta__email" href="mailto:careers@ailedger.dev">
          careers@ailedger.dev
        </a>
        {' '}if you want to work on something we haven&rsquo;t posted yet.
      </p>
    </section>
  )
}
