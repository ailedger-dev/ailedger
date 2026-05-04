> ⚠ **DEPRECATED 2026-04-30** — Per Jake universal directive, the email stack is now **Google only**. Brevo and Resend are being ripped out (account closures pending). Do NOT follow any setup steps in this document that reference Brevo, Resend, or any non-Google email relay. The Gmail-API replacement runbook supersedes this. See `~/gt-lab/memory/feedback_email_stack_google_only.md`.

---

# AILedger

> **You built the AI. We prove it behaved.**

Open-source AI inference logging infrastructure for EU AI Act Article 12 compliance. A drop-in proxy that records every AI call as an immutable, tamper-evident audit record — without storing your prompts or outputs.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**Live:** [ailedger.dev](https://ailedger.dev) · **Dashboard:** [dash.ailedger.dev](https://dash.ailedger.dev) · **Docs:** [ailedger.dev/docs](https://ailedger.dev/docs)

---

## What it does

AILedger sits transparently between your application and your AI provider (OpenAI, Anthropic, Gemini, or any OpenAI-compatible API). Every inference is durably logged with:

- SHA-256 hash of the input
- SHA-256 hash of the output
- Model name, provider, latency, status code, timestamps (start + completion)
- Hash-chained into an append-only ledger — each entry references the previous entry's hash, making tampering detectable

Raw prompts and outputs are **never** stored. Only cryptographic fingerprints.

When a regulator asks, you generate an Article 12 compliance report (PDF) with the full inference history, hash-chain verification, and metadata.

## Why open source

Compliance tooling runs on trust. You should be able to read the code that generates your audit trail. Every hashing step, every database constraint, every tamper-evidence mechanism is in this repo — audit it, fork it, run it yourself.

## Quick start (customer integration)

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-openai-key",
    base_url="https://proxy.ailedger.dev/proxy/openai",
    default_headers={"x-ailedger-key": "your-ailedger-key"},
)

# Use as normal — every call is now logged.
client.chat.completions.create(
    model="gpt-4.1-mini",
    messages=[{"role": "user", "content": "Hi"}],
)
```

Get a free AILedger key at [dash.ailedger.dev](https://dash.ailedger.dev).

## Architecture

```
Your App  ──>  proxy.ailedger.dev/proxy/<provider>  ──>  OpenAI / Anthropic / Gemini
                           │  (1) sync durable commit to KV write-buffer
                           │  (2) async drain to Postgres via waitUntil
                           │  (3) scheduled drain every 5 min for stragglers
                           ▼
                   ledger.inference_logs (Supabase, EU region)
                           │
                           ▼
                  ledger.verify_chain() ← regulator audit
```

The proxy durably commits the audit intent to a Cloudflare KV write-buffer (~10ms) before returning the upstream response. The Postgres ingest then happens in `ctx.waitUntil()` and a scheduled drain catches any entries that fail the immediate ingest — your application never waits on Postgres, and audit records survive transient database unavailability.

## Repository layout

This is a monorepo.

| Directory | Purpose | Stack |
|---|---|---|
| [`landing/`](./landing) | Public marketing site (`ailedger.dev`) | Vite + React + TS, Cloudflare Pages |
| [`dashboard/`](./dashboard) | Customer dashboard (`dash.ailedger.dev`) | Vite + React + TS, Supabase Auth, Cloudflare Pages |
| [`proxy/`](./proxy) | Interceptor Worker (`proxy.ailedger.dev`) — auth, forwarding, durable-buffer audit logging, KV caching | TypeScript, Cloudflare Workers |
| [`redirect/`](./redirect) | Dumb redirect Worker (`dashboard.ailedger.dev` → `dash.ailedger.dev`) | TypeScript, Cloudflare Workers |

## Security model

### Hash-chain tamper-evidence
Each `ledger.inference_logs` row stores `prev_hash` = hash of the previous row's contents, forming an append-only Merkle-like chain. Any modification to a historical row invalidates every subsequent hash. The `ledger.verify_chain()` function walks the chain and reports the first breakage.

### Immutability
`UPDATE` and `DELETE` triggers raise exceptions on `ledger.inference_logs` — even from `service_role`. Records are cryptographically and procedurally append-only.

### Schema isolation
Inference data lives in the `ledger` schema, not `public`. RLS is forced: customers see only their own rows via `customer_id = auth.uid()`.

### No raw data retention
Only SHA-256 hashes of inputs/outputs are stored. A hash proves a specific exchange occurred without retaining personal data — Article 12 + GDPR compatible by design.

### Secrets
Supabase service role credentials are stored as Cloudflare Worker secrets. The repo contains zero hardcoded keys — `.env.local` and `.dev.vars` are gitignored.

### API key storage
Customer keys (`ail_sk_...`) are stored as SHA-256 hashes. Raw keys are shown once on creation and never persisted. Keys are revocable instantly.

## Article 12 mapping

| Article 12 requirement | Implementation |
|---|---|
| Automatic logging throughout lifetime | Every proxied call durably committed to the KV write-buffer before response, then drained to the ledger — survives transient DB unavailability |
| Tamper-evident records | SHA-256 hash chain + database-level immutability triggers |
| Traceability to specific inputs/outputs | Per-call hash, verifiable against customer-held raw data |
| Identification of persons responsible | Per-customer API keys scoped to "systems" (your AI products) |
| Minimum retention | Append-only, indefinite by default |
| Periodic auditing | `ledger.verify_chain()` + one-click PDF compliance report |

See [ailedger.dev/guide/annex-iii](https://ailedger.dev/guide/annex-iii) for help classifying your AI system under Annex III.

## Development

### Prerequisites
- Node.js 20+
- Wrangler CLI (`npm install -g wrangler`)
- Cloudflare account (authenticated via `wrangler login`)
- Supabase project (free tier works)

### Run it

```sh
# Proxy (Cloudflare Worker)
cd proxy && npm install && npx wrangler dev

# Dashboard (Vite + React)
cd dashboard && npm install && npm run dev        # localhost:5173

# Landing page (Vite + React)
cd landing && npm install && npm run dev          # localhost:5173
```

### Environment

**Proxy** — secrets via `wrangler secret put`:
```sh
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put RESEND_API_KEY
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
```

**Dashboard** — `dashboard/.env.local`:
```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
```

## Contributing

This is early-stage. Issues and PRs welcome, but expect the architecture to move until the core data model stabilizes. Before large changes, please open an issue to discuss.

Areas where help is welcome:
- Additional provider adapters (AWS Bedrock, Azure OpenAI, Cohere, Mistral)
- Compliance report templates for other jurisdictions (UK AI Regulation, Colorado AI Act)
- Fuzz/integration tests for hash-chain integrity
- Documentation improvements

## License

[MIT](./LICENSE) — free to use, fork, and run yourself.
