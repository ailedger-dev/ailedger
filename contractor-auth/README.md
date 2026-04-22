# contractor-auth

Generalized, per-contractor Cloudflare Worker auth service. One codebase, deployed
per contractor via `wrangler --env <slug>`. Forked from `onboard-auth` on 2026-04-21
for the `pasha.jvholdings.co` first-deployment sprint.

- **Passkeys (WebAuthn)** primary. **Magic-link** fallback, disabled once the user
  has a registered passkey (downgrade-attack prevention).
- **Email allowlist** enforced per contractor: registration and magic-link requests
  are silently denied for emails not in `CONTRACTOR_ALLOWED_EMAILS`.
- Session JWT claims include `aud=<contractor_slug>`, `role=contractor`,
  `contractor=<slug>` so downstream services can pin the contractor origin.
- Short-lived session JWT (15 min) + rotating refresh token (7 days; per arch doc).
- Append-only audit log of every auth event.
- Per-IP and per-account rate limiting. Account lockout after 5 consecutive failures.
- CSRF double-submit on authenticated state-changes. Strict security headers.
- No passwords. No custom crypto. `@simplewebauthn/server` + `@tsndr/cloudflare-worker-jwt`.

See [`SECURITY.md`](./SECURITY.md) for the threat model.

## Multi-contractor model

**Key insight:** one Worker codebase, N deployments. Each contractor has its own
Cloudflare Worker, D1, KV, JWT secrets, and email allowlist. A compromise of one
contractor's auth cannot leak another's sessions (different JWT secrets).

Adding a new contractor:

1. Append an `env.<slug>` stanza to `wrangler.jsonc` (copy the `env.pasha` block).
2. `wrangler d1 create contractor-auth-<slug>` — paste the id back into the stanza.
3. `wrangler kv namespace create AUTH_KV --env <slug>` — paste the id back.
4. `wrangler d1 execute contractor-auth-<slug> --env <slug> --file=./schema.sql`
5. `wrangler d1 execute contractor-auth-<slug> --env <slug> --remote --file=./schema.sql`
6. `wrangler secret put SESSION_JWT_SECRET --env <slug>` — 32+ bytes of entropy.
7. `wrangler secret put REFRESH_JWT_SECRET --env <slug>` — distinct 32+ bytes.
8. `wrangler secret put CONTRACTOR_ALLOWED_EMAILS --env <slug>` — comma-separated.
9. Optional (for magic-link fallback): `wrangler secret put RESEND_API_KEY --env <slug>`.
10. `wrangler deploy --env <slug>`.
11. Add custom domain to the Worker in the Cloudflare dashboard.

Empty or unset `CONTRACTOR_ALLOWED_EMAILS` = **deny all**. This is intentional:
a bare deploy without the allowlist secret is a safe no-op.

## Pasha (first deployment)

Target: `contractor-auth-pasha` Worker, reached from `pasha.jvholdings.co` via
Pages Function proxy in `contractor-dash`.

Bootstrap:

```sh
cd contractor-auth
npm install
wrangler d1 create contractor-auth-pasha
# paste id into env.pasha.d1_databases[0].database_id
wrangler kv namespace create AUTH_KV --env pasha
# paste id into env.pasha.kv_namespaces[0].id
wrangler d1 execute contractor-auth-pasha --env pasha --file=./schema.sql
wrangler d1 execute contractor-auth-pasha --env pasha --remote --file=./schema.sql

# JWT secrets (32+ bytes each)
openssl rand -hex 32 | wrangler secret put SESSION_JWT_SECRET --env pasha
openssl rand -hex 32 | wrangler secret put REFRESH_JWT_SECRET --env pasha

# Email allowlist (required — no deploy-time default; empty = deny all)
echo -n "pasha.missaghieh@example.com" | wrangler secret put CONTRACTOR_ALLOWED_EMAILS --env pasha

wrangler deploy --env pasha
```

After deploy, the contractor-dash Pages Function at `functions/auth/[[path]].ts`
proxies `/auth/*` on `pasha.jvholdings.co` to this Worker.

## JWT shape

```json
{
  "sub": "<user-id>",
  "email": "pasha.missaghieh@example.com",
  "iat": 1745280000,
  "exp": 1745280900,
  "iss": "contractor-auth",
  "aud": "pasha",
  "role": "contractor",
  "contractor": "pasha",
  "v": 1,
  "projects": []
}
```

Downstream verifiers (the FastAPI on desktop, future projects) verify against
the same `SESSION_JWT_SECRET` used by the Worker. The `aud` claim MUST be
validated against the contractor the service is serving.

## Routes

```
GET    /                              login.html (direct-visit fallback)
POST   /register-passkey/options      begin WebAuthn registration (allowlisted email only)
POST   /register-passkey/verify       finish WebAuthn registration
POST   /login-passkey/options         begin WebAuthn login
POST   /login-passkey/verify          finish WebAuthn login
POST   /magic-link/request            send magic-link (denied post-passkey)
POST   /magic-link/verify             redeem magic-link
GET    /session                       introspect current session
POST   /session/refresh               rotate refresh → new session
POST   /logout                        revoke + clear cookies
GET    /health                        200 ok
```

## Development

```sh
npm install
npm run dev            # wrangler dev against base (no contractor context)
npm run tail:pasha     # tail production logs for env.pasha
npm run deploy:pasha   # deploy env.pasha
```

## Notes for follow-on work

- The `projects` / admin paths carry over from `onboard-auth` and are dormant
  until a contractor needs multi-project authorization. Removing them would
  diverge from the upstream scaffold; leaving them in keeps the forge points
  aligned.
- To add a second contractor, copy the `env.pasha` block — do NOT fork the
  worker codebase. That would reintroduce the technical debt the generalization
  was meant to avoid.
