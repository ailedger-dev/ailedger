import { useEffect, useRef, type ReactNode } from 'react'
import './ds/tokens.css'
import './ds/primitives.css'
import './HomeRedesign.css'
import { PageShell, Section, Eyebrow, DisplayHeading } from './ds'

// Preview build of the homepage on the Marketing DS (dark/flat) with the
// density-reduction structure: one claim + signature graphic + scannable
// icon/stat/comparison rows instead of paragraph stacks. Lives at /home-v2;
// the live / route is untouched.

const SIGNUP_URL = 'https://dash.ailedger.dev?view=sign-up'

/* ── signature graphic: the append-only hash chain ───────────────────────── */
function HashChain() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const ctx = c.getContext('2d')!
    const DPR = Math.min(window.devicePixelRatio || 1, 2)
    const reduce = window.matchMedia?.('(prefers-reduced-motion:reduce)').matches
    const NODE_W = 104, NODE_H = 58, GAP = 46
    const hashes = ['a1b2…eeff', '7c3d…91a0', 'f0e1…2d4c', '3b9a…c7e2', 'd4f5…8061', '9e2c…aa17', '5170…b3d9', 'c8a4…0f6b']
    let W = 0, H = 0, nodes: { x: number; y: number; h: string }[] = [], raf = 0
    function layout() {
      W = c!.clientWidth; H = c!.clientHeight
      c!.width = W * DPR; c!.height = H * DPR; ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
      nodes = []
      const n = Math.max(3, Math.floor((W - 40) / (NODE_W + GAP)))
      const startX = (W - (n * NODE_W + (n - 1) * GAP)) / 2, y = H / 2 - NODE_H / 2
      for (let i = 0; i < n; i++) nodes.push({ x: startX + i * (NODE_W + GAP), y, h: hashes[i % hashes.length] })
    }
    function rr(x: number, y: number, w: number, h: number, r: number) {
      ctx.beginPath(); ctx.moveTo(x + r, y)
      ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r)
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
    }
    function draw(t: number) {
      ctx.clearRect(0, 0, W, H)
      const sweep = reduce ? -1 : (t / 900) % (nodes.length + 2)
      for (let i = 0; i < nodes.length; i++) {
        const nd = nodes[i]
        if (i < nodes.length - 1) {
          const x1 = nd.x + NODE_W, x2 = nodes[i + 1].x, my = nd.y + NODE_H / 2
          ctx.strokeStyle = '#2A2E35'; ctx.lineWidth = 1.5
          ctx.beginPath(); ctx.moveTo(x1, my); ctx.lineTo(x2, my); ctx.stroke()
          ctx.fillStyle = '#15171C'; ctx.strokeStyle = '#2A2E35'
          ctx.beginPath(); ctx.arc((x1 + x2) / 2, my, 4, 0, 7); ctx.fill(); ctx.stroke()
        }
        const active = Math.abs(i - sweep) < 0.6
        rr(nd.x, nd.y, NODE_W, NODE_H, 6)
        ctx.fillStyle = active ? 'rgba(107,119,219,.16)' : '#0E1014'; ctx.fill()
        ctx.lineWidth = 1.5; ctx.strokeStyle = active ? '#6B77DB' : '#23272E'; ctx.stroke()
        if (active) { ctx.save(); ctx.shadowColor = '#6B77DB'; ctx.shadowBlur = 18; ctx.stroke(); ctx.restore() }
        ctx.fillStyle = '#62666D'; ctx.font = '9px ui-monospace,Menlo,monospace'
        ctx.fillText('RECORD #' + (i + 1), nd.x + 12, nd.y + 20)
        ctx.fillStyle = active ? '#F7F8F8' : '#8A8F98'; ctx.font = '13px ui-monospace,Menlo,monospace'
        ctx.fillText(nd.h, nd.x + 12, nd.y + 40)
      }
      if (!reduce) raf = requestAnimationFrame(draw)
    }
    layout(); reduce ? draw(0) : (raf = requestAnimationFrame(draw))
    let rt: number
    const onResize = () => { clearTimeout(rt); rt = window.setTimeout(() => { layout(); if (reduce) draw(0) }, 150) }
    window.addEventListener('resize', onResize)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize) }
  }, [])
  return <div className="hv-chain"><canvas ref={ref} aria-label="An append-only chain of hashed inference records, each linked to the previous by hash." /></div>
}

/* ── small inline icons ──────────────────────────────────────────────────── */
const I = {
  shield: <path d="M12 3l7 3v6c0 4-3 6.5-7 8-4-1.5-7-4-7-8V6z M9 13.5l2.5 2.5L15.5 11" />,
  eye: <><circle cx="12" cy="12" r="3.2" /><path d="M3 12c2.5-4 6-6 9-6s6.5 2 9 6c-2.5 4-6 6-9 6s-6.5-2-9-6z" opacity=".5" /></>,
  scale: <path d="M12 3v18 M5 7h14 M5 7l-2 5h6z M19 7l2 5h-6z" />,
  arrowIn: <path d="M4 12h10 M11 8l4 4-4 4 M17 5h3v14h-3" />,
  log: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 9h8M8 13h8M8 17h5" /></>,
  download: <path d="M12 3v11 M8 10l4 4 4-4 M5 19h14" />,
}
function Icon({ d, size = 26 }: { d: ReactNode; size?: number }) {
  return <svg className="hv-ic" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
}

function Btn({ href, primary, children }: { href: string; primary?: boolean; children: ReactNode }) {
  return <a className={`hv-btn${primary ? ' hv-btn--primary' : ''}`} href={href}>{children}</a>
}

export default function HomeRedesign() {
  return (
    <PageShell className="home-v2">
      {/* nav */}
      <Section pad="topbar" className="hv-nav">
        <span className="hv-wordmark">AILedger</span>
        <nav className="hv-navlinks">
          <a href="#how">How it works</a>
          <a href="#pricing">Pricing</a>
          <a href="/docs">Docs</a>
          <Btn href={SIGNUP_URL} primary>Set it up</Btn>
        </nav>
      </Section>

      {/* hero */}
      <Section pad="hero" className="hv-hero">
        <Eyebrow><span className="hv-dot" /> EU AI Act · enforcement Aug 2, 2026</Eyebrow>
        <DisplayHeading as="h1" className="hv-h1">
          Audit-grade evidence for <span className="hv-grad">every</span> AI call you make.
        </DisplayHeading>
        <p className="ds-lede hv-lede">
          The audit substrate for AI decisions in regulated and adversarial contexts —
          tamper-evident, privacy-preserving, and ready for a regulator on day one.
        </p>
        <div className="hv-ctas">
          <Btn href={SIGNUP_URL} primary>Set it up</Btn>
          <Btn href="#how">Read how it works</Btn>
        </div>
        <HashChain />
        <div className="hv-trio">
          <div><Icon d={I.shield} /><h3>Tamper-evident</h3><p>Hash-chained, append-only records. Modification is impossible — and provably so.</p></div>
          <div><Icon d={I.eye} /><h3>Privacy by construction</h3><p>Only SHA-256 fingerprints + metadata. No prompts or outputs ever stored.</p></div>
          <div><Icon d={I.scale} /><h3>Regulator-ready</h3><p>FRE 707 admissibility and EU AI Act Articles 12, 19, 26 — built in, not bolted on.</p></div>
        </div>
      </Section>

      {/* stat band */}
      <Section pad="standard" className="hv-statwrap">
        <DisplayHeading as="h2">The whole pitch, in five numbers.</DisplayHeading>
        <div className="hv-stats">
          <div><div className="hv-n">2<span> lines</span></div><div className="hv-l">to integrate — one URL, one header</div></div>
          <div><div className="hv-n">0</div><div className="hv-l">prompts or outputs stored</div></div>
          <div><div className="hv-n">150<span>–300ms</span></div><div className="hv-l">proxy overhead, on Cloudflare edge</div></div>
          <div><div className="hv-n hv-mono">SHA-256</div><div className="hv-l">fingerprints, hash-chained</div></div>
          <div><div className="hv-n">EU<span> only</span></div><div className="hv-l">eu-central-1 (Frankfurt) residency</div></div>
        </div>
      </Section>

      {/* how it works */}
      <Section pad="standard" id="how" className="hv-flowwrap">
        <DisplayHeading as="h2">Point. Log. Export.</DisplayHeading>
        <p className="hv-sub">Three steps, each reversible — your app code stays intact.</p>
        <div className="hv-flow">
          <div className="hv-step"><div className="hv-num">01</div><Icon d={I.arrowIn} size={22} /><h3>Point your calls at us</h3><p>Swap the base URL, add your key as a header. We forward to OpenAI, Anthropic, Gemini and return the response unchanged.</p></div>
          <div className="hv-step"><div className="hv-num">02</div><Icon d={I.log} size={22} /><h3>Every inference is an entry</h3><p>Inputs and outputs are hashed; hash + metadata land in an append-only log. Async — never blocks your response.</p></div>
          <div className="hv-step"><div className="hv-num">03</div><Icon d={I.download} size={22} /><h3>Export the audit trail</h3><p>One click. A formatted Article 12 report — hashed, ordered, chained — ready for a regulator.</p></div>
        </div>
      </Section>

      {/* store / never store */}
      <Section pad="standard" className="hv-cmpwrap">
        <DisplayHeading as="h2">What lives in the ledger — and what never does.</DisplayHeading>
        <p className="hv-sub">The privacy story is a contrast, so we show it as one.</p>
        <div className="hv-cmp">
          <div className="hv-col hv-keep">
            <header>Stored</header>
            <div className="hv-row"><span className="hv-m">✓</span><div>SHA-256 fingerprint of the input <span className="hv-h">a1b2…eeff</span></div></div>
            <div className="hv-row"><span className="hv-m">✓</span><div>SHA-256 fingerprint of the output</div></div>
            <div className="hv-row"><span className="hv-m">✓</span><div>Metadata — timestamp, model, latency, status</div></div>
            <div className="hv-row"><span className="hv-m">✓</span><div>The chain link to the prior record</div></div>
          </div>
          <div className="hv-col hv-drop">
            <header>Never stored</header>
            <div className="hv-row"><span className="hv-m">✕</span><div>The raw prompt</div></div>
            <div className="hv-row"><span className="hv-m">✕</span><div>The model's response</div></div>
            <div className="hv-row"><span className="hv-m">✕</span><div>Any personal data — nothing to leak or subpoena</div></div>
            <div className="hv-row"><span className="hv-m">✕</span><div>Anything that leaves the EU</div></div>
          </div>
        </div>
      </Section>

      {/* compliance checklist */}
      <Section pad="standard" className="hv-checkwrap">
        <DisplayHeading as="h2">Built to produce records regulators accept.</DisplayHeading>
        <div className="hv-checks">
          <div className="hv-check"><span className="hv-m">✓</span><div><h3>Article 12, literally</h3><p>The logs the provision calls for — every high-risk inference, auditable.</p></div></div>
          <div className="hv-check"><span className="hv-m">✓</span><div><h3>GDPR by construction</h3><p>No content collected means no content to leak, subpoena, or subject-access.</p></div></div>
          <div className="hv-check"><span className="hv-m">✓</span><div><h3>Append-only by enforcement</h3><p>A DB-trigger guarantee — not you, not us, not a root user can edit.</p></div></div>
          <div className="hv-check"><span className="hv-m">✓</span><div><h3>Externally verifiable</h3><p>A regulator traces the hash chain end-to-end, in SQL.</p></div></div>
        </div>
      </Section>

      {/* pricing */}
      <Section pad="standard" id="pricing" className="hv-pricewrap">
        <DisplayHeading as="h2">Priced by where you are in the journey.</DisplayHeading>
        <div className="hv-tiers">
          <div className="hv-tier">
            <div className="hv-tier-name">Ledger</div>
            <div className="hv-tier-band">Free · $149 · $499 / mo</div>
            <ul><li>Up to 10k → 1M inferences/mo</li><li>Article 12 audit trail</li><li>EU data residency</li></ul>
            <Btn href={SIGNUP_URL} primary>Start free</Btn>
          </div>
          <div className="hv-tier hv-tier--hi">
            <div className="hv-tier-name">Evidence</div>
            <div className="hv-tier-band">$40,000 / year</div>
            <ul><li>Defensible artifact for auditors</li><li>Ships with SOC 2 Type I</li><li>Design-partner pricing</li></ul>
            <Btn href="/contact" primary>Apply for design partnership</Btn>
          </div>
          <div className="hv-tier">
            <div className="hv-tier-name">Audit</div>
            <div className="hv-tier-band">From $80,000 / year</div>
            <ul><li>BaFin, FCA, AMF, Solvency II, MiCA</li><li>Sectoral retention overlays</li><li>Custom MSA + order form</li></ul>
            <Btn href="/contact">Talk to us</Btn>
          </div>
        </div>
        <a className="hv-fulllink" href="/pricing">See full pricing →</a>
      </Section>

      {/* cta */}
      <Section pad="cta" className="hv-cta">
        <DisplayHeading as="h2">Start before the deadline.</DisplayHeading>
        <p className="ds-lede hv-lede">Free to start, no card. Integration takes about a minute: one URL, one header, one account.</p>
        <div className="hv-ctas"><Btn href={SIGNUP_URL} primary>Create your account</Btn></div>
      </Section>

      {/* footer */}
      <Section pad="topbar" className="hv-footer">
        <span>AILedger</span>
        <div className="hv-footlinks">
          <a href="/legal">Legal</a><a href="/contact">Contact</a><a href="/docs">Docs</a>
          <span className="hv-tag">EU AI Act record-keeping infrastructure</span>
        </div>
      </Section>
    </PageShell>
  )
}
