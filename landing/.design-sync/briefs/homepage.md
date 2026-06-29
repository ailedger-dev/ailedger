# Rebuild brief — AILedger homepage (Marketing DS)

Paste this whole file into the Claude Design agent on the AILedger Marketing DS
project (https://claude.ai/design/p/702ae72d-518a-4188-8e18-6952d0ed2728).
It is the full content + structure of the live homepage (`landing/src/App.tsx`)
mapped onto this design system. Source of truth for *look* is the DS; source of
truth for *content* is below.

---

## Global rules

- Root the page in `<PageShell>` (dark `.ds-root` surface, Inter, reveal observer).
- One section per block below, in order, each a `<Section>` with the given `pad`.
- Type: `<DisplayHeading>` for headings, `<Eyebrow>` for kickers, `.ds-lede` for
  lead paragraphs, `.ds-body` for body copy. Color via `--ds-text-1/2/3`; links
  and primary buttons via `--ds-accent`. Spacing via `--ds-space-*`. Flat — **no
  shadows**, single `#08090A` surface.
- This DS has no button, card, code-block, or accordion primitive (it's a flat
  marketing language). Where one is needed below, build a **minimal flat
  treatment**: 1px `--ds-text-3`-tinted borders, 4px radius, `--ds-accent` fill
  for primary actions, no shadow. Keep it consistent across all sections.
- Buttons: primary = `--ds-accent` background, `#fff` text; secondary = transparent
  with a 1px border. Both 4px radius, medium weight.

## Nav (Section pad="topbar")

Left: "AILedger" wordmark. Right: links `How it works` (#how-it-works),
`Pricing` (#pricing), `Docs` (/docs), then a primary button **"Set it up"**
(→ the dashboard). Thin, transparent, sits above the hero.

## 1. Hero (Section pad="hero", centered)

- Eyebrow (with a small leading accent dot): `August 2, 2026 · EU AI Act Article 50 + FRIA enforcement`
- DisplayHeading as="h1" (two lines; the word **"every"** is a gradient accent —
  indigo→violet):
  `Audit-grade evidence for` / `every AI call your product makes.`
- `.ds-lede`: `AILedger makes AI decisions in high-risk industries substantively auditable. We catch bias, drift, and disparate impact in production. Harm gets prevented before any compounding effects, not after a regulator or lawsuit forces the conversation.`
- `.ds-body` (`--ds-text-2`): `AILedger is the audit substrate for AI-influenced decisions in regulated and adversarial contexts. Three layers (Integrity Chain, Decision Event, Detection) ready for Federal Rule 707 admissibility and EU AI Act Articles 12, 19, 26, 27 (FRIA), and 50 (transparency).`
- `.ds-body` (`--ds-text-2`): `No prompts are stored. No outputs are stored. Only SHA-256 fingerprints + metadata. The evidence a regulator or auditor can verify, without AILedger holding your customers' data.`
- Buttons: primary **"Set it up"**, secondary **"Read how it works"** (#how-it-works).

## 2. Trust bar (Section pad="standard", subtle top+bottom border, max-width ~720)

Two `.ds-body` paragraphs:
1. `What AILedger stores: SHA-256 fingerprints of inputs and outputs, plus metadata (timestamp, model, latency, status). What it doesn't store: the raw prompts or responses themselves. Records are hash-chained and append-only; data resides in EU-central-1 (Frankfurt).`
2. `The EU AI Act phases in starting August 2, 2026, with Article 27 Fundamental Rights Impact Assessment (FRIA) for deployers in credit, insurance, public services, education, and employment; Article 50 transparency obligations; financial-sector high-risk AI; and GPAI provider duties binding on that date. The May 2026 Digital Omnibus moved most other Annex III high-risk obligations to December 2, 2027, and Annex I product-embedded systems to August 2, 2028. FRIAs are living documents — continuous evidence infrastructure is what makes them defensible.`

## 3. How it works (Section pad="standard", max-width ~720)

- DisplayHeading as="h2": `How it works`
- `.ds-body`: `Three steps, each reversible: point, log, export.`
- Three steps (mono `--ds-text-3` number + h3 title + `.ds-body`):
  - **01 — Point your API calls at AILedger.** `Change your base URL to our proxy; pass your AILedger key as a header. Your application code stays intact. The proxy forwards your request to the upstream provider (OpenAI, Anthropic, Gemini) and returns the response unchanged. Logging happens asynchronously and does not block your response.`
  - **02 — Every inference becomes an entry.** `Inputs and outputs are hashed (SHA-256), and the hash plus metadata — timestamp, model name, latency, status — are written to an append-only log in EU-central-1 (Frankfurt). Raw prompts and outputs are never stored. GDPR-compatible by construction.`
  - **03 — Export the Article 12 audit trail.** `Your compliance team clicks once. AILedger generates a formatted audit report — every inference hashed, timestamped, ordered, hash-chained — ready for a regulator's review.`

## 4. Compliance (Section pad="standard", subtle borders, max-width ~720)

- DisplayHeading as="h2": `Built as infrastructure for auditing AI, not a dashboard with logging bolted on.`
- `.ds-body`: `The whole system is designed to produce records regulators will accept — and to be incapable of producing records regulators won't.`
- Five titled paragraphs (h3 + `.ds-body`):
  - **Article 12, specifically.** `AILedger doesn't attempt to certify your compliance — that's not something any vendor can do. It produces the logs Article 12 calls for: every inference from a high-risk AI system, logged throughout the system's lifetime, in a form an auditor can verify.`
  - **GDPR by construction.** `Raw prompts and outputs never enter AILedger's storage. Only SHA-256 fingerprints plus metadata. No personal data collected means no personal data to leak, subpoena, or subject-access.`
  - **Append-only by enforcement.** `Records cannot be modified or deleted — not by you, not by us, not by a root DB user. Append-only is a DB-trigger-level guarantee, not a UI checkbox.`
  - **Hash-chained, exportable, auditor-reviewable.** `Every record links to the prior one by hash. A tamper-detection pass traces the chain end-to-end. Your compliance team exports the full chain — with metadata, timestamps, and hash-verification — for a regulator's review.`
  - **SOC 2 Type II on track for Q3 2027.** `We're auditing toward SOC 2 Type II with Q3 2027 as the realistic — not aspirational — delivery window. The logging + access-control substrate a SOC 2 audit examines has been in place since v1; the audit engagement is what's scheduled. SOC 2 Type I ships ahead of it in Q3 2026.`
- A flat bordered callout (DS gap — minimal 1px border, accent-tinted):
  - Eyebrow: `CUSTOMER QUESTION`
  - Italic: `Why can't we just hash ourselves?`
  - Blockquote (left accent border): `"A customer could hash themselves. But then their audit defense is 'trust our internal log.' Our chain is externally verifiable by a regulator in SQL. That's the product."`

## 5. Integration / code (Section pad="standard", centered, max-width ~680)

- DisplayHeading as="h2": `Integration is one URL and one header.`
- `.ds-body`: `Two lines change. The rest of your application code stays intact.`
- A flat dark code block (DS gap — build a `#0d0e10`-ish surface, 1px border,
  mono, traffic-light dots + filename `your_app.py`):
  ```python
  # Before
  client = OpenAI(api_key="your-key")

  # After
  client = OpenAI(
    api_key="your-key",
    base_url="https://<proxy-host>/proxy/openai",
    default_headers={ "x-ailedger-key": "agl_sk_..." }
  )
  ```
- `.ds-body`: `Works with OpenAI, Anthropic, Gemini, and any OpenAI-compatible API. From the moment the base URL switches, every request flows through AILedger and produces a record. If you remove AILedger tomorrow, your application goes back to calling the provider directly — no lock-in, no migration, no ceremony.`

## 6. Pricing (Section pad="standard", id="pricing", max-width ~1100)

- DisplayHeading as="h2": `Pricing.`
- `.ds-body`: `Three tiers, priced by where you are in the compliance journey.`
- Three flat tier cards in a 3-col grid (middle one highlighted with an accent
  border/tint). Each: small uppercase name, a price band, body, a button.
  - **Ledger** — band `Free · $149/mo · $499/mo` — `For engineering teams shipping LLM features that will need audit evidence before they need an auditor. Free covers up to 10,000 inferences per month; Pro at $149/month extends to 100,000; Scale at $499/month to 1,000,000. Usage-based above. All plans include the Article 12 audit trail, SHA-256 fingerprinted records, and EU data residency (Frankfurt).` — button **Start free**.
  - **Evidence** *(highlighted)* — band `$40,000 / year · annual contract` — `For the DPO, counsel, and engineering lead who need to hand an auditor a defensible artifact — not a screenshot. Ships alongside SOC 2 Type I (Q3 2026 target). Design-partner pricing available for the first cohort.` — button **Apply for design partnership**.
  - **Audit** — band `From $80,000 / year · custom-scoped` — `For regulated verticals (BaFin MaRisk, FCA SYSC, AMF RG, Solvency II, MiCA) plus EU AI Act financial-sector high-risk obligations binding August 2, 2026. Sectoral overlays configured to your binding retention floor; MSA with custom order form.` — button **Talk to us**.
- Below the grid, centered accent link: `See full pricing →` (/pricing).

## 7. FAQ (Section pad="standard", centered head, max-width ~720)

- DisplayHeading as="h2": `Frequently asked questions`
- `.ds-body`: `Everything you need to know before integrating.`
- Seven flat accordion items (details/summary; 1px border, `+` affordance):
  1. **What is the EU AI Act Article 12?** — `The EU AI Act — the regulation formally cited as 2024/1689 — requires operators of high-risk AI systems to maintain automatic logging of events throughout the system's lifetime. Article 12 is the specific provision that sets those logging requirements. AILedger is purpose-built to give you the audit trail Article 12 calls for: hash-chained entries in an append-only log, exportable for regulator review.`
  2. **Does AILedger store my prompts or AI outputs?** — `No. AILedger stores SHA-256 fingerprints of inputs and outputs, plus metadata (timestamp, model, latency, status). The raw content never enters our systems. One-way fingerprints let you prove a specific inference happened without anyone — including us — retaining the content. This is what makes AILedger GDPR-compatible by construction.`
  3. **How long does integration take?** — `One URL change, one header addition. For OpenAI, Anthropic, Gemini, or any OpenAI-compatible API, integration means pointing your existing client at our proxy and passing your AILedger key as a header. Teams are typically logging their first inference within a minute of account creation.`
  4. **Does AILedger add latency to my AI calls?** — `The proxy hop adds 150-300ms on average via Cloudflare's global edge network — within the variance LLM responses already produce. The audit record is durably committed to a write-buffer before your response returns (sub-20ms KV write); the database ingest then happens asynchronously. Your application never waits on database logging to finish, and the audit record cannot be lost if the database is briefly unavailable.`
  5. **Which AI providers are supported?** — `OpenAI, Anthropic, and Google Gemini natively. Any API that follows the OpenAI-compatible format works unchanged.`
  6. **Is AILedger sufficient for EU AI Act compliance on its own?** — `No — and no single tool is. AILedger produces the logging and record-keeping infrastructure Article 12 requires. Full EU AI Act compliance also involves conformity assessments, transparency obligations, and human oversight — none of which AILedger provides. We handle the audit trail piece: the specific part a regulator asks for first.`
  7. **Where is data stored?** — `All data — fingerprints and metadata, never raw content — lives in AWS eu-central-1 (Frankfurt), via Supabase. Applies to every plan including Free. Nothing leaves the EU.`
  (Plus the "AI audit vs audit of AI" item from the live page if you want all 8.)

## 8. CTA (Section pad="cta", centered, max-width ~520)

- DisplayHeading as="h2": `Start before the deadline.`
- `.ds-body`: `Free to start. No credit card required. Integration takes about a minute: one URL, one header, one account.`
- Primary button: **Create your account** (→ dashboard).

## 9. Footer

Left: `AILedger`. Right: links `Legal` (/legal), `Contact` (/contact),
`Docs` (/docs), and tagline `EU AI Act record-keeping infrastructure`.
