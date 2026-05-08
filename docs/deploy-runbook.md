# AILedger Deploy Runbook

**Scope:** every customer-facing surface in this repo — `proxy`, `onboard-auth`,
`john-console`, `redirect` (Cloudflare Workers) and `landing`, `dashboard`
(Cloudflare Pages).

**Promotion model:**

```
PR opened  ─────────►  staging (Workers + Pages preview)
merge → main ────────►  staging (clean-main confirm)
tag v* ──────────────►  production
```

Staging is a **shared integration env**. Any PR may overwrite it. If two PRs
need to test against staging simultaneously, coordinate in #deploys or stagger
merges. Per-PR Workers previews are not configured — `.pages.dev` previews
give you per-PR isolation for landing + dashboard; Workers use the one shared
staging.

---

## Before your first deploy

Staging is **not** live out of the box. See
[`staging-provisioning.md`](./staging-provisioning.md) for the one-time setup
Jake owns: DNS zone, D1 / KV creation, and staging secrets. Until that is
done, CI staging deploys will succeed against `workers.dev` subdomains but
`staging.*.ailedger.dev` won't resolve.

---

## Day-to-day: shipping a change

1. **Branch off main.**
   ```bash
   git checkout -b <short-description>
   ```

2. **Work locally.** Use `wrangler dev` for Workers and `npm run dev` for
   landing / dashboard. No deploy needed.

3. **Open a PR.** CI runs the `gates` job (lint / typecheck / test). On green
   gates, CI auto-deploys Workers to staging. Cloudflare Pages auto-previews
   landing + dashboard on the same PR — the URLs appear in the PR check list.

4. **Validate on staging.** Hit the `.workers.dev` URL for Workers and the
   `.pages.dev` URL for Pages. Smoke-check the flow you changed. Do NOT test
   against prod — that's what staging is for.

5. **Merge to main.** CI re-runs gates and re-deploys staging from clean
   main. This catches "works on my branch, breaks when merged" drift.

6. **Tag a release when you're ready to ship to prod.**
   ```bash
   git tag v2026.04.21
   git push origin v2026.04.21
   ```
   CI requires approval on the `production` GitHub environment before the
   prod deploy runs (configure reviewers in repo Settings → Environments).
   Once approved, Workers promote to prod. Pages prod deploy happens
   automatically on merge to main — it is **not** gated on the tag. If you
   need to gate Pages on the tag too, switch the CF Pages Git integration
   off and add a `wrangler pages deploy` step here.

---

## Rollback

### Workers (proxy, onboard-auth, john-console, redirect)

Cloudflare keeps the last 10 Worker versions. Roll back via dashboard or CLI:

```bash
# List recent versions:
cd proxy
npx wrangler deployments list

# Roll back to a specific version:
npx wrangler rollback --message "rollback <reason>" <version-id>
```

**This is instant and irreversible from the runtime's perspective** — the
previous version becomes live immediately. Note the version ID of whatever
you rolled back FROM before you roll forward again.

### Landing / Dashboard (Cloudflare Pages)

From the CF dashboard → Pages project → Deployments: click "Rollback" on the
previous good deployment. Or roll back via git revert + push (slower but
leaves a clean audit trail).

### Database

No migration rollback helper exists today. If a migration in `proxy/migrations/`
ships and breaks prod:

1. Write a reverse migration (`20YYMMDD_revert_<name>.sql`).
2. Apply via whatever runtime applies migrations (see proxy AGENTS.md).
3. Roll back the Worker to the pre-migration version.

---

## Secret rotation

All runtime secrets live in Cloudflare (never in git). Rotation flow:

```bash
# Rotate in staging first:
cd onboard-auth   # or proxy / john-console
npx wrangler secret put SESSION_JWT_SECRET --env staging
# (paste new value at prompt)

# Validate on staging — run smoke tests, verify nothing broke.

# Then rotate in prod:
npx wrangler secret put SESSION_JWT_SECRET
```

**Rules:**
- Staging and prod secrets **must be distinct values**. Never copy a prod
  secret into staging. This is the whole point of env separation.
- Session / refresh JWT secrets: rotation invalidates every session. Plan
  for a mass logout when rotating.
- Passkey RP_ID / RP_ORIGIN: changing these invalidates every credential
  registered against the prior origin. **Do not change prod RP_ID** unless
  you're ready to wipe `passkeys` and force everyone to re-register.

**Never rotate secrets by committing new values to the repo.** If a secret
leaks, rotate via `wrangler secret put` and consider the prior value
compromised for its entire history in git.

---

## Promotion checklist (staging → prod)

Before tagging a release:

- [ ] PR merged to main, main green on CI.
- [ ] Staging has been running the change for long enough to shake out
  obvious regressions (minimum: you verified the changed surface manually;
  recommended: 1+ full drip-cron cycle for proxy changes that touch email).
- [ ] Release notes drafted (at minimum: what changed, what to watch for,
  how to roll back).
- [ ] No open schema migrations that haven't been applied to prod.
- [ ] If touching `proxy/` drip-email cron: verify staging has NO cron
  configured so staging doesn't email real users. (`wrangler.jsonc`
  `env.staging.triggers.crons` should be `[]`.)
- [ ] If touching `onboard-auth/`: confirm staging RP_ID / RP_ORIGIN still
  match the served origin.
- [ ] Tag format: `vYYYY.MM.DD` or `vYYYY.MM.DD-<n>` for same-day re-roll.

---

## What lives where

| Surface        | Runtime         | Prod route                        | Staging route (after DNS)              |
|----------------|-----------------|-----------------------------------|----------------------------------------|
| `proxy`        | Workers         | `proxy.ailedger.dev`              | `staging.proxy.ailedger.dev`           |
| `onboard-auth` | Workers         | `login.joynerventures.com`        | `staging.login.joynerventures.com`     |
| `john-console` | Workers         | `sales.ailedger.dev` (planned)    | `staging.sales.ailedger.dev` (planned) |
| `redirect`     | Workers         | `dashboard.ailedger.dev`          | `staging.dashboard.ailedger.dev`       |
| `landing`      | Pages           | `ailedger.dev`                    | `staging.ailedger.dev` (planned)       |
| `dashboard`    | Pages           | `dash.ailedger.dev`               | `staging.dash.ailedger.dev` (planned)  |

Until DNS for `staging.*` is provisioned, staging is served from
`<worker-name>-staging.<subdomain>.workers.dev` and
`<branch>.ailedger-{landing,dashboard}.pages.dev`.
