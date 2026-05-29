# CLAUDE.md — AILedger site

Agent guidance for the AILedger site/code in this repo. Product/schema internals
are documented elsewhere; this file is about building and styling the site.

## Repo & remote

- Canonical remote: **`ailedger-dev/ailedger`** (this repo). Never commit/push/PR
  to personal `jakejjoyner/*` repos — confirm `git remote -v` resolves to
  `ailedger-dev/*` first.
- Public sibling repos: `ailedger-dev/ailedger-detection` (Apache-2.0 detection
  library) and `ailedger-dev/charter` (the published Charter, source of
  `ailedger.dev/charter`).
- **This repo is public.** Never commit privileged, financial, customer, or
  internal-planning content.

## Standards references in site copy

Regulatory anchors: Federal Rule of Evidence 707 and EU AI Act Articles 12, 19,
26. Detection-standard citations (EEOC four-fifths rule; SR 11-7 / OCC 2011-12)
must match the detection layer — note **SR 11-7 is Federal Reserve guidance, not
FDIC**; the OCC's parallel is Bulletin 2011-12.

## Design System (`landing/src/ds/`)

`/hiring` is the design-language source of truth. Its language is extracted into
a shared, scoped foundation under `landing/src/ds/` that `/`, `/pricing`,
`/docs` adopt incrementally. Legacy pages keep working unchanged until migrated.

### Two coexisting token systems — do not merge
- **Foundation (new):** `--ds-*` in `landing/src/ds/tokens.css`, scoped to
  `.ds-root`, dark single-palette, theme-INDEPENDENT (no light/dark flip).
- **Legacy:** `--bg-*` / `--fg-*` / `--accent*` on `:root` in `index.css`,
  light-default with a `prefers-color-scheme: dark` flip, consumed by the
  inline-styled pages in `App.tsx`. Never alias `--ds-*` onto these — values and
  themes differ.

### Tokens (px, never rem/em — load-bearing)
- Color: `--ds-bg #08090A`, `--ds-text-1 #F7F8F8`, `--ds-text-2 #8A8F98`,
  `--ds-text-3 #62666D` (decorative only), `--ds-accent #6B77DB` (links AND focus
  rings; lightened from Linear #5E6AD2 for 4.5:1 AA on 13px — do not drift).
- Font: Inter (weights 400, 500 only), loaded via `@import` in
  `ds/primitives.css` — never globally / in `index.html` (legacy pages stay on
  `system-ui`).
- Type: use the `.ds-display-*` / `.ds-lede` / … utility classes — they carry
  the responsive ladder; the raw `--ds-fs-*` tokens are fixed-size escape hatches.
- Radii: 2px (focus), 4px (interactive). **Zero shadows — the language is flat.**
- Breakpoints: type 900/600; layout 1280/1100/760. Disjoint from legacy's 768px.

### Primitives
`PageShell` (dark surface + reveal observer), `Section` (gutter + vertical-rhythm
tier: `standard` | `hero` | `cta` | `topbar`), `Eyebrow`, `DisplayHeading`,
`BackHomeLink`, `useReveal()`. Utility classes `.ds-*` in `primitives.css`.
A page imports `ds/tokens.css` (tokens only) or also `ds/primitives.css`
(utilities + reveal + single-scroll fix + Inter).

### Motion
- Reveal-on-scroll for **marketing** pages: an IntersectionObserver toggles
  `.is-visible` per `<section>`; `.ds-reveal` children fade + lift 6px over
  1000ms ease-IN `cubic-bezier(0.32, 0, 0.67, 0)`, 510ms stagger, one-way.
- Hover micro-interactions: 180ms ease. All motion gated by
  `prefers-reduced-motion`.

### Do / Don't
- DO use single-document scroll. `:has(.ds-root)` swaps the global
  `overflow-x: hidden` to `clip` to kill the double scrollbar — keep it scoped.
- DON'T add `scroll-snap` or per-section `min-height: 100vh` (the only `100vh`
  is a page floor).
- DON'T put marketing reveal motion on `/docs` — docs is read, not watched.
- DON'T hoist Inter globally, introduce shadows into `--ds-*`, or rename `.ds-*`
  onto legacy `.hero-*` / `.section-*` / `.sr-only`.

### Known gaps (resolve per downstream page, don't auto-resolve)
The flat `/hiring` language has no card/border/shadow tokens, no code-block or
inline-code styling, no table or sidebar/TOC primitive, and no per-page scroll
offset. `/` and `/pricing` currently use lifted cards; `/docs` needs code
surfaces + a 96px deep-link scroll-margin. When migrating those pages, decide
explicitly: flatten to match `/hiring`, or extend the system — a design call.
