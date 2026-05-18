# Charter page staging — handoff (2026-05-12, Vernier)

Vernier prepared the AILedger Charter v1.0 publication surface on the marketing site autonomously while Jake slept through his move-out.

## What's staged

- **`public/charter.html`** — self-contained static HTML rendering of Charter v1.0. Matches the site's Inter + IBM Plex Mono typography and dark/light theme. Loads independently of the React SPA; no routing changes to App.tsx. Includes canonical meta, og tags, and a back-to-AILedger nav.
- **`public/_redirects`** — extended with `/charter` → `/charter.html` (200) and `/charter/v1` → `/charter.html` (200) before the SPA catch-all.

## What still needs Jake

- **Add "Charter" link to the main nav.** Per the publication handoff: "Add 'Charter' link to main nav, not footer." This requires editing `src/App.tsx` Nav component. Vernier didn't touch it because it's a customer-facing change that affects visible site chrome; Jake's call on placement + styling.
- **Decide on nav-link target.** Suggested copy: `<a href="/charter">Charter</a>`. Place between existing nav items (e.g. between "Pricing" and "Docs," or wherever fits the layout best per Jake's eye).
- **Deploy to preview, verify, then deploy to production.** Standard `pnpm build` + Cloudflare Pages deploy. The static charter.html will be picked up from `public/` automatically by Vite's build.
- **Verify checklist** (from publication handoff):
  - [ ] `ailedger.dev/charter` loads and renders the charter
  - [ ] `/charter/v1` resolves and matches `/charter`
  - [ ] Main nav on `ailedger.dev` includes "Charter" link (PENDING Jake)
  - [ ] Link from charter page back to GitHub repo works (currently points to `github.com/ailedger/charter` — if Jake uses the `jakejjoyner/ailedger-charter` fallback URL, update the two `href="https://github.com/ailedger/charter"` references in `charter.html`)
  - [ ] CI/Playwright screenshots updated to reflect new nav item (PENDING Jake; will follow nav addition)

## What was deliberately NOT done

- **No nav link addition** — requires Jake's design eye + decision on placement.
- **No GitHub repo creation** — the `jakejjoyner` account is not a member of the `ailedger` GitHub org. Staging files for the repo are at `~/workspace/dev/ailedger/charter-repo-staging/`, with `SETUP.md` for the steps Jake needs to run.
- **No jakejoyner.com reference** — the homepage repo isn't cloned at `~/workspace/dev/`. Cloning + editing + pushing is straightforward but requires Jake's confirmation that the reference text + placement is right.

## Implementation notes

- **Routing approach:** chose static `charter.html` + `_redirects` over a React component because (a) the existing site is a single-page React app with no routing library, (b) Cloudflare Pages serves `_redirects` natively and the 200-status rewrite preserves the URL while serving the static file, (c) the Charter is a single, immutable-at-version text — no need to involve React state. This keeps the surface minimal and avoids architectural decisions that should be Jake's call.
- **Typography matched:** Inter for body, IBM Plex Mono available (not used in the charter page itself; reserved for code-block conventions on the rest of the site).
- **Dark/light theme:** uses `prefers-color-scheme` media query to match the existing site's theme handling. Variables shadow the site's main palette.
- **GitHub link:** the charter page links to `https://github.com/ailedger/charter` for "Source on GitHub." If Jake creates the repo at `jakejjoyner/ailedger-charter` instead, update lines containing that URL (currently 2 instances in `charter.html`).

## Why the charter ships at /charter.html instead of as a React page

The existing site has no client-side router. Adding one introduces an architectural decision (routing library, sitemap mechanics, hydration patterns) that should be Jake's. A static page served at `/charter.html` with a Cloudflare Pages 200-rewrite from `/charter` gives the user-facing UX of "ailedger.dev/charter renders the charter" without forcing any architectural change. If Jake later adds React Router for other reasons, the charter page can be migrated trivially.

## Cross-references

- Charter source: `~/workspace/dev/ailedger/CHARTER.md`
- Repo staging: `~/workspace/dev/ailedger/charter-repo-staging/` (CHARTER.md + README.md + LICENSE + SETUP.md)
- Posture memory: `memory/project_ailedger_posture_v2_2026_05_12.md` [FOUNDATIONAL]
- Marketing-quote-bank reference: QA-17 (refused-customer line) cites the public Charter.
