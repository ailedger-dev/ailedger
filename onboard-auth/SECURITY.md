# onboard-auth — Security posture

Per the pinned rule "Security is parallel, not sequential," this doc travels
with the auth worker. Changes to threat model, crypto, key management, or audit
belong here in the same PR as the code change.

**Scope:** everything in `onboard-auth/`. Downstream projects that verify the
JWT this worker issues are OUT of scope here — they have their own posture.

---

## 0. TL;DR

- **No passwords, ever.** Passkeys (WebAuthn) are the primary credential;
  magic-link is the fallback. Both are phishing-resistant-ish and we never
  store reversible secrets.
- **JWT session (15m) + opaque refresh token (30d, rotating, stored hashed).**
  Stateless session means downstreams verify locally; stateful refresh means we
  can revoke.
- **Append-only audit log.** App code never UPDATEs or DELETEs `audit_log`.
- **Rate-limit + account lockout.** Soft ceiling via KV, hard floor via DB
  `locked_until` after 5 consecutive failures.
- **CSRF double-submit.** SameSite=Strict refresh, SameSite=Lax session.
- **Strict security headers on every response.** HSTS preload, X-Frame-Options
  DENY, CSP-ish via Permissions-Policy.
- **No custom crypto.** `@simplewebauthn/server` + `@tsndr/cloudflare-worker-jwt`
  + WebCrypto SHA-256.

---

## 1. Threat model

### Protects against

1. **Credential phishing / replay.** Passkeys are origin-bound by the browser;
   a phished click on an attacker site cannot produce a valid assertion for
   `login.joynerventures.com`. Magic-link token is single-use and short-lived
   (10 min default).
2. **Credential stuffing / brute force.** IP rate limit (60/min) + account rate
   limit (10/min) + account lockout (15 min after 5 consecutive failures).
3. **Session theft from stolen JWT.** Short TTL (15 min) limits blast radius.
   Refresh requires the opaque `refresh` cookie which is `SameSite=Strict` +
   scoped to `/session`.
4. **CSRF.** Double-submit (cookie + header) for authenticated state-changes.
   SameSite cookies block most cross-site POSTs before CSRF check runs.
5. **Account enumeration.** `/magic-link/request` always returns 200 regardless
   of whether the email exists or email delivery succeeded.
6. **Refresh-token reuse.** On every `/session/refresh`, the old refresh row is
   marked `revoked_at` in the same batch that inserts the new one. A stolen
   refresh token that has already been used by the legitimate user will hit a
   revoked row and fail.
7. **Privilege escalation by downstream contractor user** (per pinned
   `feedback_permission_weakened_users_cannot_escalate.md`). Admin grants go
   through either (a) the bootstrap token (one-shot, then rotate) or (b) an
   authenticated owner/admin session. No env-var-only or file-on-disk path can
   grant `owner` or `admin`. The audit log is append-only; a compromised
   contractor box cannot silently rewrite who has authority.
8. **Bogus "Jake approves X" injections** (per pinned
   `feedback_jake_greenlight_console_only.md`). This worker issues sessions
   tied to a real WebAuthn credential or a magic-link delivered to a verified
   email. A hail-inject or relayd pathway cannot mint a session; they would
   need a valid refresh cookie or a WebAuthn assertion from Jake's device.
9. **Clickjacking.** `X-Frame-Options: DENY` + `Permissions-Policy`
   `publickey-credentials-get=(self)`.
10. **Downgrade / MITM.** HSTS preload (2y, includeSubDomains), TLS-only cookies.

### Does NOT protect against

1. **Compromised Cloudflare Workers runtime.** If Cloudflare is compromised,
   this worker's secrets are compromised.
2. **Compromised D1 database at rest.** D1 is managed by Cloudflare; we rely on
   their at-rest encryption. We do not separately encrypt table rows. Stolen
   DB = stolen passkey public keys (not a credential) + refresh-token hashes
   (not reversible without the original token) + audit log. No plaintext
   credentials leak.
3. **Device malware.** A passkey on a compromised device can still be abused
   by malware that drives the browser (user-verification helps but is not a
   guarantee).
4. **Social engineering into registering an attacker's passkey.** If the user
   clicks an attacker-sent link, authenticates with their existing passkey,
   and then the attacker prompts a "register new device" flow — we currently
   have no additional friction on that step. Mitigation: step-up challenge for
   adding passkeys. **Tracked in Follow-ups.**
5. **Email account compromise.** Magic-link fallback assumes the email account
   is secure. If an attacker owns the victim's mailbox, they can log in.
   Mitigation: promote passkeys, deprecate magic-link once every active user
   has a passkey, require a signed-in session before a user can add a passkey
   for a different email.
6. **Insider threat at Anthropic / Cloudflare / Resend.** Any of those vendors
   with log access could see auth events at the transport level (but not
   credentials — TLS terminates at Cloudflare).
7. **Side-channel on D1 / KV.** Cross-tenant timing attacks on a shared
   multi-tenant database are theoretical; we rely on Cloudflare's isolation.

---

## 2. Encryption posture

### In transit

- TLS 1.2+ everywhere. HSTS preload with `includeSubDomains; preload`.
- No plaintext HTTP; the worker binds only to `https://login.joynerventures.com`.
- Resend API call for magic-link email is HTTPS to `api.resend.com`.

### At rest

| Asset                        | How it's protected                                             |
|------------------------------|----------------------------------------------------------------|
| Passkey public keys          | Stored as-is (public; by design not secret).                   |
| Passkey counters             | Plain integer; used to detect cloning.                         |
| Session JWTs                 | Not stored. Stateless; verified by HS256 signature.            |
| Refresh tokens               | Stored as SHA-256 hash (`refresh_hash`). Never plaintext.      |
| Magic-link codes             | Stored as SHA-256 hash (`token_hash`). Never plaintext.        |
| Email addresses              | Plain; PII. D1 at-rest encryption relied on.                   |
| Audit log                    | Plain; scrubbed of credential-shaped keys at write time.       |
| `SESSION_JWT_SECRET`         | Cloudflare secret. Never in source; never in audit log.        |
| `REFRESH_JWT_SECRET`         | Reserved for future asymmetric-refresh migration; unused now.  |
| `ADMIN_BOOTSTRAP_TOKEN`      | Cloudflare secret. Constant-time comparison. Rotate after use. |
| `RESEND_API_KEY`             | Cloudflare secret.                                             |

### Algorithm choices

- **SHA-256** (WebCrypto) for hashing refresh tokens and magic-link codes.
- **HS256** for session JWTs. Symmetric = downstream projects hold the shared
  secret. This is a **known limitation** — see §Key rotation.
- **WebAuthn** primitive choice delegated to `@simplewebauthn/server` and the
  authenticator (typically ES256 or EdDSA).
- **`crypto.getRandomValues`** (32 bytes) for refresh tokens, magic-link codes,
  CSRF cookies. Never `Math.random`.

---

## 3. Access control

### User → project RBAC

Roles: `owner`, `admin`, `member`.

| Action                                 | owner | admin | member | unauth |
|----------------------------------------|:-----:|:-----:|:------:|:------:|
| Authenticate into project              |   ✓   |   ✓   |   ✓    |        |
| Grant `member`                         |   ✓   |   ✓   |        |        |
| Grant `owner` or `admin`               |   ✓   |       |        |        |
| Revoke non-owner                       |   ✓   |   ✓   |        |        |
| Revoke owner                           |   ✓   |       |        |        |
| First-ever grant on a 0-member project |       |       |        |   ✓ (with `ADMIN_BOOTSTRAP_TOKEN`) |

### Bootstrap

One-shot. The worker refuses `/admin/project/grant` with the bootstrap header
if the target project already has any members. After planting the first owner,
`ADMIN_BOOTSTRAP_TOKEN` must be rotated to a placeholder value to close the
door. (We do not auto-rotate because that would require the worker to write a
secret, which it cannot do; operator must `wrangler secret put`.)

### Authority-origin rule

Per pinned `feedback_jake_greenlight_console_only.md`: any action that records
"Jake approved X" in *another* system must originate from Jake's interactive
console, not from a hail-inject or cross-silo pathway. This worker's
contribution to that rule is: the only way to mint a session is (a) a
WebAuthn assertion against a credential Jake registered from his device, or
(b) a magic-link delivered to Jake's verified email. A downstream system that
reads `payload.email === "jake@joynerventures.com"` from a session JWT signed
by `SESSION_JWT_SECRET` has a cryptographic guarantee that Jake authenticated
through one of those two paths. It does NOT have a guarantee that Jake is
actively present at his console right now — session JWTs are 15-minute bearer
tokens. Downstreams that need *interactive* Jake (e.g., to record "motion pass
— Principal") MUST add an additional step-up check: a fresh WebAuthn assertion
via this worker's `/login-passkey/verify` with a short-lived nonce, verified
synchronously with the decision.

---

## 4. Integrity verification

- **JWT signature.** Every session JWT is HS256-signed. Tamper = verify fails.
- **Refresh-token reuse detection.** Rotation overwrites `refresh_hash`; a
  reused old refresh hits a row where `revoked_at != NULL` → 401.
- **Passkey counter.** Authenticators advance a counter on each use; a regress
  (new counter ≤ stored) indicates a cloned authenticator. The `@simplewebauthn`
  verifier returns the new counter; we persist only when it strictly increases.
  **TODO:** explicitly reject regressions rather than relying on the library
  default. Tracked in Follow-ups.
- **Audit log tamper detection.** Not currently addressed. D1 is a normal
  SQL table; a compromised worker or an operator with direct DB access could
  mutate rows. Mitigation under consideration: periodic hash-chain of audit
  rows exported to an external append-only store. Tracked in Follow-ups.

---

## 5. Audit trail

Every auth-relevant event writes a row to `audit_log`:

- `register.options`, `register.verify.ok`, `register.verify.fail`
- `login.options`, `login.passkey.ok`, `login.passkey.fail`, `login.locked`
- `magic.sent`, `magic.send.fail`, `magic.verify.ok`, `magic.verify.fail`
- `session.refresh`, `logout`
- `admin.grant.ok`, `admin.grant.bootstrap`, `admin.revoke.ok`

Fields: `ts, event, user_id, project_id, ip, user_agent, detail (JSON)`.

**Write-only contract.** No code in `onboard-auth/` UPDATEs or DELETEs
`audit_log`. If retention policy ever requires purging, the purge itself must
be a logged event.

**Credential redaction.** `src/audit.js` scrubs JSON keys whose lowercase name
appears in `CREDENTIAL_KEYS` (`token`, `refresh`, `session`, `jwt`, `password`,
`code`, `magic`, `challenge`, `authorization`, `cookie`, `secret`). Added
values must not include raw tokens. When in doubt: **log the event, not the
payload.**

**Retention.** No automatic retention yet — audit rows accumulate forever.
Follow-up: 2y default with legal-hold override.

---

## 6. Failure modes

### What happens if…

| Failure                                       | Behavior                                     | Fail open/closed |
|-----------------------------------------------|----------------------------------------------|:----------------:|
| D1 unreachable                                | 500 to client; no session issued             |      closed      |
| KV unreachable (rate-limit)                   | Rate-limit check returns `exceeded: false`, degrading to "no limit." Account lockout in D1 remains the backstop. **TODO:** make fail-closed optional via env flag. | open (mitigated) |
| Resend API key missing / Resend down          | `/magic-link/request` throws; response body is still 200 `{ok:true}` to the caller (no enumeration). Audit entry records `magic.send.fail`. User never gets the link — they retry. | closed (from the user's POV — no link, no login) |
| `SESSION_JWT_SECRET` missing                  | JWT sign throws → 500                        |      closed      |
| `ADMIN_BOOTSTRAP_TOKEN` missing               | Bootstrap path refuses (no secret to compare against). Authenticated admin path still works. | closed |
| WebAuthn challenge KV entry expired (>5m)     | Verify returns `challenge_not_found` → 400    |      closed      |
| Clock skew between issue and verify           | JWT `exp` check rejects with `invalid`. Mitigation: issuer and verifier workers share CF's NTP-synced clock. |      closed      |
| Audit-log write fails                         | `audit()` logs to console and swallows. The user request proceeds. This is deliberate: we never refuse a login because an audit row failed. |      open        |
| CSRF token mismatch on authenticated POST     | 403 `csrf_invalid`                            |      closed      |

### Fail-open choices — explicit risk acceptance

Two places deliberately fail open:

1. **Rate limit when KV is unreachable.** Chosen because global KV outage would
   lock every user out. Account-lockout-in-D1 is the real defence against
   sustained abuse; rate-limit is the convenience layer. Revisit if a worker
   outage pattern correlates with abuse spikes.
2. **Audit write failure.** Chosen because audit is observability, not a
   security control in the request path. Revisit if an auditor requires
   "no login without an audit record."

---

## 7. Key rotation

### `SESSION_JWT_SECRET`

Today: HS256 with one secret shared between this worker and every downstream
verifier. Rotation procedure:

1. Generate new secret.
2. Temporarily run both workers with a `SESSION_JWT_SECRET_NEXT` env var that
   the verifier tries as a fallback.
3. Cut over signing to the new secret.
4. Wait `SESSION_TTL_SECONDS` (15 min) after the last old-key token was
   minted.
5. Retire `SESSION_JWT_SECRET_NEXT` on the verifier.

**This dual-accept window is not currently implemented** in either this worker
or the sample downstream verifier. Tracked in Follow-ups — implement before
production.

**Preferred long-term:** migrate to **RS256**. The auth worker holds the
private key; downstreams hold only the public key via `/.well-known/jwks.json`.
Rotation becomes publish-new-key-as-secondary → cut over → retire old. No
shared secret across codebases.

### `ADMIN_BOOTSTRAP_TOKEN`

Rotate immediately after first use by setting it to a placeholder
(`wrangler secret put ADMIN_BOOTSTRAP_TOKEN <random-unused-value>`). The one-shot
per-project gate (zero members) prevents re-use even if rotation is missed,
but belt-and-suspenders.

### `RESEND_API_KEY`

Standard Resend dashboard rotation. Update `wrangler secret put`.

---

## 8. Deliberate non-goals / deferred hardening

- **Hardware-attestation enforcement.** We accept passkeys of any attestation
  level (`attestationType: "none"`). Fine for a contractor sales console;
  revisit if onboarding handles payment or PII escalation.
- **Device-list UI.** Users cannot currently see or delete their own passkeys
  via a UI. Admin can delete via direct SQL. **TODO.**
- **Rate-limit by subnet / ASN.** Only per-IP and per-account today. If abuse
  comes from a distributed botnet, IP granularity is insufficient.
- **Sign-in notifications.** No "you just signed in from X" email. Audit log
  captures it; user-facing surfacing is a follow-up.
- **Multi-region D1 consistency.** D1 is regional; cross-region consistency is
  eventual. Rate-limit counter drift and refresh-token-rotation races are
  theoretically possible; mitigation is the DB-side account lockout.

---

## 9. What a reviewer should look for

When reviewing a PR to this repo:

1. Does any new endpoint bypass CSRF, rate-limit, or audit?
2. Does any new admin path exist without owner/admin role check?
3. Does any new log line include a token, challenge, or raw credential?
4. Does any new error path leak user-existence information (e.g., returning
   404 for unknown email on a magic-link endpoint)?
5. Does any new cookie skip `HttpOnly; Secure; SameSite=…`?
6. Does any change require a `SESSION_JWT_SECRET` rotation? If yes, is the
   runbook in this doc still accurate?
7. Does any new table, column, or KV key need to appear in §Encryption?
8. Does the change need a follow-up bead for a deferred hardening item?
