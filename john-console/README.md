# John Console — Pasha's session-entry dashboard

**Status:** MVP scaffold (2026-04-18). Not yet deployed.
**Target domain:** `sales.ailedger.dev`
**Purpose:** the web UI Pasha logs into at contractor onboarding. Chat interface with John (the sub-town Mayor persona). No shell access, no raw API keys, contractor never sees filesystem.

## Architecture

```
Pasha's browser
    │
    ↓ (HTTPS)
sales.ailedger.dev  ── Cloudflare Worker (this repo)
    │
    ├── serves static index.html (chat UI)
    └── POST /chat → authenticates session → proxies to AILedger inference
                                                    │
                                                    ↓
                                            proxy.ailedger.dev/proxy/anthropic
                                                    │
                                                    ↓
                                            api.anthropic.com (logged to ledger)
```

Every chat turn:
1. Worker loads John's system prompt (this repo: `john-persona.md`).
2. Assembles the conversation (system + prior turns + new user message).
3. POSTs to `proxy.ailedger.dev/proxy/anthropic/v1/messages` with the AILedger dogfood key + Jake's Anthropic key.
4. Returns the response to the browser.
5. Every inference auto-logs to the AILedger ledger — first real external customer-shaped traffic on the dogfood tenant.

## Files

- `index.html` — static chat UI, single-page, zero build step.
- `worker.js` — Cloudflare Worker (routes `/chat` to Anthropic via AILedger proxy, serves static `/` and `/index.html`).
- `john-persona.md` — John's system prompt (canonical). Read at worker cold-start, cached.
- `wrangler.jsonc` — deploy config (custom domain `sales.ailedger.dev`).
- `public/` — assets served statically (the HTML goes here).

## Auth posture (MVP → production)

**MVP (Jake-local test):** no auth. Anyone who hits the URL can chat. This is fine for initial iteration before it's live on DNS.

**Production (before Pasha touches it):**
- Mailbox SSO via magic-link: contractor enters their `@ailedger.dev` mailbox, worker sends a sign-in link, link carries a short-lived session cookie.
- 2FA on the mailbox (already required per onboarding runbook §1.B).
- Session cookie scoped to the contractor's `system_id` so every /chat POST carries their scoped AILedger key, not a shared one.
- Pre-launch blockers captured in follow-up bead: DNS provisioning, Resend/Brevo sender config, session-store (Cloudflare KV), rate-limit per session.

## Session persistence

Conversation history survives page refresh via Cloudflare KV + an httpOnly session cookie.

- First `/chat` POST: worker mints a session UUID, sets `jc_session` cookie (`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=30d`), stores `{ messages, updatedAt }` in the `SESSIONS` KV namespace.
- Each subsequent `/chat` POST rewrites the KV entry with `expirationTtl=30d` — rolling TTL, idle sessions expire 30 days after last activity.
- `GET /session` → `{ sessionId, messages }`. The browser calls this on page load and rehydrates the conversation. Missing/stale cookie → empty response + cleared Set-Cookie.
- `POST /session/new` deletes the KV entry and clears the cookie. UI triggers this from the "new session" button with a confirm dialog.

Single-device only by design — multi-device sync is deferred until magic-link auth lands.

## Deploy (when ready)

```
cd john-console
# One-time: provision the KV namespace and paste its id into wrangler.jsonc.
wrangler kv namespace create SESSIONS

wrangler deploy
# DNS: add CNAME sales.ailedger.dev → <worker-default-url>
# Secrets: wrangler secret put AILEDGER_KEY; wrangler secret put ANTHROPIC_API_KEY
```

## Non-goals (MVP)

- No streaming responses. Just request-response for the first cut; SSE upgrade when UI needs it.
- No CRM / Apollo / Brevo integration from the UI. John can recommend actions, contractor takes them in the respective SaaS tab.
- No attachments / file upload. Text-in, text-out.

## Follow-ups (beads to file)

1. DNS: `sales.ailedger.dev` → worker custom domain.
2. Auth: mailbox SSO magic-link via Resend.
3. Rate limiting per session.
4. First-contact dry-run script (Jake + Pasha + John round-trip once).

## Provenance

Scaffolded by Bob 2026-04-18 on Jake's directive ("start building pasha's dashboard"). John's D.1 section of `docs/sub-town/04-onboarding-offboarding-runbook.md` describes the operational flow this implements. Pasha's welcome doc at `~/Downloads/pasha-welcome-2026-04-18.pdf` promises him this URL.
