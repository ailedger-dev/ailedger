# Test Quality Review

## Summary

The proxy package has two test files: `proxy/test/jcs.spec.ts` (271 lines) and
`proxy/test/index.spec.ts` (60 lines). Quality is sharply asymmetric.

`jcs.spec.ts` is genuinely strong: it tests RFC 8785 invariants as properties
(key reordering, whitespace insensitivity, numeric normalization, nested
permutation), uses negative assertions to confirm distinguishability
(`a !== c`), exercises every fallback branch in `sha256jcs` (invalid UTF-8,
lone continuation byte, unterminated string, malformed JSON), and includes a
contract check against the upstream `canonicalize` library. A bug in any of
the JCS branches would almost certainly cause one of these tests to fail.

`index.spec.ts` is the opposite. It exercises ~5% of `proxy/src/index.ts`:
`/health`, an unmatched 404, and two early-exit branches of `/proxy/<provider>`
auth. The other ~95% — Stripe checkout, billing portal, Stripe webhook
signature verification, the Supabase signup-hook signature verification, the
actual proxy forwarding behavior, header filtering, OpenAI `/v1` path
normalization, the KV-cache fallthrough in `resolveApiKey`, the
`checkUsageLimit` quota logic, the dispatch in `processStripeEvent`, and the
async `logInference` write — has zero tests. Two of the security-critical
gaps (`verifyStripeSignature`, `verifyStandardWebhook`) are HMAC verification
routines whose silent failure modes (returning `null` / `false` from the
`catch`) would be invisible without negative tests.

## Critical Issues
(P0 — Must fix before merge)

### C1. Stripe webhook signature verification has no tests
- **File:** `proxy/src/index.ts:339-372` (`verifyStripeSignature`)
- **Impact:** This is the only thing standing between an attacker and forged
  subscription state-changes (`processStripeEvent` writes directly to
  `subscriptions` on signature pass). The function has at least 5 failure
  branches (missing `t`/`v1` parts, HMAC mismatch, >5min replay window,
  malformed payload JSON via `catch`). None are exercised.
- **Suggested fix:** Add unit tests against `verifyStripeSignature` (export it
  if not already, or test through `/webhook/stripe`):
  - Valid signature + fresh timestamp → returns parsed event
  - Valid signature + timestamp >300s old → returns `null` (replay rejection)
  - Tampered payload (signature was for original) → `null`
  - Missing `stripe-signature` header → 400 from handler
  - Malformed signature header (no `t=` or `v1=`) → `null`
  - Unparseable JSON payload after valid signature → `null` (the `catch`
    branch on line 369 — currently dead from the test's POV)

### C2. Supabase signup-hook signature verification has no tests
- **File:** `proxy/src/index.ts:568-590` (`verifyStandardWebhook`)
- **Impact:** Same severity as C1 — `handleSignupHook` proceeds to log/return
  200 only after this check; a flipped boolean here silently disables auth.
  The base64 secret parsing (`secret.replace(/^v1,whsec_/, '')`) and the
  space-separated multi-signature comparison
  (`msgSignature.split(' ').some(...)`) are subtle and easy to break.
- **Suggested fix:** Tests for: valid single signature, valid signature among
  multiple space-separated ones, tampered body, missing headers (`webhook-id`,
  `webhook-timestamp`, `webhook-signature` default to `''` — confirm rejection),
  malformed base64 secret (the `catch` returns `false`).

### C3. Core proxy forwarding behavior is untested
- **File:** `proxy/src/index.ts:69-169`
- **Impact:** The product *is* the proxy. Tests cover only the auth shortcut
  rejections. There is no test that:
  - A valid `x-ailedger-key` results in an upstream fetch with the body and
    method preserved
  - `filterHeaders` strips `x-ailedger-key`, `cf-*`, `user-agent`, and every
    `x-stainless-*` header (regression risk: OpenAI abuse-detection bug
    documented in the comment at lines 120-122)
  - OpenAI path normalization adds `/v1` only when missing
    (`index.ts:111-113`) — both branches matter
  - The 429 quota response is returned when `checkUsageLimit` is true
  - `ctx.waitUntil` receives the `logInference` promise (i.e., logging fires)
- **Suggested fix:** With `vitest-pool-workers` you can stub upstream `fetch`
  via `cloudflare:test`'s service binding or MSW. Add at minimum: one happy-
  path forwarding test per provider with a stubbed upstream that asserts the
  request URL, method, body, and absence of stripped headers; one
  `/v1`-normalization test (request without `/v1` → upstream got `/v1/...`);
  one quota-exceeded test (KV pre-seeded so `checkUsageLimit` returns true);
  one invalid-key test (`resolveApiKey` returns null → 401 with `"Invalid API
  key"` body).

## Major Issues
(P1 — Should fix before merge)

### M1. `processStripeEvent` dispatch is untested
- **File:** `proxy/src/index.ts:374-407`
- **Impact:** Three separate event types (`checkout.session.completed`,
  `customer.subscription.updated`, `customer.subscription.deleted`) each
  pull different fields off `data` and call `upsertSubscription` with
  different statuses. A regression that swaps `status: 'canceled'` for
  `'active'` on delete (or vice-versa) would silently keep canceled
  customers paid. No test would catch it.
- **Suggested fix:** Spy on `fetch` (or stub the Supabase REST endpoint) and
  assert the upserted row body for each event type, including the metadata
  → `supabase_user_id` / `plan` extraction.

### M2. `checkUsageLimit` boundary and fail-open behavior are untested
- **File:** `proxy/src/index.ts:633-684`
- **Impact:** The 10,000/month free-tier threshold (`return total >= 10_000`)
  is a load-bearing business rule. The function also fails *open* when
  Supabase is down (`if (!countRes.ok) return false;` at line 679) — a
  legitimate design choice, but one that should be pinned by a test so
  someone doesn't "fix" it to fail closed and break paying customers
  during a Supabase incident. The KV `paid:` cache hit path (line 637)
  is also untested.
- **Suggested fix:** Three tests minimum: total = 9,999 → false; total =
  10,000 → true; `countRes.ok = false` → false (fail-open contract).
  Also: `paid:<id>` KV hit returns immediately without calling Supabase.

### M3. `resolveApiKey` cache + last-used-update logic is untested
- **File:** `proxy/src/index.ts:522-566`
- **Impact:** This function fans out two `ctx.waitUntil` writes (KV cache
  put, Supabase PATCH). A regression that drops the KV cache write would
  silently destroy cache hit rate and quintuple Supabase load — invisible
  to current tests. The cache-hit fast-path (line 528-529) is also a
  correctness boundary: a stale cached value would let a revoked key keep
  working for up to 5 minutes.
- **Suggested fix:** Pre-seed `AILEDGER_CACHE` with a `key:<hash>` entry,
  call the worker, assert Supabase was *not* hit. Then a cold-cache test
  that asserts both `waitUntil` writes occur.

### M4. Asymmetric assertion strength between the two auth tests
- **File:** `proxy/test/index.spec.ts:49-58`
- **Impact:** The "missing key" test (lines 37-47) checks both status *and*
  the JSON error body. The "unknown provider" test only checks status. A
  regression that returned 400 with an empty body, or with a different
  message, wouldn't be caught. Inconsistent assertion depth makes test
  intent ambiguous.
- **Suggested fix:** Make both tests assert the body shape (the worker
  returns `'Unknown provider: bogus'` as plain text — assert it).

## Minor Issues
(P2 — Nice to fix)

### Mi1. Duplicate `/health` test offers little marginal value
- **File:** `proxy/test/index.spec.ts:12-27`
- The unit-style and integration-style tests assert the exact same thing.
  Either prune one, or differentiate them — e.g., the integration test
  could assert the `Content-Type: application/json` response header
  (currently *unverified anywhere*, and the worker explicitly sets it on
  line 45).

### Mi2. No test asserts response `Content-Type` headers
- **File:** `proxy/test/index.spec.ts` (all tests)
- Every JSON-returning handler manually sets `Content-Type: application/json`.
  None of the tests check this. A regression that drops the header would let
  browsers/SDKs misinterpret the body but every test would still pass.

### Mi3. The 10k-keys JCS stability test is a property-test in disguise
- **File:** `proxy/test/jcs.spec.ts:254-270`
- This test is good but slow-ish (~10k JSON.stringify iterations + 2 hashes).
  Consider trimming to 1k keys; the property holds at any size and the
  failure mode is the same. Minor — does not affect correctness.

### Mi4. `logInference` model-name extraction has untested branches
- **File:** `proxy/src/index.ts:727-740`
- The Gemini URL-path regex extraction (`/\/models\/([^:\/]+)/`) and the
  `JSON.parse` `try/catch` for the request body are both untested. Low
  blast-radius (model name is metadata, not security), hence P2.

## Observations

- **No flaky-test indicators present.** No `sleep`, no real timers, no
  `Date.now()` assertions, no network calls. Good.

- **No "test that can't fail" antipatterns** in the existing tests. Every
  assertion in `jcs.spec.ts` and `index.spec.ts` is concrete enough that a
  bug would surface. The problem is purely *missing* tests, not weak ones.

- **`vitest-pool-workers` is already wired up** (`vitest.config.mts` exists,
  `cloudflare:test` is imported). The infrastructure to write the missing
  tests in C3/M1/M2/M3 is already in place — this is not a "we need a new
  test framework" situation, it is a "the tests were never written"
  situation.

- **Two functions are exported solely for testability** (`sha256jcs`,
  `isJsonContentType`) but the route handlers are not. To address C1, C2,
  M1 cleanly, either export those handlers or test them through
  `SELF.fetch(...)` with stubbed upstreams. The latter is closer to
  integration and more durable to refactor.

- **`vitest.config.mts` and `wrangler.jsonc` were not reviewed** for env-
  binding test fixtures (KV namespace, secrets). If they are unset in the
  test environment, several of the gap-filling tests above will need
  fixture wiring before they can be added.
