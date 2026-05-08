> ⚠ **DEPRECATED 2026-04-30** — Per Jake universal directive, the email stack is now **Google only**. Brevo and Resend are being ripped out (account closures pending). Do NOT follow any setup steps in this document that reference Brevo, Resend, or any non-Google email relay. The Gmail-API replacement runbook supersedes this. See `~/gt-lab/memory/feedback_email_stack_google_only.md`.

---

# staging-pasha Provisioning — One-Time Setup

**Audience:** Jake. A polecat cannot run any of these — each step touches
billed Cloudflare resources, DNS, systemd on the desktop, or real secret
values. This file is a paste-ready runbook so wiring up the staging sibling
of `pasha.jvholdings.co` is mechanical.

**Goal:** a second dashboard at `staging-pasha.jvholdings.co` backed by its
own auth worker and its own desktop FastAPI instance (port 8101) — shared
only at the Plaza publish layer and the canonical-jo persona.

**Until this is done:** the wrangler stanza and `.env.staging-pasha` live
in the repo harmlessly; deploy commands will fail against
`REPLACE_WITH_...` placeholders. Production pasha is untouched.

**Off-limits during buildout (per URGENT spec):**

- Do NOT touch `pasha.jvholdings.co`
- Do NOT touch `contractor-auth-pasha` (worker or its D1/KV)
- Do NOT touch `contractor-webui-api@pasha.service` on the desktop
- Do NOT modify `/srv/town/shared/canonical-jo/` persona files

---

## 1. Create D1 + KV for the staging auth worker

```bash
cd contractor-auth
npx wrangler d1 create contractor-auth-staging-pasha
npx wrangler kv namespace create AUTH_KV --env staging-pasha
```

Paste the returned ids into `contractor-auth/wrangler.jsonc` under
`env.staging-pasha`, replacing:

- `REPLACE_WITH_STAGING_PASHA_D1_ID`
- `REPLACE_WITH_STAGING_PASHA_AUTH_KV_ID`

Apply the schema (local + remote):

```bash
npx wrangler d1 execute contractor-auth-staging-pasha --env staging-pasha --file=./schema.sql
npx wrangler d1 execute contractor-auth-staging-pasha --env staging-pasha --remote --file=./schema.sql
```

## 2. Mint staging secrets (MUST differ from prod)

```bash
# Fresh 32-byte bases; never reuse prod pasha's secrets.
openssl rand -base64 48 | npx wrangler secret put SESSION_JWT_SECRET --env staging-pasha
openssl rand -base64 48 | npx wrangler secret put REFRESH_JWT_SECRET --env staging-pasha
npx wrangler secret put RESEND_API_KEY --env staging-pasha
# Allowlist is staging-only. jjoyner + bob emails — nobody else.
npx wrangler secret put CONTRACTOR_ALLOWED_EMAILS --env staging-pasha
```

Stash a copy of the SESSION_JWT_SECRET bytes at
`~/gt-lab/.secrets/contractor-auth-staging-pasha-session.key` on lemur; the
desktop FastAPI needs the same bytes (see §5).

Deploy:

```bash
npx wrangler deploy --env staging-pasha
```

At this point `https://contractor-auth-staging-pasha.jakejoyner9.workers.dev`
is live.

## 3. CF Pages project for the staging dash

Create a Pages project named `staging-pasha-dash`:

```bash
cd contractor-dash
npm run build:staging-pasha
npx wrangler pages deploy ./dist --project-name staging-pasha-dash
```

In the CF dashboard → Pages → `staging-pasha-dash` → Settings → Environment
variables (Production), set:

- `AUTH_WORKER_URL=https://contractor-auth-staging-pasha.jakejoyner9.workers.dev`
- `API_WORKER_URL=https://api.staging-pasha.jvholdings.co`

These are consumed by `functions/auth/[[path]].ts` and
`functions/api/[[path]].ts` at request time; the SPA itself only needs
the `VITE_*` values baked in at build time.

## 4. Custom domain + CF Access allowlist

Add the custom domain `staging-pasha.jvholdings.co` to the
`staging-pasha-dash` Pages project (Settings → Custom domains).

In CF Zero Trust → Access → Applications, create a self-hosted app:

- Name: `staging-pasha-dash`
- Host: `staging-pasha.jvholdings.co`
- Policy: **Allow** with email-list criteria — `jakejoyner9@gmail.com` and
  Bob's email (confirm the exact address with Jake before saving). Default
  action: **Block**.

Repeat for `auth.staging-pasha.jvholdings.co` if you choose to front the
auth worker with a custom domain. The same allowlist applies.

Once CF Access is live, uncomment the `routes` block in
`contractor-auth/wrangler.jsonc` → `env.staging-pasha` and redeploy:

```bash
npx wrangler deploy --env staging-pasha
```

## 5. Desktop FastAPI instance (port 8101)

SSH to the desktop as the contractor's Linux user:

```bash
ssh jjoyner@100.113.167.50
sudo -iu sales-agent
```

Code is shared with the prod instance — the staging service just loads a
different env file. If you have not already cloned the repo under
sales-agent, follow `contractor-webui-api/README.md`.

```bash
cd ~/contractor-webui-api

# Install the staging JWT secret (copied from lemur earlier in §2).
install -m 600 <(cat /path/to/staging-pasha-session.key) \
  ~/.secrets/contractor-auth-staging-pasha-session.key

# Drop the staging env file.
install -m 600 contractors/pasha-staging.env.example \
  ~/.config/contractor-webui-api/pasha-staging.env
# Review the paths; ensure BIND_PORT=8101 and the secret file line matches
# the install above.
```

Enable the staging systemd unit (uses the same template as prod):

```bash
systemctl --user daemon-reload
systemctl --user enable --now contractor-webui-api@pasha-staging.service
systemctl --user status contractor-webui-api@pasha-staging.service

# Sanity — prod on 7777 and staging on 8101 answer independently:
curl -sS http://127.0.0.1:7777/health   # {"ok":true}  ← prod, do not restart
curl -sS http://127.0.0.1:8101/health   # {"ok":true}  ← staging
```

## 6. CF Tunnel ingress entry for the staging API

On the desktop, edit the existing cloudflared tunnel config (`~sales-agent/.cloudflared/config.yml`
or wherever the pasha tunnel lives) and add an ingress rule BEFORE the
catch-all 404:

```yaml
ingress:
  # existing prod rule — DO NOT REMOVE or REORDER relative to existing entries
  - hostname: api.pasha.jvholdings.co
    service: http://127.0.0.1:7777
  # NEW: staging sibling on 8101
  - hostname: api.staging-pasha.jvholdings.co
    service: http://127.0.0.1:8101
  # existing catch-all
  - service: http_status:404
```

Route the hostname to the tunnel:

```bash
cloudflared tunnel route dns <tunnel-name> api.staging-pasha.jvholdings.co
systemctl --user restart cloudflared   # or equivalent service manager
```

Verify from lemur:

```bash
curl -sS https://api.staging-pasha.jvholdings.co/health
```

## 7. Smoke-test the full stack

1. Hit `https://staging-pasha.jvholdings.co`. CF Access should prompt for
   email verification (jjoyner or Bob only).
2. Log in via magic link — the auth cookie should come from
   `staging-pasha.jvholdings.co`, distinct from any cookie you have for
   `pasha.jvholdings.co`.
3. Open JoChat on staging. First turn spawns claude on port 8101's
   FastAPI under `sales-agent` — confirm with
   `systemctl --user status contractor-webui-api@pasha-staging.service`.
4. Publish a test hail. Verify it lands at
   `/srv/town/shared/publish/pasha/` (the shared Plaza dir). John will
   see it alongside prod hails — expected, per spec.
5. Reload prod `pasha.jvholdings.co`. Confirm Pasha's session is untouched
   and no artifacts from the staging build are visible.

## 8. Rollback drill

Before considering staging "landed," prove rollback:

- Disable: `systemctl --user disable --now contractor-webui-api@pasha-staging.service`
- Revert the PR: `git revert <commit>` on `main` removes the config.
- The CF Pages project, CF Access app, D1, and KV persist but are
  harmless without the code referencing them — tear them down from the
  CF dashboard when fully done.

---

## Acceptance checklist (maps to URGENT spec)

- [ ] `https://staging-pasha.jvholdings.co` loads behind CF Access (allowlist: jjoyner + bob)
- [ ] Staging JoChat spawn hits `127.0.0.1:8101`, not prod 7777
- [ ] Staging hails land in `/srv/town/shared/publish/pasha/` (shared with prod — John sees both)
- [ ] Changing staging CSS does NOT affect `pasha.jvholdings.co` until explicit promote
- [ ] Reverting staging is a single `git revert`
- [ ] `pasha.jvholdings.co` session with Pasha remains uninterrupted throughout buildout
