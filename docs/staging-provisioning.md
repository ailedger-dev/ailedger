> ⚠ **DEPRECATED 2026-04-30** — Per Jake universal directive, the email stack is now **Google only**. Brevo and Resend are being ripped out (account closures pending). Do NOT follow any setup steps in this document that reference Brevo, Resend, or any non-Google email relay. The Gmail-API replacement runbook supersedes this. See `~/gt-lab/memory/feedback_email_stack_google_only.md`.

---

# Staging Provisioning — One-Time Setup

**Audience:** Jake. This file lists every manual step required to light up
staging after the wrangler / CI changes land. A polecat cannot do any of
this — each step touches billed Cloudflare resources, DNS, or secret values.

**Until this is done:** CI staging deploys will publish Workers to
`<name>-staging.<subdomain>.workers.dev` but `staging.*.ailedger.dev` will
not resolve. That is safe and non-customer-visible. The `REPLACE_WITH_...`
placeholders in `env.staging` blocks will cause `wrangler deploy --env
staging` to fail until real IDs are pasted in.

---

## 1. Create D1 databases

```bash
cd onboard-auth
npx wrangler d1 create onboard_auth_staging
```

Paste the returned `database_id` into `onboard-auth/wrangler.jsonc` at
`env.staging.d1_databases[0].database_id` (replacing
`REPLACE_WITH_STAGING_D1_ID`).

Then apply the schema to staging:

```bash
npx wrangler d1 execute onboard_auth_staging --remote --file schema.sql
```

---

## 2. Create KV namespaces

```bash
cd proxy
npx wrangler kv namespace create AILEDGER_CACHE --env staging
#  → paste id into proxy/wrangler.jsonc env.staging.kv_namespaces[0].id

cd ../onboard-auth
npx wrangler kv namespace create AUTH_KV --env staging
#  → paste id into onboard-auth/wrangler.jsonc env.staging.kv_namespaces[0].id

cd ../john-console
npx wrangler kv namespace create SESSION_KV --env staging
npx wrangler kv namespace create SESSIONS --env staging
#  → paste both ids into john-console/wrangler.jsonc env.staging.kv_namespaces
```

---

## 3. Set staging secrets

**All values MUST be distinct from production.** Copy-pasting prod secrets
into staging defeats env separation and has caused real incidents elsewhere
— staging is untrusted by design.

Generate fresh 32+ byte random values for the JWT secrets:

```bash
openssl rand -base64 48   # run twice, once each for SESSION + REFRESH
```

### `proxy`

```bash
cd proxy
# (proxy currently has no runtime secrets; add here if that changes)
```

### `onboard-auth`

```bash
cd onboard-auth
npx wrangler secret put SESSION_JWT_SECRET --env staging
npx wrangler secret put REFRESH_JWT_SECRET --env staging
npx wrangler secret put RESEND_API_KEY --env staging   # staging Resend key
npx wrangler secret put ADMIN_BOOTSTRAP_TOKEN --env staging
```

### `john-console`

```bash
cd john-console
npx wrangler secret put AILEDGER_KEY --env staging       # staging alg_sk_*
npx wrangler secret put ANTHROPIC_API_KEY --env staging  # separate Anthropic key
```

---

## 4. DNS — staging zone entries

**Do not provision these until you're ready for staging URLs to exist.**
Until then, CI deploys hit `workers.dev` subdomains and are reachable only
by people who know the URL — which is the right default for staging.

When ready, in the Cloudflare dashboard DNS for `ailedger.dev`:

| Type | Name                       | Target                                             | Notes |
|------|----------------------------|----------------------------------------------------|-------|
| —    | `staging.proxy`            | routed by `proxy-staging` worker via custom_domain | Uncomment `routes` in `proxy/wrangler.jsonc` `env.staging` |
| —    | `staging.dashboard`        | routed by `dashboard-redirect-staging` worker      | Uncomment `routes` in `redirect/wrangler.jsonc` `env.staging` |
| —    | `staging.sales`            | routed by `john-console-staging` worker (planned)  | Only once `sales.ailedger.dev` prod is live |
| CNAME | `staging`                 | `ailedger-landing.pages.dev`                       | For `staging.ailedger.dev` = staging landing |
| CNAME | `staging.dash`            | `ailedger-dashboard.pages.dev`                     | For staging dashboard |

For `joynerventures.com` (separate zone):

| Type | Name              | Target                                   | Notes |
|------|-------------------|------------------------------------------|-------|
| —    | `staging.login`   | routed by `onboard-auth-staging` worker  | Uncomment `routes` in `onboard-auth/wrangler.jsonc` `env.staging`. **Update `RP_ID` and `RP_ORIGIN` in staging vars** to match the new host. |

After DNS propagates, uncomment the `routes` blocks in the respective
`wrangler.jsonc` `env.staging` sections and redeploy.

---

## 5. Cloudflare Pages preview configuration

The `landing` and `dashboard` Pages projects need the Git integration
enabled once (via CF dashboard → Pages → project → Settings → Builds &
deployments → Source):

- Production branch: `main`
- Preview branches: **all non-production branches** (this gives you
  `<branch>.ailedger-landing.pages.dev` per PR automatically)
- Build command, output dir, and env vars: already match `wrangler.toml`
  defaults

For a long-lived staging alias (`staging.ailedger.dev`,
`staging.dash.ailedger.dev`), designate a `staging` branch in the Pages
project → Custom domains, and point DNS per the table above.

---

## 6. GitHub Actions secrets + environments

In the `ailedger` GitHub repo → Settings → Secrets and variables → Actions:

- `CLOUDFLARE_API_TOKEN` — token scoped to edit Workers, Pages, KV, D1.
- `CLOUDFLARE_ACCOUNT_ID` — Jake's CF account id.

In Settings → Environments:

- Create environment `staging`. No required reviewers.
- Create environment `production`. **Add Jake as required reviewer.** This
  gates the prod deploy job in `.github/workflows/deploy.yml` behind an
  explicit click-through on every release tag.

---

## Sanity check

After all of the above, a PR to main should:

1. Run `gates` job → green.
2. Run `deploy-staging` job → Workers publish under `*-staging.workers.dev`
   (or `staging.*.ailedger.dev` once routes are uncommented).
3. CF Pages posts preview URLs to the PR automatically.

Tagging `v2026.04.22` (for example) should:

1. Run `gates` → green.
2. Pause at `deploy-production` awaiting Jake's approval in the GitHub UI.
3. On approval, promote Workers to prod routes.
