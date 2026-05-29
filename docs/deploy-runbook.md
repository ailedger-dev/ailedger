# AILedger Deploy Runbook

**Scope:** every customer-facing surface in this repo — `proxy`, `redirect`
(Cloudflare Workers) and `landing`, `dashboard` (Cloudflare Pages).

**Promotion model:**

```
PR opened  ─────────►  gates + Pages preview (landing + dashboard)
merge → main ────────►  Pages production
tag v* ──────────────►  Workers production
```

**There is no remote Workers staging tier.** Workers are developed locally with
`wrangler dev` and ship straight to production on a `v*` tag. The previous
`*-staging.workers.dev` deploys were removed on 2026-05-28 — they put an
unmonitored, publicly reachable copy of each Worker on the internet for no
benefit at current scale. If a shared remote pre-prod is ever needed (e.g. for
a team), reintroduce it **behind Cloudflare Access**, not on open `workers.dev`.

Pages still gets per-PR preview deploys (`*.pages.dev`) — that is the
"staging" for `landing` + `dashboard`, and it is isolated per PR.

---

## Day-to-day: shipping a change

1. **Branch off main.**
   ```bash
   git checkout -b <short-description>
   ```

2. **Work locally.** Use `wrangler dev` for Workers (`proxy`, `redirect`) and
   `npm run dev` for `landing` / `dashboard`. `wrangler dev` emulates Workers
   + KV + D1 locally, so no remote deploy is needed to iterate.

3. **Open a PR.** CI runs the `gates` job (lint / typecheck / test) and
   auto-previews `landing` + `dashboard` on Cloudflare Pages — the `*.pages.dev`
   URLs appear in the PR check list.

4. **Validate.** Workers: exercise locally via `wrangler dev`. Pages: hit the
   per-PR `*.pages.dev` preview URL and smoke-check the flow you changed.

5. **Merge to main.** CI re-runs gates and deploys `landing` + `dashboard` to
   production.

6. **Ship Workers to prod by tagging a release.**
   ```bash
   git tag v2026.05.28
   git push origin v2026.05.28
   ```
   CI requires approval on the `production` GitHub environment before the prod
   Worker deploy runs (configure reviewers in repo Settings → Environments).
   Once approved, `proxy` + `redirect` promote to prod. Pages prod deploy
   happens on merge to main and is **not** gated on the tag.

---

## Rollback

### Workers (proxy, redirect)

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

All runtime secrets live in Cloudflare (never in git). With no remote staging,
validate a new secret locally (`wrangler dev` with a `.dev.vars` value) before
rotating prod:

```bash
cd proxy
npx wrangler secret put <NAME>
# (paste new value at prompt)
```

**Rules:**
- Session / refresh JWT secrets: rotation invalidates every session. Plan for
  a mass logout when rotating.
- **Never rotate secrets by committing new values to the repo.** If a secret
  leaks, rotate via `wrangler secret put` and consider the prior value
  compromised for its entire history in git.

---

## Promotion checklist (→ prod)

Before tagging a release:

- [ ] PR merged to main, main green on CI.
- [ ] You verified the changed surface locally (`wrangler dev` for Workers,
  `*.pages.dev` preview for Pages).
- [ ] Release notes drafted (at minimum: what changed, what to watch for,
  how to roll back).
- [ ] No open schema migrations that haven't been applied to prod.
- [ ] Tag format: `vYYYY.MM.DD` or `vYYYY.MM.DD-<n>` for same-day re-roll.

---

## What lives where

| Surface     | Runtime | Prod route             |
|-------------|---------|------------------------|
| `proxy`     | Workers | `proxy.ailedger.dev`   |
| `redirect`  | Workers | `dashboard.ailedger.dev` |
| `landing`   | Pages   | `ailedger.dev`         |
| `dashboard` | Pages   | `dash.ailedger.dev`    |

Pages previews are served from `<branch>.ailedger-{landing,dashboard}.pages.dev`.
