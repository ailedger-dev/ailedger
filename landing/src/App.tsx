import { useState } from 'react'

const DASHBOARD_URL = 'https://dash.ailedger.dev?view=sign-up'
const PROXY_URL = 'https://proxy.ailedger.dev'

// Per-route canonical fix (2026-04-20). index.html ships a static canonical
// pointing at the homepage; GSC flagged every sub-page as "duplicate without
// user-selected canonical" because the SPA serves the same HTML for /docs,
// /guide/*, /contact, /legal — each claiming the homepage is its canonical,
// which instructed Google to de-index everything except /. This runs once per
// full page load and rewrites the canonical + og:url to match the actual
// route before Googlebot's DOM-snapshot pass (modern Googlebot executes JS).
const CANONICAL_BASE = 'https://ailedger.dev'
const CANONICAL_PATHS: Record<string, string> = {
  '/': '/',
  '/docs': '/docs',
  '/guide/annex-iii': '/guide/annex-iii',
  '/contact': '/contact',
  '/legal': '/legal',
  '/terms': '/legal',   // /terms + /privacy collapse to /legal (same component)
  '/privacy': '/legal',
  '/pricing': '/',      // /pricing redirects + scrolls the homepage
}
if (typeof window !== 'undefined') {
  const raw = window.location.pathname
  const canon = CANONICAL_PATHS[raw] ?? raw
  const href = CANONICAL_BASE + canon
  let link = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null
  if (!link) {
    link = document.createElement('link')
    link.rel = 'canonical'
    document.head.appendChild(link)
  }
  link.href = href
  const og = document.querySelector('meta[property="og:url"]') as HTMLMetaElement | null
  if (og) og.content = href
}

// Resolve hero-entry-animation state exactly once per page load (survives strict-mode
// double-render; gated so returning-from-internal-route users don't re-watch the reveal).
const heroAnimClass = ((): string => {
  if (typeof window === 'undefined') return ''
  try {
    if (window.sessionStorage.getItem('hero-played') === '1') return 'no-anim'
    window.sessionStorage.setItem('hero-played', '1')
  } catch { /* sessionStorage unavailable — play the animation */ }
  return ''
})()

function App() {
  const path = window.location.pathname
  if (path === '/legal' || path === '/terms' || path === '/privacy') return <Legal />
  if (path === '/contact') return <Contact />
  if (path === '/guide/annex-iii') return <AnnexIIIGuide />
  if (path === '/docs') return <Docs />
  if (path === '/pricing') {
    history.replaceState(null, '', '/')
    setTimeout(() => document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth' }), 0)
  }
  return (
    <div className="min-h-screen bg-[#0a0b0f] text-slate-300" style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <Nav />
      <Hero />
      <TrustBar />
      <Stats />
      <HowItWorks />
      <Compliance />
      <CodeSnippet />
      <Pricing />
      <FAQ />
      <CTA />
      <Footer />
    </div>
  )
}

function Nav() {
  const [menuOpen, setMenuOpen] = useState(false)

  const handlePricing = (e: React.MouseEvent) => {
    setMenuOpen(false)
    if (window.location.pathname === '/') {
      e.preventDefault()
      document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth' })
    }
  }

  return (
    <nav style={{
      position: 'fixed', top: 0, width: '100%', zIndex: 50,
      borderBottom: '1px solid rgba(255,255,255,0.06)',
      background: 'rgba(10,11,15,0.85)', backdropFilter: 'blur(12px)',
    }}>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 20px', height: 64, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <a href="/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', cursor: 'pointer' }}>
          <img src="/favicon.svg" alt="AILedger" style={{ width: 20, height: 20, marginTop: -1 }} />
          <span style={{ color: '#fff', fontWeight: 600, fontSize: 16, letterSpacing: '-0.3px' }}>AILedger</span>
        </a>

        {/* Desktop nav */}
        <div className="nav-desktop" style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <a href="/pricing" onClick={handlePricing} style={{ color: '#64748b', fontSize: 14, textDecoration: 'none', fontWeight: 500, cursor: 'pointer' }}>Pricing</a>
          <a href="/docs" style={{ color: '#64748b', fontSize: 14, textDecoration: 'none', fontWeight: 500 }}>Docs</a>
          <a href={DASHBOARD_URL} style={{
            padding: '8px 18px', background: '#4f46e5', color: '#fff',
            fontSize: 14, fontWeight: 500, borderRadius: 10, textDecoration: 'none',
          }}>
            Get started
          </a>
        </div>

        {/* Mobile hamburger */}
        <button
          className="nav-mobile"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Toggle menu"
          style={{
            display: 'none',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 8,
            width: 40,
            height: 40,
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <span className="hamburger-line" style={{
            display: 'block', width: 22, height: 2, background: '#e2e8f0', borderRadius: 2,
            transform: menuOpen ? 'translateY(7px) rotate(45deg)' : 'none',
          }} />
          <span className="hamburger-line" style={{
            display: 'block', width: 22, height: 2, background: '#e2e8f0', borderRadius: 2,
            opacity: menuOpen ? 0 : 1,
          }} />
          <span className="hamburger-line" style={{
            display: 'block', width: 22, height: 2, background: '#e2e8f0', borderRadius: 2,
            transform: menuOpen ? 'translateY(-7px) rotate(-45deg)' : 'none',
          }} />
        </button>
      </div>

      {/* Mobile dropdown */}
      <div
        className={`mobile-menu ${menuOpen ? 'open' : 'closed'}`}
        style={{
          position: 'absolute',
          top: 64,
          left: 0,
          right: 0,
          background: 'rgba(10,11,15,0.98)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          padding: '24px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        }}
      >
        <a href="/pricing" onClick={handlePricing} style={{ color: '#e2e8f0', fontSize: 16, textDecoration: 'none', fontWeight: 500 }}>Pricing</a>
        <a href="/docs" onClick={() => setMenuOpen(false)} style={{ color: '#e2e8f0', fontSize: 16, textDecoration: 'none', fontWeight: 500 }}>Docs</a>
        <a href="/legal" onClick={() => setMenuOpen(false)} style={{ color: '#64748b', fontSize: 14, textDecoration: 'none', fontWeight: 500 }}>Legal</a>
        <a href={DASHBOARD_URL} onClick={() => setMenuOpen(false)} style={{
          padding: '12px 18px', background: '#4f46e5', color: '#fff',
          fontSize: 15, fontWeight: 500, borderRadius: 10, textDecoration: 'none',
          textAlign: 'center', marginTop: 4,
        }}>
          Get started
        </a>
      </div>
    </nav>
  )
}

function Hero() {
  // Play the staggered entry once per tab, then skip on re-renders / internal nav.
  // Resolved once at module scope below, so strict-mode double-render doesn't swallow it.
  const anim = heroAnimClass

  return (
    <section className="hero-section" style={{
      textAlign: 'center',
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '64px 32px',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Ambient glow behind hero — quieter, wider spread */}
      <div aria-hidden="true" className="hero-glow" style={{
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 1100, height: 1100,
        background: 'radial-gradient(circle, rgba(99,102,241,0.11) 0%, rgba(99,102,241,0.03) 40%, transparent 72%)',
        pointerEvents: 'none',
        zIndex: 0,
      }} />
      <div style={{ maxWidth: 780, margin: '0 auto', position: 'relative', zIndex: 1 }}>
        <div className={`hero-eyebrow fade-in fade-1 ${anim}`}>
          <span className="hero-eyebrow-dot" aria-hidden="true" />
          EU AI Act enforcement begins August 2, 2026
        </div>
        <h1 className="hero-title" style={{
          fontSize: 72, fontWeight: 700, color: '#fff',
          letterSpacing: '-2px', lineHeight: 1.02, marginBottom: 28,
        }}>
          <span className={`hero-title-line fade-in fade-2a ${anim}`}>You build the AI.</span>
          <br />
          <span className={`hero-title-accent fade-in fade-2b ${anim}`} style={{ color: '#818cf8' }}>We prove it behaved.</span>
        </h1>
        <p className={`hero-subtitle fade-in fade-3 ${anim}`} style={{ fontSize: 19, color: '#94a3b8', lineHeight: 1.65, maxWidth: 620, margin: '0 auto 44px' }}>
          A drop-in proxy for your OpenAI, Anthropic, or Gemini calls. Every inference becomes a tamper-evident audit record — exportable as a one-click PDF for the Article&nbsp;12 audit trail high-risk AI systems must keep.
        </p>
        <div className={`hero-cta-group fade-in fade-4 ${anim}`} style={{ display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
          <a className="hero-cta-primary" href={DASHBOARD_URL} style={{
            padding: '14px 28px', background: '#4f46e5', color: '#fff',
            fontWeight: 600, fontSize: 15, borderRadius: 12, textDecoration: 'none',
            letterSpacing: '-0.005em',
          }}>
            Start for free
          </a>
          <a className="hero-cta-secondary" href="#how-it-works" style={{
            padding: '14px 28px', color: '#94a3b8', fontSize: 15,
            textDecoration: 'none', borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.08)',
          }}>
            How it works →
          </a>
        </div>
      </div>
    </section>
  )
}

function TrustBar() {
  const items = [
    {
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      ),
      label: 'GDPR Compatible',
    },
    {
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      ),
      label: 'EU AI Act Article\u00a012',
    },
    {
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      ),
      label: 'No PII stored',
    },
    {
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
      ),
      label: 'SHA-256 hashed',
    },
    {
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      ),
      label: 'Append-only records',
    },
    {
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          <path d="M2 12h20" />
        </svg>
      ),
      label: 'EU data residency',
    },
  ]

  return (
    <div className="trust-bar" style={{
      borderTop: '1px solid rgba(255,255,255,0.05)',
      borderBottom: '1px solid rgba(255,255,255,0.05)',
      padding: '18px 32px',
    }}>
      <div style={{
        maxWidth: 1100, margin: '0 auto',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexWrap: 'wrap', gap: '28px 40px',
      }}>
        {items.map((item) => (
          <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#475569' }}>
            <span style={{ color: '#4f46e5', display: 'flex', alignItems: 'center' }}>{item.icon}</span>
            <span style={{ fontSize: 13, fontWeight: 500, letterSpacing: '0.01em', whiteSpace: 'nowrap' }}>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Stats() {
  const stats = [
    { value: '70%', label: 'of companies using AI in the EU have taken zero compliance steps' },
    { value: '€35M', label: 'maximum penalty for high-risk AI Act violations' },
    { value: 'Aug 2026', label: 'full enforcement deadline for Annex III high-risk AI systems' },
  ]
  return (
    <section className="section-pad" style={{
      borderTop: '1px solid rgba(255,255,255,0.06)',
      borderBottom: '1px solid rgba(255,255,255,0.06)',
      background: 'rgba(255,255,255,0.015)',
      padding: '72px 32px',
    }}>
      <div className="three-col-grid" style={{ maxWidth: 1100, margin: '0 auto', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 40, textAlign: 'center' }}>
        {stats.map((s) => (
          <div key={s.value}>
            <div style={{ fontSize: 48, fontWeight: 700, color: '#fff', letterSpacing: '-1.5px', marginBottom: 12 }}>{s.value}</div>
            <div style={{ fontSize: 15, color: '#64748b', lineHeight: 1.6 }}>{s.label}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

function HowItWorks() {
  const steps = [
    {
      n: '01',
      title: 'Point your API calls at AILedger',
      body: 'Set your base URL to our proxy and pass your AILedger key as a header. Your existing code stays intact. Logging happens asynchronously with minimal overhead.',
    },
    {
      n: '02',
      title: 'Every inference is logged',
      body: 'Inputs and outputs are SHA-256 hashed and stored as append-only records. No personal data retained. Fully GDPR compatible.',
    },
    {
      n: '03',
      title: 'Export your compliance report',
      body: 'One click generates a formatted EU AI Act Article 12 audit report with full inference history, ready for regulators.',
    },
  ]
  return (
    <section id="how-it-works" className="section-pad" style={{ padding: '100px 32px' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 64 }}>
          <h2 className="section-title" style={{ fontSize: 40, fontWeight: 700, color: '#fff', letterSpacing: '-1px', marginBottom: 16 }}>Drop-in. Audit-ready.</h2>
          <p style={{ fontSize: 17, color: '#64748b', maxWidth: 480, margin: '0 auto' }}>
            AILedger sits transparently between your app and your AI provider.
          </p>
        </div>
        <div className="three-col-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
          {steps.map((s) => (
            <div key={s.n} style={{
              padding: '32px 28px', borderRadius: 16,
              border: '1px solid rgba(255,255,255,0.07)',
              background: 'rgba(255,255,255,0.02)',
            }}>
              <div style={{ fontSize: 12, fontFamily: 'monospace', color: '#818cf8', fontWeight: 600, marginBottom: 20, letterSpacing: 1 }}>{s.n}</div>
              <h3 style={{ fontSize: 17, fontWeight: 600, color: '#f1f5f9', marginBottom: 12, lineHeight: 1.4 }}>{s.title}</h3>
              <p style={{ fontSize: 14, color: '#64748b', lineHeight: 1.75 }}>{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function Compliance() {
  const items = [
    { label: 'EU AI Act Article 12', desc: 'Automatic event logging for high-risk AI systems' },
    { label: 'GDPR compatible', desc: 'Hashed inputs/outputs - no personal data stored' },
    { label: 'Immutable records', desc: 'Append-only - records cannot be modified or deleted' },
    { label: 'Tamper-evident', desc: 'SHA-256 cryptographic hashing on every inference' },
    { label: 'Audit reports', desc: 'One-click PDF export formatted for regulators' },
    { label: 'Real-time dashboard', desc: 'Live view of all inference activity per customer' },
    { label: 'Multiple AI systems', desc: 'Track and report across multiple AI systems - available on Pro and Scale' },
  ]
  return (
    <section className="section-pad" style={{
      padding: '100px 32px',
      borderTop: '1px solid rgba(255,255,255,0.06)',
      borderBottom: '1px solid rgba(255,255,255,0.06)',
      background: 'rgba(255,255,255,0.015)',
    }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 64 }}>
          <h2 className="section-title" style={{ fontSize: 40, fontWeight: 700, color: '#fff', letterSpacing: '-1px', marginBottom: 16 }}>Built for compliance from the ground up</h2>
          <p style={{ fontSize: 17, color: '#64748b', maxWidth: 480, margin: '0 auto' }}>
            Not just a dashboard - infrastructure designed specifically to satisfy regulators.
          </p>
        </div>
        <div className="three-col-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          {items.map((item) => (
            <div key={item.label} style={{
              display: 'flex', gap: 14, padding: '22px 20px',
              borderRadius: 12, border: '1px solid rgba(255,255,255,0.07)',
              background: 'rgba(255,255,255,0.02)',
            }}>
              <div style={{
                marginTop: 2, width: 18, height: 18, borderRadius: '50%',
                background: 'rgba(52,211,153,0.15)', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#34d399' }} />
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#f1f5f9', marginBottom: 4 }}>{item.label}</div>
                <div style={{ fontSize: 13, color: '#64748b', lineHeight: 1.6 }}>{item.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function CodeSnippet() {
  return (
    <section className="section-pad" style={{ padding: '100px 32px' }}>
      <div style={{ maxWidth: 680, margin: '0 auto', textAlign: 'center' }}>
        <h2 className="section-title" style={{ fontSize: 40, fontWeight: 700, color: '#fff', letterSpacing: '-1px', marginBottom: 16 }}>Integration in 60 seconds</h2>
        <p style={{ fontSize: 17, color: '#64748b', marginBottom: 44 }}>Works with OpenAI, Anthropic, Gemini, and any OpenAI-compatible API.</p>
        <div style={{
          textAlign: 'left', borderRadius: 16,
          border: '1px solid rgba(255,255,255,0.1)',
          background: '#0d1017', overflow: 'hidden',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '12px 18px', borderBottom: '1px solid rgba(255,255,255,0.06)',
          }}>
            {['#ef4444','#f59e0b','#22c55e'].map((c) => (
              <div key={c} style={{ width: 12, height: 12, borderRadius: '50%', background: c, opacity: 0.6 }} />
            ))}
            <span style={{ fontSize: 12, color: '#475569', marginLeft: 8, fontFamily: 'monospace' }}>your_app.py</span>
          </div>
          <pre style={{ padding: '28px 24px', fontSize: 13.5, lineHeight: 2, overflowX: 'auto', margin: 0 }}>
            <code style={{ fontFamily: 'ui-monospace, monospace' }}>
              <span style={{ color: '#475569' }}># Before{'\n'}</span>
              <span style={{ color: '#93c5fd' }}>client</span>
              <span style={{ color: '#e2e8f0' }}> = </span>
              <span style={{ color: '#fcd34d' }}>OpenAI</span>
              <span style={{ color: '#e2e8f0' }}>(api_key=</span>
              <span style={{ color: '#86efac' }}>"your-key"</span>
              <span style={{ color: '#e2e8f0' }}>){'\n\n'}</span>
              <span style={{ color: '#475569' }}># After - drop-in, fully logged{'\n'}</span>
              <span style={{ color: '#93c5fd' }}>client</span>
              <span style={{ color: '#e2e8f0' }}> = </span>
              <span style={{ color: '#fcd34d' }}>OpenAI</span>
              <span style={{ color: '#e2e8f0' }}>({'\n'}{'  '}api_key=</span>
              <span style={{ color: '#86efac' }}>"your-key"</span>
              <span style={{ color: '#e2e8f0' }}>,{'\n'}{'  '}base_url=</span>
              <span style={{ color: '#86efac' }}>"{PROXY_URL}/proxy/openai"</span>
              <span style={{ color: '#e2e8f0' }}>,{'\n'}{'  '}default_headers=</span>
              <span style={{ color: '#e2e8f0' }}>{'{'}  </span>
              <span style={{ color: '#86efac' }}>"x-ailedger-key"</span>
              <span style={{ color: '#e2e8f0' }}>: </span>
              <span style={{ color: '#86efac' }}>"agl_sk_..."</span>
              <span style={{ color: '#e2e8f0' }}> {'}'}{'\n)' }</span>
            </code>
          </pre>
        </div>
      </div>
    </section>
  )
}

function Pricing() {
  const plans = [
    {
      name: 'Free',
      price: '$0',
      sub: 'forever',
      description: 'Get started with no commitment. Free forever.',
      features: [
        '10,000 inferences / month',
        '1 API key',
        'Real-time inference dashboard',
        'SHA-256 tamper-evident logs',
        'EU data residency (Frankfurt)',
      ],
      cta: 'Start for free',
      href: DASHBOARD_URL,
      highlight: false,
    },
    {
      name: 'Pro',
      price: '$149',
      sub: '/ month',
      description: 'For teams shipping AI in production.',
      features: [
        '500,000 inferences / month',
        '5 API keys',
        'PDF compliance reports',
        'Multiple AI systems',
        'EU data residency (Frankfurt)',
        'Priority email support',
      ],
      cta: 'Upgrade to Pro',
      href: DASHBOARD_URL,
      highlight: true,
    },
    {
      name: 'Scale',
      price: '$499',
      sub: '/ month',
      description: 'For high-volume and regulated workloads.',
      features: [
        'Unlimited inferences',
        'Unlimited API keys',
        'Unlimited AI systems',
        'EU data residency (Frankfurt)',
        'Priority support',
        'SLA available',
      ],
      cta: 'Upgrade to Scale',
      href: DASHBOARD_URL,
      highlight: false,
    },
  ]

  return (
    <section id="pricing" className="section-pad" style={{ padding: '100px 32px', borderTop: '1px solid rgba(255,255,255,0.06)', scrollMarginTop: '120px' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 64 }}>
          <h2 className="section-title" style={{ fontSize: 40, fontWeight: 700, color: '#fff', letterSpacing: '-1px', marginBottom: 16 }}>
            Simple, transparent pricing
          </h2>
          <p style={{ fontSize: 17, color: '#64748b', maxWidth: 440, margin: '0 auto' }}>
            Start free. Upgrade when you need more inferences or compliance reports.
          </p>
        </div>
        <div className="three-col-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, alignItems: 'stretch' }}>
          {plans.map((plan) => (
            <div key={plan.name} style={{
              borderRadius: 16,
              border: plan.highlight ? '1px solid rgba(99,102,241,0.5)' : '1px solid rgba(255,255,255,0.07)',
              background: plan.highlight ? 'rgba(99,102,241,0.07)' : 'rgba(255,255,255,0.02)',
              padding: '32px 28px',
              position: 'relative',
              display: 'flex', flexDirection: 'column',
            }}>
              {plan.highlight && (
                <div style={{
                  position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)',
                  background: '#4f46e5', color: '#fff', fontSize: 11, fontWeight: 600,
                  padding: '4px 12px', borderRadius: 999, letterSpacing: '0.05em', whiteSpace: 'nowrap',
                }}>
                  MOST POPULAR
                </div>
              )}
              <div style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: plan.highlight ? '#818cf8' : '#64748b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 16 }}>
                  {plan.name}
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 8 }}>
                  <span style={{ fontSize: 40, fontWeight: 700, color: '#fff', letterSpacing: '-1px' }}>{plan.price}</span>
                  <span style={{ fontSize: 14, color: '#64748b' }}>{plan.sub}</span>
                </div>
                <p style={{ fontSize: 13, color: '#64748b', lineHeight: 1.6 }}>{plan.description}</p>
              </div>
              <a href={plan.href} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '11px 20px', borderRadius: 10, marginBottom: 28,
                fontSize: 14, fontWeight: 600, textDecoration: 'none',
                background: plan.highlight ? '#4f46e5' : 'rgba(255,255,255,0.06)',
                color: plan.highlight ? '#fff' : '#e2e8f0',
                border: plan.highlight ? 'none' : plan.name === 'Scale' ? '1px solid rgba(255,255,255,0.2)' : 'none',
              }}>
                {plan.cta}
              </a>
              <div style={{ flex: 1 }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {plan.features.map((f) => (
                  <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                      width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                      background: 'rgba(52,211,153,0.15)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#34d399' }} />
                    </div>
                    <span style={{ fontSize: 13, color: '#94a3b8' }}>{f}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p style={{ textAlign: 'center', marginTop: 32, fontSize: 13, color: '#475569' }}>
          Annual plans: pay for 10 months, get 12 (save ~17%). Contact us for enterprise pricing.
        </p>
      </div>
    </section>
  )
}

function FAQ() {
  const items = [
    {
      q: 'What is the EU AI Act Article 12?',
      a: 'Article 12 of the EU AI Act (Regulation 2024/1689) requires operators of high-risk AI systems to maintain automatic logging of events throughout the system\'s lifetime. These logs must be tamper-evident and sufficient to enable post-hoc auditing. AILedger is purpose-built to give you the audit trail Article 12 calls for.',
    },
    {
      q: 'Does AILedger store my prompts or AI outputs?',
      a: 'No. AILedger never stores raw inputs or outputs. It stores only SHA-256 cryptographic hashes - one-way fingerprints that prove a specific exchange occurred without retaining any content. This makes AILedger fully GDPR compatible.',
    },
    {
      q: 'How long does integration take?',
      a: 'For OpenAI, Anthropic, Gemini, or any OpenAI-compatible API, integration means pointing your client at our proxy and adding our API key as a header. Most teams are logging within 60 seconds of creating an account.',
    },
    {
      q: 'Does AILedger add latency to my AI calls?',
      a: 'Logging is fully asynchronous - the database write happens after your response is returned. The proxy hop through Cloudflare\'s global edge network adds minimal overhead (typically 150-300ms, well within normal LLM inference variance).',
    },
    {
      q: 'Which AI providers are supported?',
      a: 'OpenAI, Anthropic, and Google Gemini are natively supported. Any API that follows the OpenAI-compatible format also works without any additional configuration.',
    },
    {
      q: 'Is AILedger sufficient for EU AI Act compliance on its own?',
      a: 'No — and no single tool is. AILedger provides the logging and record-keeping infrastructure that Article 12 requires. Full EU AI Act compliance for high-risk systems also involves conformity assessments, transparency obligations, and human oversight measures that AILedger does not provide. AILedger handles the audit trail piece — the part regulators will ask for first.',
    },
    {
      q: 'Where is data stored?',
      a: 'All data is stored in the EU, namely AWS eu-central-1 (Frankfurt, Germany) via Supabase. This applies to all plans, free and paid. No data ever leaves the EU.',
    },
  ]

  return (
    <section className="section-pad" style={{
      padding: '100px 32px',
      borderTop: '1px solid rgba(255,255,255,0.06)',
    }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 56 }}>
          <h2 style={{ fontSize: 36, fontWeight: 700, color: '#fff', letterSpacing: '-0.75px', marginBottom: 12 }}>
            Frequently asked questions
          </h2>
          <p style={{ fontSize: 16, color: '#64748b' }}>
            Everything you need to know before integrating.
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {items.map((item) => (
            <details key={item.q} style={{
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.07)',
              background: 'rgba(255,255,255,0.02)',
              overflow: 'hidden',
            }}>
              <summary style={{
                padding: '18px 22px',
                fontSize: 15,
                fontWeight: 500,
                color: '#f1f5f9',
                cursor: 'pointer',
                listStyle: 'none',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 16,
              }}>
                {item.q}
                <span style={{ color: '#475569', fontSize: 18, flexShrink: 0, lineHeight: 1 }}>+</span>
              </summary>
              <div style={{
                padding: '0 22px 18px',
                fontSize: 14,
                color: '#64748b',
                lineHeight: 1.8,
              }}>
                {item.a}
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}

function CTA() {
  return (
    <section className="section-pad" style={{
      padding: '100px 32px', textAlign: 'center',
      borderTop: '1px solid rgba(255,255,255,0.06)',
    }}>
      <div style={{ maxWidth: 520, margin: '0 auto' }}>
        <h2 className="section-title" style={{ fontSize: 40, fontWeight: 700, color: '#fff', letterSpacing: '-1px', marginBottom: 16 }}>
          Start logging before the deadline.
        </h2>
        <p style={{ fontSize: 17, color: '#64748b', marginBottom: 40, lineHeight: 1.7 }}>
          Free to start. No credit card. Takes 60 seconds to integrate.
        </p>
        <a href={DASHBOARD_URL} style={{
          display: 'inline-block', padding: '16px 36px',
          background: '#4f46e5', color: '#fff',
          fontWeight: 600, fontSize: 16, borderRadius: 12, textDecoration: 'none',
        }}>
          Create free account
        </a>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer style={{
      borderTop: '1px solid rgba(255,255,255,0.06)',
      padding: '28px 32px',
    }}>
      <div className="footer-row" style={{ maxWidth: 1100, margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: '#334155', fontSize: 14 }}>AILedger</span>
        <div className="footer-links" style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
          <a href="/legal" style={{ color: '#334155', fontSize: 14, textDecoration: 'none' }}>Legal</a>
          <a href="/contact" style={{ color: '#334155', fontSize: 14, textDecoration: 'none' }}>Contact</a>
          <span className="footer-tagline" style={{ color: '#334155', fontSize: 14 }}>Built for EU AI Act compliance</span>
        </div>
      </div>
    </footer>
  )
}

function CodeBlock({ filename, raw, children }: { filename: string; raw: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  return (
    <div style={{ borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)', background: '#0d1017', overflow: 'hidden', marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        {['#ef4444','#f59e0b','#22c55e'].map((col) => (
          <div key={col} style={{ width: 10, height: 10, borderRadius: '50%', background: col, opacity: 0.5 }} />
        ))}
        <span style={{ fontSize: 12, color: '#475569', marginLeft: 6, fontFamily: 'monospace', flex: 1 }}>{filename}</span>
        <button
          onClick={() => { navigator.clipboard.writeText(raw); setCopied(true); setTimeout(() => setCopied(false), 1800) }}
          style={{ cursor: 'pointer', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, padding: '3px 10px', fontSize: 11, color: copied ? '#86efac' : '#64748b', transition: 'color 0.15s' }}
        >{copied ? '✓' : '📋'}</button>
      </div>
      <pre style={{ padding: '22px 22px', fontSize: 13, lineHeight: 1.9, overflowX: 'auto', margin: 0 }}>
        <code style={{ fontFamily: 'ui-monospace, monospace' }}>{children}</code>
      </pre>
    </div>
  )
}

function Docs() {
  const sections = [
    { id: 'quickstart', label: 'Quick start' },
    { id: 'openai', label: 'OpenAI' },
    { id: 'anthropic', label: 'Anthropic' },
    { id: 'gemini', label: 'Gemini' },
    { id: 'test', label: 'Test your keys' },
    { id: 'reference', label: 'API reference' },
  ]

  const codeBlock = (filename: string, raw: string, children: React.ReactNode) => (
    <CodeBlock filename={filename} raw={raw}>{children}</CodeBlock>
  )

  const c = {
    comment: '#475569',
    name: '#93c5fd',
    fn: '#fcd34d',
    str: '#86efac',
    plain: '#e2e8f0',
    kw: '#c084fc',
  }

  const s = (color: string, text: string) => <span style={{ color }}>{text}</span>

  return (
    <div style={{ minHeight: '100vh', background: '#0a0b0f', color: '#e2e8f0', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <Nav />

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '100px 32px 80px', display: 'flex', gap: 64 }}>

        {/* Sidebar */}
        <aside style={{ width: 180, flexShrink: 0 }}>
          <div style={{ position: 'sticky', top: 96 }}>
            <p style={{ fontSize: 11, fontWeight: 600, color: '#475569', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 16 }}>On this page</p>
            <nav style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {sections.map((s) => (
                <a key={s.id} href={`#${s.id}`} style={{ fontSize: 14, color: '#64748b', textDecoration: 'none', padding: '4px 0', transition: 'color 0.15s' }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#e2e8f0')}
                  onMouseLeave={e => (e.currentTarget.style.color = '#64748b')}
                >{s.label}</a>
              ))}
            </nav>
          </div>
        </aside>

        {/* Content */}
        <main style={{ flex: 1, minWidth: 0 }}>

          <h1 style={{ fontSize: 36, fontWeight: 700, color: '#fff', letterSpacing: '-0.5px', marginBottom: 8 }}>Documentation</h1>
          <p style={{ fontSize: 16, color: '#64748b', marginBottom: 64, lineHeight: 1.7 }}>Everything you need to integrate AILedger and start logging AI inferences.</p>

          {/* Quick start */}
          <section id="quickstart" style={{ scrollMarginTop: '96px', marginBottom: 64 }}>
            <h2 style={{ fontSize: 22, fontWeight: 600, color: '#fff', marginBottom: 8 }}>Quick start</h2>
            <p style={{ fontSize: 14, color: '#64748b', lineHeight: 1.8, marginBottom: 16 }}>
              Two steps: create an API key in the <a href={DASHBOARD_URL} style={{ color: '#818cf8', textDecoration: 'none' }}>dashboard</a>, then add it to your existing AI client.
            </p>
            <ol style={{ fontSize: 14, color: '#94a3b8', lineHeight: 2, paddingLeft: 20 }}>
              <li>Sign up at <a href={DASHBOARD_URL} style={{ color: '#818cf8', textDecoration: 'none' }}>dash.ailedger.dev</a></li>
              <li>Go to <strong style={{ color: '#e2e8f0' }}>API Keys</strong> and create a key</li>
              <li>Set <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 6px', borderRadius: 4, fontSize: 12 }}>base_url</code> and pass your key in <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 6px', borderRadius: 4, fontSize: 12 }}>x-ailedger-key</code></li>
              <li>Every inference is now logged automatically</li>
            </ol>
          </section>

          {/* OpenAI */}
          <section id="openai" style={{ scrollMarginTop: '96px', marginBottom: 64 }}>
            <h2 style={{ fontSize: 22, fontWeight: 600, color: '#fff', marginBottom: 8 }}>OpenAI</h2>
            <p style={{ fontSize: 14, color: '#64748b', lineHeight: 1.8, marginBottom: 4 }}>Install: <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 6px', borderRadius: 4, fontSize: 12 }}>pip install openai</code></p>
            {codeBlock('openai_example.py', `from openai import OpenAI\n\nclient = OpenAI(\n  api_key="your-openai-key",\n  base_url="${PROXY_URL}/proxy/openai",\n  default_headers={"x-ailedger-key": "alg_sk_..."}\n)\n\ncompletion = client.chat.completions.create(\n  model="gpt-4.1-mini",\n  messages=[{"role": "user", "content": "Hello!"}]\n)\nprint(completion.choices[0].message.content)\n`, <>
              {s(c.kw, 'from')}{s(c.plain, ' openai ')}{s(c.kw, 'import')}{s(c.plain, ' OpenAI\n\n')}
              {s(c.name, 'client')}{s(c.plain, ' = ')}{s(c.fn, 'OpenAI')}{s(c.plain, '(\n')}
              {s(c.plain, '  api_key=')}{s(c.str, '"your-openai-key"')}{s(c.plain, ',\n')}
              {s(c.plain, '  base_url=')}{s(c.str, `"${PROXY_URL}/proxy/openai"`)}{s(c.plain, ',\n')}
              {s(c.plain, '  default_headers={')} {s(c.str, '"x-ailedger-key"')}{s(c.plain, ': ')}{s(c.str, '"alg_sk_..."')}{s(c.plain, ' }\n)\n\n')}
              {s(c.name, 'completion')}{s(c.plain, ' = client.chat.completions.')}{s(c.fn, 'create')}{s(c.plain, '(\n')}
              {s(c.plain, '  model=')}{s(c.str, '"gpt-4.1-mini"')}{s(c.plain, ',\n')}
              {s(c.plain, '  messages=[{')}{s(c.str, '"role"')}{s(c.plain, ': ')}{s(c.str, '"user"')}{s(c.plain, ', ')}{s(c.str, '"content"')}{s(c.plain, ': ')}{s(c.str, '"Hello!"')}{s(c.plain, '}]\n)\n')}
              {s(c.fn, 'print')}{s(c.plain, '(completion.choices[')}{s(c.str, '0')}{s(c.plain, '].message.content)\n')}
            </>)}
          </section>

          {/* Anthropic */}
          <section id="anthropic" style={{ scrollMarginTop: '96px', marginBottom: 64 }}>
            <h2 style={{ fontSize: 22, fontWeight: 600, color: '#fff', marginBottom: 8 }}>Anthropic</h2>
            <p style={{ fontSize: 14, color: '#64748b', lineHeight: 1.8, marginBottom: 4 }}>Install: <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 6px', borderRadius: 4, fontSize: 12 }}>pip install anthropic</code></p>
            {codeBlock('anthropic_example.py', `from anthropic import Anthropic\n\nclient = Anthropic(\n  api_key="your-anthropic-key",\n  base_url="${PROXY_URL}/proxy/anthropic",\n  default_headers={"x-ailedger-key": "alg_sk_..."}\n)\n\nmessage = client.messages.create(\n  model="claude-opus-4-6",\n  max_tokens=1024,\n  messages=[{"role": "user", "content": "Hello, Claude"}]\n)\nprint(message.content)\n`, <>
              {s(c.kw, 'from')}{s(c.plain, ' anthropic ')}{s(c.kw, 'import')}{s(c.plain, ' Anthropic\n\n')}
              {s(c.name, 'client')}{s(c.plain, ' = ')}{s(c.fn, 'Anthropic')}{s(c.plain, '(\n')}
              {s(c.plain, '  api_key=')}{s(c.str, '"your-anthropic-key"')}{s(c.plain, ',\n')}
              {s(c.plain, '  base_url=')}{s(c.str, `"${PROXY_URL}/proxy/anthropic"`)}{s(c.plain, ',\n')}
              {s(c.plain, '  default_headers={')} {s(c.str, '"x-ailedger-key"')}{s(c.plain, ': ')}{s(c.str, '"alg_sk_..."')}{s(c.plain, ' }\n)\n\n')}
              {s(c.name, 'message')}{s(c.plain, ' = client.messages.')}{s(c.fn, 'create')}{s(c.plain, '(\n')}
              {s(c.plain, '  model=')}{s(c.str, '"claude-opus-4-6"')}{s(c.plain, ',\n')}
              {s(c.plain, '  max_tokens=')}{s(c.str, '1024')}{s(c.plain, ',\n')}
              {s(c.plain, '  messages=[{')}{s(c.str, '"role"')}{s(c.plain, ': ')}{s(c.str, '"user"')}{s(c.plain, ', ')}{s(c.str, '"content"')}{s(c.plain, ': ')}{s(c.str, '"Hello, Claude"')}{s(c.plain, '}]\n)\n')}
              {s(c.fn, 'print')}{s(c.plain, '(message.content)\n')}
            </>)}
          </section>

          {/* Gemini */}
          <section id="gemini" style={{ scrollMarginTop: '96px', marginBottom: 64 }}>
            <h2 style={{ fontSize: 22, fontWeight: 600, color: '#fff', marginBottom: 8 }}>Gemini</h2>
            <p style={{ fontSize: 14, color: '#64748b', lineHeight: 1.8, marginBottom: 4 }}>Install: <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 6px', borderRadius: 4, fontSize: 12 }}>pip install google-genai</code></p>
            {codeBlock('gemini_example.py', `from google import genai\n\nclient = genai.Client(\n  api_key="your-gemini-key",\n  http_options={\n    "base_url": "${PROXY_URL}/proxy/gemini",\n    "headers": {"x-ailedger-key": "alg_sk_..."},\n  }\n)\n\nresponse = client.models.generate_content(\n  model="gemini-2.5-flash",\n  contents="Explain how AI works in a few words"\n)\nprint(response.text)\n`, <>
              {s(c.kw, 'from')}{s(c.plain, ' google ')}{s(c.kw, 'import')}{s(c.plain, ' genai\n\n')}
              {s(c.name, 'client')}{s(c.plain, ' = genai.')}{s(c.fn, 'Client')}{s(c.plain, '(\n')}
              {s(c.plain, '  api_key=')}{s(c.str, '"your-gemini-key"')}{s(c.plain, ',\n')}
              {s(c.plain, '  http_options={\n')}
              {s(c.plain, '    ')}{s(c.str, '"base_url"')}{s(c.plain, ': ')}{s(c.str, `"${PROXY_URL}/proxy/gemini"`)}{s(c.plain, ',\n')}
              {s(c.plain, '    ')}{s(c.str, '"headers"')}{s(c.plain, ': {')}{s(c.str, '"x-ailedger-key"')}{s(c.plain, ': ')}{s(c.str, '"alg_sk_..."')}{s(c.plain, '},\n')}
              {s(c.plain, '  }\n)\n\n')}
              {s(c.name, 'response')}{s(c.plain, ' = client.models.')}{s(c.fn, 'generate_content')}{s(c.plain, '(\n')}
              {s(c.plain, '  model=')}{s(c.str, '"gemini-2.5-flash"')}{s(c.plain, ',\n')}
              {s(c.plain, '  contents=')}{s(c.str, '"Explain how AI works in a few words"')}{s(c.plain, '\n)\n')}
              {s(c.fn, 'print')}{s(c.plain, '(response.text)\n')}
            </>)}
          </section>

          {/* Test your keys */}
          <section id="test" style={{ scrollMarginTop: '96px', marginBottom: 64 }}>
            <h2 style={{ fontSize: 22, fontWeight: 600, color: '#fff', marginBottom: 8 }}>Test your keys</h2>
            <p style={{ fontSize: 14, color: '#64748b', lineHeight: 1.8, marginBottom: 16 }}>
              Run this script to verify all three providers are routing through AILedger correctly.
            </p>
            {codeBlock('test_proxy.py', `import time\nfrom openai import OpenAI\nfrom anthropic import Anthropic\nfrom google import genai\n\nAILEDGER_KEY  = "alg_sk_..."\nOPENAI_KEY    = "sk-..."\nANTHROPIC_KEY = "sk-ant-..."\nGEMINI_KEY    = "AIza..."\n\nRUNS = 3\ndef avg(times): return sum(times) / len(times)\n\n# OpenAI\ndirect = OpenAI(api_key=OPENAI_KEY)\nproxy  = OpenAI(\n  api_key=OPENAI_KEY,\n  base_url="${PROXY_URL}/proxy/openai",\n  default_headers={"x-ailedger-key": AILEDGER_KEY},\n)\ndirect_times, proxy_times = [], []\nfor _ in range(RUNS):\n  t0 = time.perf_counter()\n  direct.chat.completions.create(model="gpt-4.1-mini", messages=[{"role": "user", "content": "Say: ok"}], max_tokens=5)\n  direct_times.append((time.perf_counter() - t0) * 1000)\n  t0 = time.perf_counter()\n  r = proxy.chat.completions.create(model="gpt-4.1-mini", messages=[{"role": "user", "content": "Say: ok"}], max_tokens=5)\n  proxy_times.append((time.perf_counter() - t0) * 1000)\nif r.choices and r.choices[0].message.content:\n  d, p = avg(direct_times), avg(proxy_times)\n  print(f"✓ [OpenAI]    '{r.choices[0].message.content.strip()}'")\n  print(f"  avg over {RUNS} runs - direct={d:.0f}ms  proxy={p:.0f}ms  overhead={p - d:+.0f}ms")\n\n# Anthropic\ndirect = Anthropic(api_key=ANTHROPIC_KEY)\nproxy  = Anthropic(\n  api_key=ANTHROPIC_KEY,\n  base_url="${PROXY_URL}/proxy/anthropic",\n  default_headers={"x-ailedger-key": AILEDGER_KEY},\n)\ndirect_times, proxy_times = [], []\nfor _ in range(RUNS):\n  t0 = time.perf_counter()\n  direct.messages.create(model="claude-opus-4-6", max_tokens=5, messages=[{"role": "user", "content": "Say: ok"}])\n  direct_times.append((time.perf_counter() - t0) * 1000)\n  t0 = time.perf_counter()\n  r = proxy.messages.create(model="claude-opus-4-6", max_tokens=5, messages=[{"role": "user", "content": "Say: ok"}])\n  proxy_times.append((time.perf_counter() - t0) * 1000)\nif r.content and r.content[0].text:\n  d, p = avg(direct_times), avg(proxy_times)\n  print(f"✓ [Anthropic] '{r.content[0].text.strip()}'")\n  print(f"  avg over {RUNS} runs - direct={d:.0f}ms  proxy={p:.0f}ms  overhead={p - d:+.0f}ms")\n\n# Gemini\ndirect = genai.Client(api_key=GEMINI_KEY)\nproxy  = genai.Client(\n  api_key=GEMINI_KEY,\n  http_options={\n    "base_url": "${PROXY_URL}/proxy/gemini",\n    "headers": {"x-ailedger-key": AILEDGER_KEY},\n  },\n)\ndirect_times, proxy_times = [], []\nfor _ in range(RUNS):\n  t0 = time.perf_counter()\n  direct.models.generate_content(model="gemini-2.5-flash", contents="Say: ok")\n  direct_times.append((time.perf_counter() - t0) * 1000)\n  t0 = time.perf_counter()\n  r = proxy.models.generate_content(model="gemini-2.5-flash", contents="Say: ok")\n  proxy_times.append((time.perf_counter() - t0) * 1000)\nif r.text:\n  d, p = avg(direct_times), avg(proxy_times)\n  print(f"✓ [Gemini]    '{r.text.strip()}'")\n  print(f"  avg over {RUNS} runs - direct={d:.0f}ms  proxy={p:.0f}ms  overhead={p - d:+.0f}ms")\n`, <>
              {s(c.kw, 'import')}{s(c.plain, ' time\n')}
              {s(c.kw, 'from')}{s(c.plain, ' openai ')}{s(c.kw, 'import')}{s(c.plain, ' OpenAI\n')}
              {s(c.kw, 'from')}{s(c.plain, ' anthropic ')}{s(c.kw, 'import')}{s(c.plain, ' Anthropic\n')}
              {s(c.kw, 'from')}{s(c.plain, ' google ')}{s(c.kw, 'import')}{s(c.plain, ' genai\n\n')}
              {s(c.name, 'AILEDGER_KEY')}{s(c.plain, '  = ')}{s(c.str, '"alg_sk_..."')}{s(c.plain, '\n')}
              {s(c.name, 'OPENAI_KEY')}{s(c.plain, '    = ')}{s(c.str, '"sk-..."')}{s(c.plain, '\n')}
              {s(c.name, 'ANTHROPIC_KEY')}{s(c.plain, ' = ')}{s(c.str, '"sk-ant-..."')}{s(c.plain, '\n')}
              {s(c.name, 'GEMINI_KEY')}{s(c.plain, '    = ')}{s(c.str, '"AIza..."')}{s(c.plain, '\n\n')}
              {s(c.name, 'RUNS')}{s(c.plain, ' = ')}{s(c.str, '3')}{s(c.plain, '\n')}
              {s(c.kw, 'def')}{s(c.plain, ' ')}{s(c.fn, 'avg')}{s(c.plain, '(times): ')}{s(c.kw, 'return')}{s(c.plain, ' ')}{s(c.fn, 'sum')}{s(c.plain, '(times) / ')}{s(c.fn, 'len')}{s(c.plain, '(times)\n\n')}
              {s(c.comment, '# OpenAI\n')}
              {s(c.name, 'direct')}{s(c.plain, ' = ')}{s(c.fn, 'OpenAI')}{s(c.plain, '(api_key=')}{s(c.name, 'OPENAI_KEY')}{s(c.plain, ')\n')}
              {s(c.name, 'proxy')}{s(c.plain, '  = ')}{s(c.fn, 'OpenAI')}{s(c.plain, '(\n')}
              {s(c.plain, '  api_key=')}{s(c.name, 'OPENAI_KEY')}{s(c.plain, ', base_url=')}{s(c.str, `"${PROXY_URL}/proxy/openai"`)}{s(c.plain, ',\n')}
              {s(c.plain, '  default_headers={')} {s(c.str, '"x-ailedger-key"')}{s(c.plain, ': ')}{s(c.name, 'AILEDGER_KEY')}{s(c.plain, '}\n)\n')}
              {s(c.name, 'direct_times')}{s(c.plain, ', ')}{s(c.name, 'proxy_times')}{s(c.plain, ' = [], []\n')}
              {s(c.kw, 'for')}{s(c.plain, ' _ ')}{s(c.kw, 'in')}{s(c.plain, ' ')}{s(c.fn, 'range')}{s(c.plain, '(')}{s(c.name, 'RUNS')}{s(c.plain, '):\n')}
              {s(c.plain, '  t0 = time.')}{s(c.fn, 'perf_counter')}{s(c.plain, '()\n')}
              {s(c.plain, '  direct.chat.completions.')}{s(c.fn, 'create')}{s(c.plain, '(model=')}{s(c.str, '"gpt-4.1-mini"')}{s(c.plain, ', messages=[{')}{s(c.str, '"role"')}{s(c.plain, ': ')}{s(c.str, '"user"')}{s(c.plain, ', ')}{s(c.str, '"content"')}{s(c.plain, ': ')}{s(c.str, '"Say: ok"')}{s(c.plain, '}], max_tokens=')}{s(c.str, '5')}{s(c.plain, ')\n')}
              {s(c.plain, '  direct_times.')}{s(c.fn, 'append')}{s(c.plain, '((time.')}{s(c.fn, 'perf_counter')}{s(c.plain, '() - t0) * ')}{s(c.str, '1000')}{s(c.plain, ')\n')}
              {s(c.plain, '  t0 = time.')}{s(c.fn, 'perf_counter')}{s(c.plain, '()\n')}
              {s(c.plain, '  r = proxy.chat.completions.')}{s(c.fn, 'create')}{s(c.plain, '(model=')}{s(c.str, '"gpt-4.1-mini"')}{s(c.plain, ', messages=[{')}{s(c.str, '"role"')}{s(c.plain, ': ')}{s(c.str, '"user"')}{s(c.plain, ', ')}{s(c.str, '"content"')}{s(c.plain, ': ')}{s(c.str, '"Say: ok"')}{s(c.plain, '}], max_tokens=')}{s(c.str, '5')}{s(c.plain, ')\n')}
              {s(c.plain, '  proxy_times.')}{s(c.fn, 'append')}{s(c.plain, '((time.')}{s(c.fn, 'perf_counter')}{s(c.plain, '() - t0) * ')}{s(c.str, '1000')}{s(c.plain, ')\n')}
              {s(c.kw, 'if')}{s(c.plain, ' r.choices ')}{s(c.kw, 'and')}{s(c.plain, ' r.choices[')}{s(c.str, '0')}{s(c.plain, '].message.content:\n')}
              {s(c.plain, '  d, p = ')}{s(c.fn, 'avg')}{s(c.plain, '(direct_times), ')}{s(c.fn, 'avg')}{s(c.plain, '(proxy_times)\n')}
              {s(c.plain, '  ')}{s(c.fn, 'print')}{s(c.plain, '(')}{s(c.fn, 'f')}{s(c.str, '"✓ [OpenAI]    \'{r.choices[0].message.content.strip()}\'"')}{s(c.plain, ')\n')}
              {s(c.plain, '  ')}{s(c.fn, 'print')}{s(c.plain, '(')}{s(c.fn, 'f')}{s(c.str, `"  avg over {RUNS} runs - direct={d:.0f}ms  proxy={p:.0f}ms  overhead={p - d:+.0f}ms"`)}{s(c.plain, ')\n\n')}
              {s(c.comment, '# Anthropic\n')}
              {s(c.name, 'direct')}{s(c.plain, ' = ')}{s(c.fn, 'Anthropic')}{s(c.plain, '(api_key=')}{s(c.name, 'ANTHROPIC_KEY')}{s(c.plain, ')\n')}
              {s(c.name, 'proxy')}{s(c.plain, '  = ')}{s(c.fn, 'Anthropic')}{s(c.plain, '(\n')}
              {s(c.plain, '  api_key=')}{s(c.name, 'ANTHROPIC_KEY')}{s(c.plain, ', base_url=')}{s(c.str, `"${PROXY_URL}/proxy/anthropic"`)}{s(c.plain, ',\n')}
              {s(c.plain, '  default_headers={')} {s(c.str, '"x-ailedger-key"')}{s(c.plain, ': ')}{s(c.name, 'AILEDGER_KEY')}{s(c.plain, '}\n)\n')}
              {s(c.name, 'direct_times')}{s(c.plain, ', ')}{s(c.name, 'proxy_times')}{s(c.plain, ' = [], []\n')}
              {s(c.kw, 'for')}{s(c.plain, ' _ ')}{s(c.kw, 'in')}{s(c.plain, ' ')}{s(c.fn, 'range')}{s(c.plain, '(')}{s(c.name, 'RUNS')}{s(c.plain, '):\n')}
              {s(c.plain, '  t0 = time.')}{s(c.fn, 'perf_counter')}{s(c.plain, '()\n')}
              {s(c.plain, '  direct.messages.')}{s(c.fn, 'create')}{s(c.plain, '(model=')}{s(c.str, '"claude-opus-4-6"')}{s(c.plain, ', max_tokens=')}{s(c.str, '5')}{s(c.plain, ', messages=[{')}{s(c.str, '"role"')}{s(c.plain, ': ')}{s(c.str, '"user"')}{s(c.plain, ', ')}{s(c.str, '"content"')}{s(c.plain, ': ')}{s(c.str, '"Say: ok"')}{s(c.plain, '}])\n')}
              {s(c.plain, '  direct_times.')}{s(c.fn, 'append')}{s(c.plain, '((time.')}{s(c.fn, 'perf_counter')}{s(c.plain, '() - t0) * ')}{s(c.str, '1000')}{s(c.plain, ')\n')}
              {s(c.plain, '  t0 = time.')}{s(c.fn, 'perf_counter')}{s(c.plain, '()\n')}
              {s(c.plain, '  r = proxy.messages.')}{s(c.fn, 'create')}{s(c.plain, '(model=')}{s(c.str, '"claude-opus-4-6"')}{s(c.plain, ', max_tokens=')}{s(c.str, '5')}{s(c.plain, ', messages=[{')}{s(c.str, '"role"')}{s(c.plain, ': ')}{s(c.str, '"user"')}{s(c.plain, ', ')}{s(c.str, '"content"')}{s(c.plain, ': ')}{s(c.str, '"Say: ok"')}{s(c.plain, '}])\n')}
              {s(c.plain, '  proxy_times.')}{s(c.fn, 'append')}{s(c.plain, '((time.')}{s(c.fn, 'perf_counter')}{s(c.plain, '() - t0) * ')}{s(c.str, '1000')}{s(c.plain, ')\n')}
              {s(c.kw, 'if')}{s(c.plain, ' r.content ')}{s(c.kw, 'and')}{s(c.plain, ' r.content[')}{s(c.str, '0')}{s(c.plain, '].text:\n')}
              {s(c.plain, '  d, p = ')}{s(c.fn, 'avg')}{s(c.plain, '(direct_times), ')}{s(c.fn, 'avg')}{s(c.plain, '(proxy_times)\n')}
              {s(c.plain, '  ')}{s(c.fn, 'print')}{s(c.plain, '(')}{s(c.fn, 'f')}{s(c.str, '"✓ [Anthropic] \'{r.content[0].text.strip()}\'"')}{s(c.plain, ')\n')}
              {s(c.plain, '  ')}{s(c.fn, 'print')}{s(c.plain, '(')}{s(c.fn, 'f')}{s(c.str, `"  avg over {RUNS} runs - direct={d:.0f}ms  proxy={p:.0f}ms  overhead={p - d:+.0f}ms"`)}{s(c.plain, ')\n\n')}
              {s(c.comment, '# Gemini\n')}
              {s(c.name, 'direct')}{s(c.plain, ' = genai.')}{s(c.fn, 'Client')}{s(c.plain, '(api_key=')}{s(c.name, 'GEMINI_KEY')}{s(c.plain, ')\n')}
              {s(c.name, 'proxy')}{s(c.plain, '  = genai.')}{s(c.fn, 'Client')}{s(c.plain, '(\n')}
              {s(c.plain, '  api_key=')}{s(c.name, 'GEMINI_KEY')}{s(c.plain, ', http_options={\n')}
              {s(c.plain, '    ')}{s(c.str, '"base_url"')}{s(c.plain, ': ')}{s(c.str, `"${PROXY_URL}/proxy/gemini"`)}{s(c.plain, ',\n')}
              {s(c.plain, '    ')}{s(c.str, '"headers"')}{s(c.plain, ': {')}{s(c.str, '"x-ailedger-key"')}{s(c.plain, ': ')}{s(c.name, 'AILEDGER_KEY')}{s(c.plain, '},\n')}
              {s(c.plain, '  }\n)\n')}
              {s(c.name, 'direct_times')}{s(c.plain, ', ')}{s(c.name, 'proxy_times')}{s(c.plain, ' = [], []\n')}
              {s(c.kw, 'for')}{s(c.plain, ' _ ')}{s(c.kw, 'in')}{s(c.plain, ' ')}{s(c.fn, 'range')}{s(c.plain, '(')}{s(c.name, 'RUNS')}{s(c.plain, '):\n')}
              {s(c.plain, '  t0 = time.')}{s(c.fn, 'perf_counter')}{s(c.plain, '()\n')}
              {s(c.plain, '  direct.models.')}{s(c.fn, 'generate_content')}{s(c.plain, '(model=')}{s(c.str, '"gemini-2.5-flash"')}{s(c.plain, ', contents=')}{s(c.str, '"Say: ok"')}{s(c.plain, ')\n')}
              {s(c.plain, '  direct_times.')}{s(c.fn, 'append')}{s(c.plain, '((time.')}{s(c.fn, 'perf_counter')}{s(c.plain, '() - t0) * ')}{s(c.str, '1000')}{s(c.plain, ')\n')}
              {s(c.plain, '  t0 = time.')}{s(c.fn, 'perf_counter')}{s(c.plain, '()\n')}
              {s(c.plain, '  r = proxy.models.')}{s(c.fn, 'generate_content')}{s(c.plain, '(model=')}{s(c.str, '"gemini-2.5-flash"')}{s(c.plain, ', contents=')}{s(c.str, '"Say: ok"')}{s(c.plain, ')\n')}
              {s(c.plain, '  proxy_times.')}{s(c.fn, 'append')}{s(c.plain, '((time.')}{s(c.fn, 'perf_counter')}{s(c.plain, '() - t0) * ')}{s(c.str, '1000')}{s(c.plain, ')\n')}
              {s(c.kw, 'if')}{s(c.plain, ' r.text:\n')}
              {s(c.plain, '  d, p = ')}{s(c.fn, 'avg')}{s(c.plain, '(direct_times), ')}{s(c.fn, 'avg')}{s(c.plain, '(proxy_times)\n')}
              {s(c.plain, '  ')}{s(c.fn, 'print')}{s(c.plain, '(')}{s(c.fn, 'f')}{s(c.str, '"✓ [Gemini]    \'{r.text.strip()}\'"')}{s(c.plain, ')\n')}
              {s(c.plain, '  ')}{s(c.fn, 'print')}{s(c.plain, '(')}{s(c.fn, 'f')}{s(c.str, `"  avg over {RUNS} runs - direct={d:.0f}ms  proxy={p:.0f}ms  overhead={p - d:+.0f}ms"`)}{s(c.plain, ')\n')}
            </>)}

            {/* Expected output */}
            <div style={{ marginTop: 16, borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)', background: '#0d1017', overflow: 'hidden' }}>
              <div style={{ padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: 12, color: '#475569', fontFamily: 'monospace' }}>expected output</div>
              <div style={{ padding: '20px 22px', fontFamily: 'ui-monospace, monospace', fontSize: 13, lineHeight: 2.2 }}>
                {[
                  { label: '[OpenAI]    ' },
                  { label: '[Anthropic] ' },
                  { label: '[Gemini]    ' },
                ].map(({ label }) => (
                  <div key={label} style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ color: '#22c55e', fontSize: 16 }}>✓</span>
                      <span style={{ color: '#475569' }}>{label}</span>
                      <span style={{ color: '#86efac' }}>'ok'</span>
                    </div>
                    <div style={{ paddingLeft: 28, color: '#475569', fontSize: 12 }}>
                      avg over 3 runs - direct=<span style={{ color: '#94a3b8' }}>450ms</span>  proxy=<span style={{ color: '#94a3b8' }}>468ms</span>  overhead=<span style={{ color: '#86efac' }}>+18ms</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <p style={{ marginTop: 16, fontSize: 13, color: '#94a3b8', lineHeight: 1.8 }}>
              LLM inference time is noisy - bump <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: 4, fontSize: 11 }}>RUNS</code> to <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: 4, fontSize: 11 }}>10</code> for a stable average.
              {' '}Typical overhead is <span style={{ color: '#e2e8f0' }}>150–300ms</span> - an extra network hop through Cloudflare's edge. This is well within the natural variance of LLM inference time and has no meaningful impact on end-user experience. You may occasionally see the proxy come in <em>faster</em> than direct when Cloudflare's backbone beats your ISP's path to the provider.
            </p>
          </section>

          {/* API reference */}
          <section id="reference" style={{ scrollMarginTop: '96px', marginBottom: 64 }}>
            <h2 style={{ fontSize: 22, fontWeight: 600, color: '#fff', marginBottom: 16 }}>API reference</h2>

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                  {['Header', 'Required', 'Description'].map((h) => (
                    <th key={h} style={{ textAlign: 'left', padding: '8px 12px', color: '#475569', fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ['x-ailedger-key', 'Yes', 'Your AILedger API key (alg_sk_...)'],
                  ['Authorization', 'Yes', 'Your provider key - forwarded as-is to the upstream API'],
                ].map(([h, r, d]) => (
                  <tr key={h} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <td style={{ padding: '10px 12px' }}><code style={{ background: 'rgba(255,255,255,0.06)', padding: '2px 7px', borderRadius: 4, fontSize: 12, color: '#93c5fd' }}>{h}</code></td>
                    <td style={{ padding: '10px 12px', color: r === 'Yes' ? '#86efac' : '#475569' }}>{r}</td>
                    <td style={{ padding: '10px 12px', color: '#64748b' }}>{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p style={{ marginTop: 24, fontSize: 14, color: '#475569', lineHeight: 1.8 }}>
              Proxy base URL: <code style={{ background: 'rgba(255,255,255,0.06)', padding: '2px 7px', borderRadius: 4, fontSize: 12, color: '#e2e8f0' }}>{PROXY_URL}/proxy/{'<provider>'}</code>
              <br />Supported providers: <code style={{ background: 'rgba(255,255,255,0.06)', padding: '2px 7px', borderRadius: 4, fontSize: 12, color: '#e2e8f0' }}>openai</code> · <code style={{ background: 'rgba(255,255,255,0.06)', padding: '2px 7px', borderRadius: 4, fontSize: 12, color: '#e2e8f0' }}>anthropic</code> · <code style={{ background: 'rgba(255,255,255,0.06)', padding: '2px 7px', borderRadius: 4, fontSize: 12, color: '#e2e8f0' }}>gemini</code>
            </p>
          </section>

        </main>
      </div>

      <Footer />
    </div>
  )
}

function Legal() {
  const termsSections = [
    {
      title: '1. Description of Service',
      body: 'AILedger provides AI inference logging infrastructure to help operators of AI systems maintain audit records. AILedger does not certify compliance with any regulation, including the EU AI Act. Customers are solely responsible for their own regulatory compliance. This service includes features designed to facilitate audit logging and record-keeping that customers may use to support obligations under the EU AI Act, such as tamper-evident log integrity, time-stamped entries, and export capabilities. These features do not constitute legal advice, a conformity assessment, or a compliance guarantee.',
    },
    {
      title: '2. Acceptable Use',
      body: 'You may use AILedger only for lawful purposes. You may not use the service to log inferences from AI systems engaged in illegal activity. You are responsible for ensuring that your use of the service, including the configuration of logging scope, retention, and access controls, aligns with your obligations under the EU AI Act and other applicable laws.',
    },
    {
      title: '3. Data Storage and Audit Logging',
      body: 'AILedger stores cryptographic hashes (SHA-256) of AI inference inputs and outputs. Raw inputs and outputs are never retained. Metadata (including model name, provider, latency, status code, and timestamp) is stored indefinitely and is append-only by design.',
    },
    {
      title: '3.1 Audit Log Integrity',
      body: 'AILedger implements append-only, tamper-evident logging by design; each record includes a timestamp and integrity hash to enable verification of sequence and content integrity. The cryptographic hashes allow customers to prove that specific inputs and outputs were processed without AILedger storing the raw data.',
    },
    {
      title: '3.2 Retention and Preservation',
      body: 'By default, metadata is stored indefinitely. Customers are responsible for determining appropriate retention periods to satisfy any EU AI Act record-keeping requirements applicable to their systems. If you require specific retention horizons or legal holds, you must configure those settings or notify AILedger through the available product controls; otherwise, default indefinite retention applies.',
    },
    {
      title: '3.3 Access and Export',
      body: 'Customers may export audit logs and associated integrity proofs to support internal controls, post-market monitoring, incident analysis, and regulatory inquiries. Exports do not include raw inputs or outputs; verification is performed by recomputing hashes against customer-held raw data.',
    },
    {
      title: '3.4 Scope of Logged Data',
      body: 'You are responsible for selecting which systems, events, models, and metadata fields are logged in order to meet your obligations under the EU AI Act. Where your obligations require additional data elements not supported by AILedger\'s standard metadata fields, you must supply such data via supported custom metadata fields or maintain complementary records outside the service.',
    },
    {
      title: '3.5 Data Minimization and Confidentiality',
      body: 'Because raw inputs and outputs are never retained by AILedger, you must secure and manage raw data necessary to reconstruct or verify events. AILedger\'s design supports confidentiality by storing only hashes and metadata, reducing exposure of personal or sensitive data within AILedger\'s environment.',
    },
    {
      title: '4. No Warranty',
      body: 'The service is provided "as is." AILedger makes no warranty that use of the service satisfies any legal or regulatory obligation. Features intended to facilitate EU AI Act audit logging and record-keeping are provided without warranty and do not, by themselves, ensure compliance with the EU AI Act or any other law.',
    },
    {
      title: '5. Limitation of Liability',
      body: "AILedger's liability is limited to the amount you paid in the 3 months preceding any claim. To the maximum extent permitted by law, AILedger is not liable for your failure to configure or use the service in a manner that satisfies your EU AI Act obligations, including any record-keeping, incident reporting, or post-market monitoring requirements.",
    },
    {
      title: '6. Termination',
      body: 'We may suspend accounts that violate these terms. You may cancel at any time via the billing portal. Upon termination, customers are responsible for exporting any audit logs they require. AILedger may retain metadata and integrity hashes consistent with its append-only design and default indefinite retention, subject to applicable law.',
    },
  ]
  const privacySections = [
    {
      title: '1. Information we collect',
      body: 'Account email address. Billing information (processed by Stripe - we do not store card data). AI inference metadata: model name, provider, latency, status code, timestamp, and SHA-256 hashes of inputs/outputs.',
    },
    {
      title: '2. Information we do not collect',
      body: 'Raw AI inputs and/or outputs are never stored. We cannot reconstruct what was sent to and/or received from any AI provider.',
    },
    {
      title: '3. Sources of information',
      body: 'We obtain the personal information described above from the following sources: (1) directly from you, such as when you create an account or provide billing information; (2) automatically through our Services, such as AI inference metadata collected during your use of our software; (3) from third-party service providers, such as Stripe for payment processing.',
    },
    {
      title: '4. How we use your information',
      body: 'We use the personal information we collect to: provide you with our Services and software functionality; fulfill and manage subscriptions, purchases, orders, and payments; process transactions and maintain billing records; improve our Services, including analyzing usage patterns and system performance; maintain and operate our systems and infrastructure; comply with legal obligations, including financial record-keeping requirements; enforce our Terms of Service and other agreements with you; and protect the rights, property, and safety of our company, customers, and others.',
    },
    {
      title: '5. Legal basis (GDPR)',
      body: 'We process your data to perform the Terms of Service agreement you have with us (Art. 6(1)(b) GDPR) and to comply with financial record-keeping obligations (Art. 6(1)(c) GDPR).',
    },
    {
      title: '6. Disclosure of information',
      body: 'We disclose personal information to: (1) service providers and contractors who perform services on our behalf, such as payment processors (Stripe) for billing and cloud infrastructure providers (AWS via Supabase) for data storage and hosting - these service providers are contractually obligated to keep personal information confidential and use it only for the purposes disclosed; (2) for legal purposes, including to comply with court orders, laws, or legal process, to enforce our Terms of Service, or if we believe disclosure is necessary to protect rights, property, or safety; (3) in the event of a merger, acquisition, restructuring, or sale of assets.',
    },
    {
      title: '7. Data residency',
      body: 'All data is stored in the EU, namely AWS eu-central-1 (Frankfurt, Germany) via Supabase. This applies to all plans.',
    },
    {
      title: '8. Retention of data',
      body: 'We retain personal information for as long as reasonably necessary to fulfill the purposes described in this policy or as otherwise legally permitted or required. Inference logs are append-only and retained indefinitely - this is core to the compliance value of the service. Account data is deleted upon request, subject to our legal obligations and legitimate business needs.',
    },
    {
      title: '9. Data security',
      body: 'We use commercially reasonable administrative, physical, and technical measures designed to protect your personal information from accidental loss or destruction and from unauthorized access, use, alteration, and disclosure. However, no system is completely secure, and we cannot guarantee the absolute security of your information. Any transmission of personal information is at your own risk. The safety and security of your information also depends on you. You are responsible for taking steps to protect your personal information against unauthorized use, disclosure, and access.',
    },
    {
      title: '10. Your rights (EU residents)',
      body: 'If you are located in the European Union, you have the right to access, rectify, and erase personal data. Contact support@ailedger.dev to exercise these rights. Note: inference log hashes cannot be deleted as they contain no personal data.',
    },
    {
      title: '11. Your rights (other jurisdictions)',
      body: 'You may also have rights to: (1) access and data portability - confirm whether we process your personal information and access a copy; (2) correction of inaccuracies; (3) deletion, subject to certain exceptions under applicable law; (4) opt out of sales, sharing, or targeted advertising - note that we do not currently sell or share personal information or engage in targeted advertising. The exact scope of these rights varies by jurisdiction, and there are exceptions where we may not be able to fulfill your request.',
    },
    {
      title: '12. California privacy rights',
      body: 'If you are a California resident, the California Consumer Privacy Act (CCPA) and California Privacy Rights Act (CPRA) provide you with specific rights. We do not collect sensitive personal information as defined by the CCPA. We do not sell or share personal information as those terms are defined under the CCPA. Your California rights include: the right to know what personal information we collect, sources, purposes, and disclosures; the right to delete personal information, subject to exceptions; the right to correct inaccurate information; the right to opt out of sale or sharing; and the right to non-discrimination for exercising these rights. We will verify your identity before processing your request and respond to verifiable requests within 45 days. Contact support@ailedger.dev for California privacy requests.',
    },
    {
      title: '13. Children',
      body: 'Our Services are not intended for, and we do not knowingly collect personal information from, individuals under the age of 18. Our Services are designed for business users who are authorized to enter into contracts on behalf of their organizations. If we learn we have collected personal information from someone under 18 without appropriate authorization, we will delete that information.',
    },
    {
      title: '14. Changes to this policy',
      body: 'We may update this privacy policy from time to time. We will notify you of any changes by updating the "Last updated" date at the top of this policy and posting the updated policy on our website. Your continued use of our Services after we make changes constitutes acceptance of those changes. We encourage you to review this policy periodically.',
    },
  ]

  return (
    <div style={{ minHeight: '100vh', background: '#0a0b0f', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <div style={{ maxWidth: 680, margin: '0 auto', padding: '80px 32px' }}>
        <a href="/" style={{ color: '#475569', fontSize: 14, textDecoration: 'none', display: 'inline-block', marginBottom: 48 }}>← Back</a>
        <h1 style={{ fontSize: 36, fontWeight: 700, color: '#fff', letterSpacing: '-0.5px', marginBottom: 8 }}>Legal</h1>
        <p style={{ color: '#475569', fontSize: 14, marginBottom: 48 }}>Last updated: April 13, 2026</p>

        <h2 id="terms" style={{ fontSize: 26, fontWeight: 700, color: '#fff', letterSpacing: '-0.3px', marginTop: 24, marginBottom: 24, paddingBottom: 12, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>Terms of Service</h2>
        {termsSections.map((s) => (
          <div key={s.title} style={{ marginBottom: 36 }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: '#f1f5f9', marginBottom: 8 }}>{s.title}</h3>
            <p style={{ fontSize: 15, color: '#64748b', lineHeight: 1.8 }}>{s.body}</p>
          </div>
        ))}

        <h2 id="privacy" style={{ fontSize: 26, fontWeight: 700, color: '#fff', letterSpacing: '-0.3px', marginTop: 64, marginBottom: 24, paddingBottom: 12, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>Privacy Policy</h2>
        {privacySections.map((s) => (
          <div key={s.title} style={{ marginBottom: 36 }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: '#f1f5f9', marginBottom: 8 }}>{s.title}</h3>
            <p style={{ fontSize: 15, color: '#64748b', lineHeight: 1.8 }}>{s.body}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function Contact() {
  return (
    <div style={{ minHeight: '100vh', background: '#0a0b0f', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <div style={{ maxWidth: 680, margin: '0 auto', padding: '80px 32px' }}>
        <a href="/" style={{ color: '#475569', fontSize: 14, textDecoration: 'none', display: 'inline-block', marginBottom: 48 }}>- Back</a>
        <h1 style={{ fontSize: 36, fontWeight: 700, color: '#fff', letterSpacing: '-0.5px', marginBottom: 8 }}>Contact</h1>
        <p style={{ color: '#475569', fontSize: 15, lineHeight: 1.8, marginBottom: 36 }}>
          For support, billing questions, and to exercise your data rights under GDPR, reach us at:
        </p>
        <a href="mailto:support@ailedger.dev" style={{ fontSize: 18, color: '#818cf8', textDecoration: 'none', fontWeight: 500 }}>
          support@ailedger.dev
        </a>
        <p style={{ color: '#334155', fontSize: 14, marginTop: 48, lineHeight: 1.8 }}>
          For enterprise inquiries or EU data residency questions, use the same address and we'll route you to the correct person.
        </p>
      </div>
    </div>
  )
}

function AnnexIIIGuide() {
  const categories = [
    {
      num: 'I',
      title: 'Biometric identification and categorisation',
      examples: 'Facial recognition for access control, emotion detection in interviews, real-time biometric surveillance',
      ask: 'Does your AI identify, verify, or categorise people based on biometric data (face, voice, gait, fingerprints)?',
    },
    {
      num: 'II',
      title: 'Management and operation of critical infrastructure',
      examples: 'AI controlling power grid load balancing, water treatment automation, traffic management systems',
      ask: 'Does your AI manage, control, or make decisions about physical infrastructure where failure could endanger safety?',
    },
    {
      num: 'III',
      title: 'Education and vocational training',
      examples: 'Automated essay grading, student admission scoring, learning path recommendations that gate access to education',
      ask: 'Does your AI determine access to education, evaluate students, or influence educational outcomes?',
    },
    {
      num: 'IV',
      title: 'Employment, workers management and access to self-employment',
      examples: 'Resume screening, automated interview scoring, employee productivity monitoring, promotion recommendations',
      ask: 'Does your AI screen candidates, evaluate employees, or influence hiring/firing/promotion decisions?',
    },
    {
      num: 'V',
      title: 'Access to essential private services and public services and benefits',
      examples: 'Credit scoring, insurance risk assessment, benefits eligibility determination, emergency service dispatching',
      ask: 'Does your AI determine eligibility for credit, insurance, public benefits, or emergency services?',
    },
    {
      num: 'VI',
      title: 'Law enforcement',
      examples: 'Predictive policing, evidence analysis, recidivism risk scoring, lie detection',
      ask: 'Does your AI assist law enforcement in profiling, investigation, risk assessment, or evidence evaluation?',
    },
    {
      num: 'VII',
      title: 'Migration, asylum and border control management',
      examples: 'Visa application screening, asylum claim assessment, border surveillance, document authenticity verification',
      ask: 'Does your AI process migration applications, assess asylum claims, or monitor borders?',
    },
    {
      num: 'VIII',
      title: 'Administration of justice and democratic processes',
      examples: 'Sentencing recommendations, case outcome prediction, election integrity monitoring',
      ask: 'Does your AI influence judicial decisions, legal outcomes, or democratic processes?',
    },
    {
      num: 'IX',
      title: 'General Purpose AI (GPAI) deployed in a high-risk context',
      examples: 'GPT/Claude/Gemini used as the core decision engine in any of the above categories',
      ask: 'Are you using a general-purpose model (ChatGPT, Claude, Gemini, etc.) as a component in any of the high-risk use cases above?',
    },
  ]

  return (
    <div style={{ minHeight: '100vh', background: '#0a0b0f', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <Nav />
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '100px 32px 80px' }}>
        <a href="/docs" style={{ color: '#475569', fontSize: 14, textDecoration: 'none', display: 'inline-block', marginBottom: 48 }}>← Back to docs</a>
        <h1 style={{ fontSize: 36, fontWeight: 700, color: '#fff', letterSpacing: '-0.5px', marginBottom: 8 }}>
          Annex III Category Guide
        </h1>
        <p style={{ color: '#64748b', fontSize: 16, lineHeight: 1.7, marginBottom: 16 }}>
          The EU AI Act (Regulation 2024/1689) classifies certain AI systems as "high-risk" under Annex III. If your system falls into any of these categories, you are required to maintain automatic event logs under Article 12.
        </p>
        <p style={{ color: '#64748b', fontSize: 14, lineHeight: 1.7, marginBottom: 48 }}>
          For each category below, ask yourself the question. If the answer is yes, that is likely your Annex III classification. If your system spans multiple categories, select the most specific one. If you are unsure, consult your legal or compliance team.
        </p>

        {categories.map((cat, i) => (
          <div key={cat.num} style={{ marginBottom: 36, paddingBottom: i < categories.length - 1 ? 36 : 0, borderBottom: i < categories.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none' }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'baseline', marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#818cf8', fontFamily: 'monospace', minWidth: 28 }}>{cat.num}.</span>
              <h2 style={{ fontSize: 18, fontWeight: 600, color: '#fff' }}>{cat.title}</h2>
            </div>
            <div style={{ paddingLeft: 44 }}>
              <p style={{ fontSize: 14, color: '#94a3b8', lineHeight: 1.8, marginBottom: 12 }}>
                <span style={{ color: '#e2e8f0', fontWeight: 500 }}>Ask:</span> {cat.ask}
              </p>
              <p style={{ fontSize: 13, color: '#64748b', lineHeight: 1.7 }}>
                <span style={{ color: '#475569', fontWeight: 500 }}>Examples:</span> {cat.examples}
              </p>
            </div>
          </div>
        ))}

        <div style={{ marginTop: 48, padding: '20px 24px', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.18)', borderRadius: 12 }}>
          <p style={{ fontSize: 14, color: '#818cf8', lineHeight: 1.7 }}>
            <span style={{ fontWeight: 600 }}>Not sure?</span> Select "Other (describe in system purpose)" in your system settings and describe your use case in the purpose field. Your compliance report will include this description for regulators to assess.
          </p>
        </div>

        <p style={{ marginTop: 32, fontSize: 12, color: '#475569', lineHeight: 1.7 }}>
          Source: Annex III, Regulation (EU) 2024/1689 of the European Parliament and of the Council (EU AI Act).
        </p>
      </div>
    </div>
  )
}

export default App
