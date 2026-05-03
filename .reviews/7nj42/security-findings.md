# Security Review

**Target:** `proxy/src/index.ts` (Cloudflare Worker — AILedger proxy + Stripe + Supabase signup hook)
**Leg:** security
**Reviewer:** ailedger/polecats/nitro

## Summary

The proxy worker has a sound overall security posture for the inference path: API
keys are hashed before lookup, the provider list is allowlisted, the customer ID
flows from authenticated state, and Stripe webhook signatures and Supabase JWTs
are verified before privileged action. Nothing in this file leaks the upstream
provider key, the Stripe secret key, the Supabase service key, or the webhook
secrets in error responses to the client.

The most serious issue is observability-related rather than code-injection
related: `handleSignupHook` logs the full Supabase payload and the constructed
magic link (which embeds `token_hash`) to `console.log`. In Cloudflare, those
log lines flow to wrangler tail / Logpush sinks and any retention pipeline,
making the logs themselves a copy of every signup/recovery verification token
and turning log-store access into account takeover. Beyond that, the two
HMAC signature verifiers (`verifyStripeSignature`, `verifyStandardWebhook`)
compare digests with `!==` / `===`, which is not constant-time, and the
Standard Webhooks verifier has no timestamp freshness check, leaving an open
replay window. Several lower-severity defense-in-depth gaps are listed below.

## Critical Issues

### C1. Magic-link `token_hash` and full signup payload logged to console — account takeover via log access
**File:** `proxy/src/index.ts:594`, `proxy/src/index.ts:603`, `proxy/src/index.ts:628`

```ts
// :594
console.log('Signup hook payload:', bodyText);
...
// :603
console.log('Signup hook parsed body:', JSON.stringify(body));
...
// :628
console.log(`signup-hook: email suppressed (action=${actionType}) for ${email}; magicLink=${magicLink}`);
```

`magicLink` is a fully-formed Supabase verify URL of the form
`${SUPABASE_URL}/auth/v1/verify?token=${tokenHash}&type=...&redirect_to=...`.
The raw `bodyText` log on line 594 is the unverified Supabase Send-Email-hook
payload, which (per Supabase Send-Email-Hook contract) contains
`email_data.token_hash` for signup, recovery, magiclink, email_change, and
invite flows.

**Impact:** Anyone with read access to Cloudflare Workers logs (wrangler tail
session, Logpush destination bucket, downstream SIEM, log retention archive)
can observe a verification token and consume it via the public Supabase
verify URL before the legitimate user clicks their email — that is, complete
the signup or password-recovery handshake on behalf of the user. Because the
email send path is currently disabled (Google-only directive, see comment on
:625), the only visible delivery channel for these tokens **is the log**, so
the blast radius is the entire signup/recovery population for as long as the
log is present.

This is a confidentiality breach of an authentication artifact and a
direct path to account takeover. The token has a single-use property but the
log captures it before consumption, so an attacker just needs to be faster
than the user (or there is no user, only the log entry).

**Suggested fix:**
- Remove `console.log` of `bodyText`, the parsed `body`, and `magicLink`.
  None of these belong in logs. If a debugging breadcrumb is needed, log only
  non-secret derived fields: `{ action: actionType, email_domain: email?.split('@')[1] }`.
- Treat `token_hash`, `email_data.*`, and the constructed magic link as
  secret material with the same handling rules as `STRIPE_SECRET_KEY`.
- Audit existing Cloudflare log destinations and rotate / purge any retained
  logs that contain prior signup-hook output.

## Major Issues

### M1. Non-constant-time signature comparison in both webhook verifiers
**File:** `proxy/src/index.ts:363`, `proxy/src/index.ts:586`

```ts
// :363  Stripe
if (computed !== v1) return null;
...
// :586  Standard Webhooks (Supabase signup hook)
return msgSignature.split(' ').some(s => s === computedSig);
```

Both comparisons short-circuit on the first differing byte, so the runtime
correlates with the length of the matching prefix. A network-positioned
attacker that can request many webhook deliveries (or a target that accepts
attacker-provided payloads at the same endpoint) can use the response time
to recover the HMAC byte-by-byte. Cloudflare's network jitter raises the
sample count required but does not eliminate the side channel.

**Impact:** Forgery of Stripe webhook events (entitlement / plan flip via
crafted `customer.subscription.updated`) and forgery of Supabase signup-hook
events (would be more impactful once the email-send path returns and any
side effects are wired to that endpoint).

**Suggested fix:** Constant-time compare. In Workers, decode both sides to
`Uint8Array` of equal length and compare with the standard timing-safe
pattern:

```ts
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
```

Use it on the raw HMAC bytes (skip the hex/base64 round-trip on the
hot path).

### M2. Standard Webhook verifier has no timestamp freshness check — unbounded replay window
**File:** `proxy/src/index.ts:568–590`

`verifyStripeSignature` correctly rejects events older than 5 minutes
(`:366`). `verifyStandardWebhook` reads `webhook-timestamp` into
`msgTimestamp` only to fold it into the signed string and never validates
it. A captured signed signup-hook delivery can be replayed indefinitely.

**Impact:** Any logged or captured signup-hook delivery can be re-sent to
`/auth/signup-hook` arbitrarily often. Today the handler only logs and
returns `{ ok: true }`, so this is latent — but as soon as the email-send
path returns (per the comment on :625), replay = re-trigger of email send /
side-effects with a stale token. Combined with C1, captured logs become
replayable.

**Suggested fix:** After computing signature equality, parse `msgTimestamp`
as seconds-since-epoch and reject if `Math.abs(Date.now()/1000 - ts) > 300`,
matching the Stripe handler.

### M3. `checkUsageLimit` fails open on Supabase errors — cost-amplification DoS
**File:** `proxy/src/index.ts:679`

```ts
if (!countRes.ok) return false; // fail open
```

On any Supabase outage or REST error (rate limit, transient 5xx, schema
hiccup), every free-tier customer's monthly cap is silently disabled and
the proxy will forward unlimited inference requests to OpenAI / Anthropic /
Gemini, billed to the provider account behind `STRIPE_SECRET_KEY` /
upstream API key. An attacker who can degrade the Supabase REST endpoint
(or who notices an existing outage) can drive arbitrary spend.

**Impact:** Direct financial loss proportional to upstream provider costs
during the failure window. This is the highest blast-radius failure mode
for the proxy.

**Suggested fix:** Fail closed with a soft signal — return `true`
(limit-hit) on REST error, or use a short KV-side breaker that allows N
requests/minute per customer when the count endpoint is unreachable. At a
minimum, alert on this branch: `console.error('checkUsageLimit:
count-query-failed', { customerId, status: countRes.status })` so the
fail-open path is observable.

### M4. API key revocation lag — KV cache holds revoked keys for 5 minutes
**File:** `proxy/src/index.ts:526–550`

```ts
const cached = await env.AILEDGER_CACHE.get(cacheKey, 'json') as ...;
if (cached) return cached;
...
ctx.waitUntil(env.AILEDGER_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 300 }));
```

A revoked or rotated API key continues to authenticate inferences for up
to 5 minutes per Cloudflare PoP that has it cached. There is no
invalidation hook from the dashboard / `api_keys` table back to KV.

**Impact:** A leaked key cannot be revoked instantaneously. For an
audit-grade product whose value proposition is provenance, a 5-minute
window of attacker-controlled inferences after revocation is meaningful.

**Suggested fix:** Either (a) drop the TTL to 30–60s, or (b) on the
revocation path in the dashboard / Supabase trigger, write a tombstone
to KV (`revoked:${keyHash} = "1"`) that `resolveApiKey` checks before
returning the cached value, or (c) on revoke, `KV.delete(cacheKey)`
across all relevant keys. A tombstone is most defensible because
`KV.delete` from a different worker may race the cache fill.

## Minor Issues

### m1. PostgREST query values are interpolated, not encoded
**File:** `proxy/src/index.ts:279`, `:532`, `:641`, `:666`

```ts
`${env.SUPABASE_URL}/rest/v1/api_keys?key_hash=eq.${keyHash}&select=...`
`${env.SUPABASE_URL}/rest/v1/subscriptions?supabase_user_id=eq.${user.id}&select=...`
`${env.SUPABASE_URL}/rest/v1/inference_logs?customer_id=eq.${customerId}&...`
```

`keyHash` is a hex SHA-256 (safe). `user.id` and `customerId` come from
authenticated sources (Supabase JWT and the api_keys row), expected to be
UUIDs. Today there is no exploit path, but the pattern relies on
upstream invariants — if a non-UUID value ever lands in `customer_id`,
PostgREST query injection (e.g., `&select=*` to widen returned columns,
or operator-swap from `eq.` to `in.`) would become possible.

**Suggested fix:** `encodeURIComponent` the interpolated value, or build
with `URLSearchParams` and set `key_hash=eq.${value}` after construction.

### m2. Path traversal characters not normalized before forwarding
**File:** `proxy/src/index.ts:108–114`

```ts
let upstreamPath = match[2] ?? '/';
...
const upstreamUrl = `${upstreamBase}${upstreamPath}${url.search}`;
```

`match[2]` from the regex `/^\/proxy\/([^\/]+)(\/.*)?$/` allows anything
after the provider slug, including `..`, `%2e%2e`, double slashes, and
fragments. Cloudflare's `fetch` will normalize most of this, but the
exact behavior under `%2e%2e` is up to the upstream. Combined with
`url.search`, a request like `/proxy/openai/../v1/admin?` would
construct `https://api.openai.com/../v1/admin?` and rely on URL parsing
to do the right thing.

**Suggested fix:** Validate `upstreamPath` against a permissive but
finite regex (e.g., `/^\/[A-Za-z0-9._\-\/:]+$/`) before composing the
upstream URL, and reject anything containing `..` or `%2e%2e`. Cheap
defense-in-depth for an issue that is mostly upstream-mitigated today.

### m3. Inbound `Authorization` header is forwarded as-is to upstream
**File:** `proxy/src/index.ts:120–127`

`filterHeaders` drops `host`, CF-internal headers, `x-ailedger-key`, and
SDK telemetry headers, but leaves `Authorization` intact. This is
intentional for transparent proxying (the customer's `OPENAI_API_KEY`
must reach OpenAI), but it also means any `Authorization` value the
caller chose is passed through. There is no enforcement that the key
attached to the inbound request belongs to the AILedger customer — i.e.,
the platform pays nothing for upstream costs but also does not constrain
which upstream account is charged. Likely by design. Worth a one-line
comment on the design choice so a future reader doesn't "tighten" it.

### m4. Supabase webhook payload is logged in full
**File:** `proxy/src/index.ts:594`, `:603`

Even if C1 (magic-link logging) is fixed, the full body log still
contains user email, name, and Supabase user metadata — PII that flows
to the same log sinks. Drop these logs entirely or redact to non-PII
fields.

### m5. No event-ID idempotency on Stripe webhook
**File:** `proxy/src/index.ts:374–407`

`processStripeEvent` is idempotent in effect (PostgREST upsert on
`stripe_subscription_id`), but does not dedupe by `event.id`. A replayed
old event within the 5-minute timestamp window can re-flip a subscription
state. Combined with the lack of event ordering guarantees from Stripe,
an old `customer.subscription.deleted` arriving after a new
`checkout.session.completed` would set status back to `canceled`.

**Suggested fix:** Track processed event IDs in KV
(`stripe:event:${id}` with 7-day TTL) and skip if already seen, or
order by `event.created` if rebuilding state.

### m6. Subscription metadata is read from `customer.subscription.updated/deleted`
**File:** `proxy/src/index.ts:391–392`, `:401–402`

Subscription `metadata` is server-controlled (set by your code at
checkout creation, line 225), and Stripe only changes it via authorized
calls, so this is not user-forgeable. But on a webhook for a
subscription that was created outside of `handleCreateCheckoutSession`
(e.g., manually via Stripe dashboard, or via a future code path),
`metadata.supabase_user_id` may be missing — and the upsert would write
NULL, severing the link. Today this is benign; flagging for awareness.

### m7. No request body size limit before `arrayBuffer()`
**File:** `proxy/src/index.ts:117`, `:141`

`request.body` is read into memory wholesale, as is `upstreamResponse`.
Cloudflare Workers have a hard memory cap (~128 MB in standard tier),
which provides a backstop, but a deliberately large body still wastes
CPU/memory budget. Consider gating with `Content-Length` and rejecting
above, e.g., 25 MB.

### m8. `STRIPE_SECRET_KEY` printed via `console.error` indirectly is unlikely but worth noting
**File:** `proxy/src/index.ts:240`, `:310`, `:438`, `:776`

`console.error` calls log Stripe / Supabase response bodies. These
endpoints don't echo secrets back today, but a future Stripe error mode
that includes a portion of the request would land in logs. Consider
limiting the log to `status + a generic message` and routing the
detailed body to a sampled error channel.

## Observations

- **Defense-in-depth that is already done correctly** — provider allowlist
  (`PROVIDERS`), customer ID derived from authenticated lookup (never from
  request input), webhook secrets sourced from `env`, no `eval` /
  `new Function` / dynamic require, no SQL string concatenation (PostgREST
  is the layer), no plaintext API key in DB (only SHA-256 hash), CORS
  pinned to `https://dash.ailedger.dev` (no wildcard).
- **API key hash is unsalted SHA-256** (`:523`). For a 256-bit random token
  with the `agl_sk_` prefix this is fine in practice — brute force needs
  ~2^128 work — but the pattern is non-standard. HMAC-SHA-256 with a
  server-side pepper (an additional Worker secret) raises the bar against
  a future DB exfiltration where an attacker also knows the keyspace.
  Optional hardening, not a vulnerability.
- **`paid:${customerId}` cache TTL of 5 minutes** (`:655`) means a customer
  whose subscription becomes `canceled` keeps `isPaidCached === 'true'` for
  up to 5 minutes per PoP. Symmetric to M4; same fix shape (tombstone or
  delete on webhook).
- **`upstreamResponse.headers` is echoed back unchanged** (`:167`),
  including any upstream `Set-Cookie` or `Strict-Transport-Security`
  directives. For a transparent proxy this is the right default;
  worth confirming no upstream sets a cookie scoped to `ailedger.dev`.
- **`request.json()` calls in `handleCreateCheckoutSession` and the
  body-parse in `handleSignupHook` are unguarded.** Malformed JSON
  throws and surfaces as a 500 with the Worker's default error page.
  Consider a try/catch returning 400 to keep error responses consistent.
- **`scheduled` handler is empty** (`:33`). Confirm `wrangler.toml`
  doesn't still have a cron trigger pointing at it that fires on a tight
  schedule for no work — minor cost / log-noise issue, not security.
