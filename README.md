# AILedger

**Audit-grade evidence for AI-influenced decisions, ready for Federal Rule 707 and the EU AI Act.**

AILedger is the audit substrate for AI-influenced decisions in regulated and adversarial contexts. Three layers (Integrity Chain, Decision Event, Detection) ready for Federal Rule of Evidence 707 admissibility (United States) and EU AI Act Articles 12, 19, 26 (European Union). Standards-anchored to ISO/IEC 42001 and NIST AI RMF 1.0. Charter v1.2 published with refused-customer + refused-feature commitments. Open-source Detection layer at [github.com/jakejjoyner/ailedger-detection](https://github.com/jakejjoyner/ailedger-detection).

**License:** MIT (this repo) · **Detection layer:** Apache 2.0 at [github.com/jakejjoyner/ailedger-detection](https://github.com/jakejjoyner/ailedger-detection)

**Live:** [ailedger.dev](https://ailedger.dev) · **Charter:** [ailedger.dev/charter](https://ailedger.dev/charter) · **Dashboard:** [dash.ailedger.dev](https://dash.ailedger.dev) · **Proxy:** [proxy.ailedger.dev](https://proxy.ailedger.dev)

---

## Three-layer architecture

AILedger is a substrate, not a logging tool. The unit of analysis is the **Decision Event**: one structured record per AI decision affecting a person.

**Layer 1: Integrity Chain.** Cloudflare Workers proxy at `proxy.ailedger.dev` plus a hash-chained Postgres ledger that wraps Decision Event records. Every record is hashed and chained to the previous; even internal admin database access cannot rewrite history; immutability is structural, not policy. Customers verify the integrity of any record in a single SQL call.

**Layer 2: Decision Event.** Postgres schema on Supabase EU region, one record per AI decision affecting a person. Captures `subject_id` (HMAC-pseudonymized with per-tenant salts; same person across decisions yields same `subject_id`, but the value is not reversible to PII), `inputs_hash` (SHA-256; raw inputs never stored), model version + weights hash, `decision_type` from a fixed taxonomy aligned with EU AI Act Annex III, `protected_class_context` with explicit collection-method tagging (direct / inferred / blind), confidence, `human_in_loop`, structured flag/required-action/actions-taken arrays. The schema makes the diff between `required_actions` and `actions_taken` queryable; that's the unresolved compliance gap.

**Layer 3: Detection.** Open-source under Apache 2.0 at [github.com/jakejjoyner/ailedger-detection](https://github.com/jakejjoyner/ailedger-detection). Standalone library that queries the Decision Event layer. Initial primitives: disparate-impact ratio (four-fifths-rule baseline per EEOC 29 CFR 1607), statistical parity difference, model drift across version transitions (PSI per Federal Reserve SR 11-7 + OCC 2011-12). Detection thresholds are set by standards; customers may tighten, never loosen.

---

## Regulatory anchors

| Regime | Articles / Standards | Status |
|---|---|---|
| Federal Rule of Evidence 707 (United States) | AI-generated evidence to Rule 702 admissibility standard | Approved Judicial Conference 2025; on track to take effect |
| EU AI Act (European Union) | Articles 12 (logging), 19 (deployer obligations), 26 (high-risk operator duties), 27 (FRIA), 50 (transparency), Annex III (high-risk categories) | Phased from 2026-08-02 (Article 50 transparency, GPAI provider duties, financial-sector high-risk) through 2027-12-02 (Annex III standalone high-risk) and 2028-08-02 (Annex I product-embedded), per the May 2026 Digital Omnibus |
| ISO/IEC 42001 | AI Management Systems | Standards-anchored |
| NIST AI RMF 1.0 | AI Risk Management Framework | Standards-anchored |
| GDPR Article 22 | Right to explanation for automated decisions | Compatible by design (subject pseudonymization + per-decision audit) |

---

## Charter

AILedger ships with a public Charter (v1.2) that names refused customer categories and refused feature categories in writing. Amendments require unanimous Board of Directors approval. Charter is published at [ailedger.dev/charter](https://ailedger.dev/charter).

Refusing customers and features is the product working as designed, not a missed-revenue problem.

---

## Quick start — Decision Event ingest (`@ailedger/sdk`)

```typescript
import { DetectionEventClient } from '@ailedger/sdk';

const client = new DetectionEventClient({
  apiKey: process.env.AILEDGER_API_KEY!,
  baseUrl: 'https://proxy.ailedger.dev',
  tenantId: process.env.AILEDGER_TENANT_ID!,
  systemId: process.env.AILEDGER_SYSTEM_ID!,
});

const result = await client.emit({
  event_id: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  decision_type: 'employment_screening',
  model_version: 'claude-opus-4-7',
  inputs_hash: await client.computeInputsHash(rawInputs),
  protected_class_context: { /* per Annex III taxonomy */ },
  confidence: 0.85,
  human_in_loop: false,
  flags: [],
  required_actions: [],
  actions_taken: [],
});

console.log(`Event committed at chain position: ${result.hash_chain_self}`);
```

Free tier available at [dash.ailedger.dev](https://dash.ailedger.dev). 10K Decision Events / month free; paid tiers for higher volume + dedicated support.

For audit-time inferred Decision Events (the 4-rung extraction ladder: parse / restructure / replay / perturb), see the `extractors/` module in `@ailedger/sdk`.

---

## Quick start — v1 proxy surface (legacy `inference_logs`)

The v1 inference-log proxy surface is still operational for early customers. New deployments should target the v2 `/v2/detection-events` substrate above.

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-openai-key",
    base_url="https://proxy.ailedger.dev/proxy/openai",
    default_headers={"x-ailedger-key": "your-ailedger-key"},
)

client.chat.completions.create(
    model="gpt-4.1-mini",
    messages=[{"role": "user", "content": "Hi"}],
)
```

v1 records hash-chained inferences in `ledger.inference_logs`. v2 substrate (above) is the recommended target for production deployments under high-risk AI regulatory obligations.

---

## Architecture

```
Producer (your app)
  │
  ├──> @ailedger/sdk emit(canonical DetectionEvent)
  │         │
  │         └──> POST proxy.ailedger.dev/v2/detection-events
  │                  │
  │                  ├──> auth (x-ailedger-key) + tenant-binding check
  │                  ├──> INSERT to ledger.decision_events (Postgres / Supabase EU)
  │                  │      │
  │                  │      └──> BEFORE INSERT trigger:
  │                  │              - canonical_hash() computes SHA-256 of canonicalized row
  │                  │              - hash_chain_prev = last row's hash_chain_self
  │                  │              - hash_chain_self = canonical_hash || hash_chain_prev
  │                  │              - per-tenant advisory lock prevents race
  │                  │
  │                  └──> return populated row (event_id, hash_chain_self)
  │
  │
Audit-time extractor (separate process)
  │
  ├──> read ledger.decision_events for inferred-extraction targets
  ├──> SDK extractors (parse / restructure / replay / perturb)
  │       │
  │       └──> POST /v2/detection-events with extractor_method + anchor_event_id
  │              │
  │              └──> INSERT inferred row (chain-extended; anchor preserved)
  │
  └──> Detection layer (Apache 2.0, [github.com/jakejjoyner/ailedger-detection](https://github.com/jakejjoyner/ailedger-detection))
        │
        └──> SELECT FROM ledger.decision_events;
             apply: disparate-impact ratio / parity / drift / etc.
             emit: alerts when thresholds breached
```

---

## Security model

### Hash-chain tamper-evidence (Layer 1)

Each `ledger.decision_events` row stores `hash_chain_prev` (hash of the previous row's contents) and `hash_chain_self` (hash of canonicalized current row plus `hash_chain_prev`), forming an append-only chain. Any modification to a historical row invalidates every subsequent hash. The `ledger.verify_chain()` function walks the chain and reports the first breakage.

The trigger uses a per-tenant `pg_advisory_xact_lock` so concurrent inserts within a tenant serialize; cross-tenant inserts proceed in parallel.

### Immutability

UPDATE and DELETE triggers raise exceptions on `ledger.decision_events` — even from `service_role`. Records are cryptographically and procedurally append-only.

### Per-tenant subject pseudonymization (Layer 2)

`subject_id` is HMAC-SHA256 of the customer-supplied subject identifier, salted with a per-tenant secret stored in `ledger.tenant_salts`. Same person across decisions in the same tenant yields the same `subject_id`; same person across tenants yields different `subject_id`s. The mapping is not reversible to raw PII without the per-tenant salt + the original raw identifier; raw PII never enters AILedger storage.

### Schema isolation

Decision Event data lives in the `ledger` schema, not `public`. RLS is forced: customers see only their own rows via `tenant_id` membership.

### No raw data retention

Only SHA-256 hashes of inputs and structured fields (protected_class context, flags, etc.) are stored. A hash proves a specific exchange occurred without retaining personal data. GDPR + Article 22 compatible by design.

### Tenant-bound API keys (v0.2.1)

API keys are stored as SHA-256 hashes. Each key is bound to a specific `tenant_id`; cross-tenant ingest via a stolen key is structurally blocked at the proxy ingest endpoint. Keys are revocable instantly via the dashboard.

### Secrets

Cloudflare Worker secrets store all infrastructure credentials. The repo contains zero hardcoded keys; `.env.local` and `.dev.vars` are gitignored.

---

## Repository layout

This is a monorepo.

| Directory | Purpose | Stack |
|---|---|---|
| `landing/` | Public marketing site (ailedger.dev) | Vite + React + TS, Cloudflare Pages |
| `dashboard/` | Customer dashboard (dash.ailedger.dev) | Vite + React + TS, Supabase Auth, Cloudflare Pages |
| `proxy/` | Cloudflare Worker (proxy.ailedger.dev): auth, v2 Decision Event ingest, v1 proxy forwarding, durable-buffer audit logging, KV caching | TypeScript, Cloudflare Workers |
| `sdk/` | `@ailedger/sdk` v0.2.0 producer SDK: Decision Event emission + 4-rung extractor ladder + Web Crypto API hashing + JCS canonicalization | TypeScript, ESM, Node 20+ |
| `redirect/` | Dumb redirect Worker (dashboard.ailedger.dev → dash.ailedger.dev) | TypeScript, Cloudflare Workers |

Detection layer (Apache 2.0) lives in a separate repo at [github.com/jakejjoyner/ailedger-detection](https://github.com/jakejjoyner/ailedger-detection):

| Repo | Purpose | Stack |
|---|---|---|
| [jakejjoyner/ailedger-detection](https://github.com/jakejjoyner/ailedger-detection) | Statistical detection primitives queryable against the Decision Event ledger | Python 3.10+, Apache 2.0 |

---

## Development

Prerequisites: Node.js 20+, Wrangler CLI (`npm install -g wrangler`), Cloudflare account (`wrangler login`), Supabase project (free tier works for development).

```bash
# Proxy (Cloudflare Worker)
cd proxy && npm install && npx wrangler dev

# SDK (TypeScript)
cd sdk && npm install && npm test

# Dashboard (Vite + React)
cd dashboard && npm install && npm run dev   # localhost:5173

# Landing (Vite + React)
cd landing && npm install && npm run dev     # localhost:5173
```

Proxy secrets (via `wrangler secret put`):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `POSTMARK_API_KEY`

Dashboard config (`dashboard/.env.local`):

```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
```

---

## Contributing

This is early-stage. Issues and PRs welcome, but expect the architecture to move until the v2 substrate stabilizes. Before large changes, please open an issue to discuss.

Areas where contributions are particularly welcome:

- Additional provider adapters for the v1 proxy surface (AWS Bedrock, Azure OpenAI, Cohere, Mistral)
- Detection primitives in `ailedger-detection` (additional statistical tests, EU AI Act Annex III-specific detectors)
- Compliance report templates for additional jurisdictions (UK AI Bill, Colorado AI Act, US state laws)
- Fuzz / integration tests for hash-chain integrity at scale
- Documentation improvements

---

## What this is NOT

AILedger does not certify compliance. We provide a substrate; compliance is the customer's work. We facilitate; we do not certify.

---

## License

This repo: MIT. Detection layer ([github.com/jakejjoyner/ailedger-detection](https://github.com/jakejjoyner/ailedger-detection)): Apache 2.0. Charter: public.

---

Contact: `ops@jvholdings.co`.
