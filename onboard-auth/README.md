> ⚠ **DEPRECATED 2026-04-30** — Per Jake universal directive, the email stack is now **Google only**. Brevo and Resend are being ripped out (account closures pending). Do NOT follow any setup steps in this document that reference Brevo, Resend, or any non-Google email relay. The Gmail-API replacement runbook supersedes this. See `~/gt-lab/memory/feedback_email_stack_google_only.md`.

---

# onboard-auth

Standalone, project-scoped login service. **Not coupled to AILedger.** Any
downstream project (john-console today, future Pasha-2 onboarding, etc.)
verifies the session JWT this worker issues — it does not provision auth itself.

- **Passkeys (WebAuthn)** primary. **Magic-link** fallback.
- Short-lived session JWT (15 min) + rotating refresh token (30 days).
- Append-only audit log of every auth event.
- Per-IP and per-account rate limiting. Account lockout after 5 consecutive failures.
- CSRF double-submit on authenticated state-changes. Strict security headers.
- No passwords. No custom crypto. `@simplewebauthn/server` + `@tsndr/cloudflare-worker-jwt`.

See [`SECURITY.md`](./SECURITY.md) for the threat model, encryption posture,
key-rotation story, and failure modes. Read it before changing crypto or auth code.

## Repo layout

```
onboard-auth/
├── src/
│   ├── worker.js          # router + handlers
│   ├── db.js              # D1 helpers (no ORM)
│   ├── audit.js           # append-only audit writes (redacts credential keys)
│   ├── ratelimit.js       # KV-backed rate limit (per-IP + per-account)
│   ├── csrf.js            # double-submit CSRF helper
│   └── auth/
│       ├── session.js     # JWT issue/verify, cookie helpers, refresh helpers
│       ├── passkey.js     # WebAuthn register + login
│       └── magic.js       # magic-link request + verify (Resend email)
├── public/
│   └── login.html         # branded login page (passkey + magic-link)
├── schema.sql             # D1 schema (users/passkeys/magic_links/sessions/projects/project_members/audit_log)
├── wrangler.jsonc         # deploy config (routes, D1, KV, vars)
└── package.json
```

## Deploy

```bash
cd onboard-auth
npm install

# 1) Create D1 and KV, plug their IDs into wrangler.jsonc
wrangler d1 create onboard_auth
wrangler kv namespace create AUTH_KV

# 2) Apply schema
npm run schema:apply:remote

# 3) Plant secrets (generate SECRETS with `openssl rand -base64 32`)
wrangler secret put SESSION_JWT_SECRET
wrangler secret put REFRESH_JWT_SECRET
wrangler secret put RESEND_API_KEY
wrangler secret put ADMIN_BOOTSTRAP_TOKEN

# 4) Deploy
npm run deploy

# 5) Point DNS (Cloudflare dashboard or wrangler):
#    login.joynerventures.com → this worker (custom domain route)
```

### Bootstrap the first admin

Before any user exists, nobody has admin rights. One-shot bootstrap lets you
plant the first `owner` of a project. It only works while the project has zero
members; subsequent grants require an authenticated caller with `owner` or
`admin` role on that project.

```bash
# 1) Create the project row
wrangler d1 execute onboard_auth --remote --command \
  "INSERT INTO projects (id, slug, name, return_host, created_at) \
   VALUES (lower(hex(randomblob(16))), 'john-console', 'John Console', \
           'sales.ailedger.dev', strftime('%s','now'))"

# 2) Have the target user register a passkey on the login page.

# 3) Call grant with the bootstrap token to make them owner:
curl -sX POST https://login.joynerventures.com/admin/project/grant \
  -H "content-type: application/json" \
  -H "x-admin-bootstrap: $ADMIN_BOOTSTRAP_TOKEN" \
  -d '{"projectSlug":"john-console","email":"jake@example.com","role":"owner"}'
```

After the first owner exists, **rotate `ADMIN_BOOTSTRAP_TOKEN` to a placeholder
value** (`wrangler secret put ADMIN_BOOTSTRAP_TOKEN`) to close the bootstrap door.
Subsequent grants go through the authenticated admin path.

## Integration (downstream project consumes a session)

The auth worker and your downstream project are separate workers on separate
domains. Your downstream project verifies the session JWT itself — no
round-trip to the auth worker on every request.

### 1. Unauthenticated request → redirect to login

Your downstream project (e.g., `sales.ailedger.dev`) checks for a session on
every protected request. If absent or invalid, redirect the browser to the
login worker with a `return` param:

```js
// in your downstream worker
const return_url = "https://sales.ailedger.dev" + url.pathname;
return Response.redirect(
  "https://login.joynerventures.com/?return=" + encodeURIComponent(return_url),
  302,
);
```

### 2. Login worker redirects back with a session

After successful passkey sign-in (or magic-link redemption), the login worker
sets the `session` cookie **scoped to `login.joynerventures.com`** and redirects
the browser back to the `return` URL. Because the cookie is not visible to
`sales.ailedger.dev`, the downstream project needs the JWT bearer'd over.

**Two supported delivery modes** (pick one per-project — default is mode A):

#### Mode A: URL-fragment handoff (default, works across unrelated domains)

The login page reads `return`, and after sign-in, fetches `/session`, pulls the
JWT from the `session` cookie, and redirects to:

```
https://sales.ailedger.dev/?_s=<jwt>
```

The downstream worker reads `_s`, verifies it, and immediately sets its own
httpOnly session cookie on its own domain.

> **In this MVP scaffold, the redirect back-with-JWT step is NOT implemented.**
> After sign-in, the login page redirects to `return` without embedding the
> JWT. Wire mode A (fragment) or mode B (shared parent domain) during the
> john-console integration pass. See "Open follow-ups" below.

#### Mode B: Shared parent-domain cookie

If both login and downstream live under the same parent
(`login.joynerventures.com` + `app.joynerventures.com`), set the `session`
cookie with `Domain=.joynerventures.com`. Easier but requires domain colocation.

### 3. Downstream verifies the JWT

```js
import jwt from "@tsndr/cloudflare-worker-jwt";

async function verifySession(request, env) {
  const cookie = request.headers.get("cookie") || "";
  const m = /(?:^|;\s*)session=([^;]+)/.exec(cookie);
  if (!m) return null;
  const token = m[1];
  const valid = await jwt.verify(token, env.SESSION_JWT_SECRET, { algorithm: "HS256" });
  if (!valid) return null;
  const { payload } = jwt.decode(token);
  // Scope check: is this user allowed on THIS project?
  const allowed = payload.projects?.some((p) => p.slug === "john-console");
  if (!allowed) return null;
  return payload;
}
```

Your downstream worker reads `env.SESSION_JWT_SECRET` — the **same** secret this
auth worker signs with. Both workers must be rotated in lockstep. See
`SECURITY.md §Key rotation`.

## API reference

| Method | Path                        | Purpose                                             |
|--------|-----------------------------|-----------------------------------------------------|
| GET    | `/`                         | Serves `login.html`                                  |
| POST   | `/register-passkey/options` | Begin WebAuthn registration                          |
| POST   | `/register-passkey/verify`  | Finish WebAuthn registration (issues session)        |
| POST   | `/login-passkey/options`    | Begin WebAuthn authentication                        |
| POST   | `/login-passkey/verify`     | Finish WebAuthn authentication (issues session)      |
| POST   | `/magic-link/request`       | Email a single-use sign-in link                      |
| GET    | `/magic-link/land`          | HTML page that redeems the `#token=` fragment        |
| POST   | `/magic-link/verify`        | Redeem a magic-link token (issues session)           |
| GET    | `/session`                  | Introspect the current session (JSON)                |
| POST   | `/session/refresh`          | Rotate refresh → new session JWT + new refresh token |
| POST   | `/logout`                   | Revoke refresh + clear cookies                       |
| POST   | `/admin/project/grant`      | Grant membership (admin-only, or bootstrap-token)    |
| POST   | `/admin/project/revoke`     | Revoke membership (admin-only)                       |
| GET    | `/health`                   | Liveness check                                       |

State-changing requests from an authenticated browser must include the
`x-csrf-token` header matching the `csrf` cookie.

## Open follow-ups (file as beads)

- **Session handoff to downstream worker** — implement Mode A (fragment) or
  Mode B (parent-cookie) so john-console actually picks up the JWT after sign-in.
  MVP login succeeds but the `return` redirect doesn't carry the session.
- **Signed JWT rotation** — `SESSION_JWT_SECRET` rotation with a `kid` header and
  dual-accept window. Ref: SECURITY.md §Key rotation.
- **Challenge KV TTL sweep** — KV auto-expires, but add metrics to detect abuse
  spikes in pending challenges.
- **Admin UI** — currently admin grants are cURL-only. Build a minimal admin
  page for the owner to invite members.
- **Move to RS256** — HS256 means downstream projects hold the signing secret.
  Migrating to asymmetric keys lets downstreams only hold the public key.
  Populate `/.well-known/jwks.json` at that point.
- **End-to-end test harness** — wrangler `vitest-pool-workers` harness that
  exercises each route with a simulated D1/KV.

## Provenance

Scaffolded by Bob 2026-04-18 for bead `ai-6qf` (P0). Standalone on purpose —
this repo is meant to be extracted to `jakejjoyner/onboard-auth` (or
`joyner-auth`) once Jake confirms the integration contract.
