# design-sync notes — AILedger Product App (dashboard)

Project: AILedger Product App (`5a265513-32bc-483e-9161-20b5d2125b06`).
Source shape: **package**, synth-entry. `dashboard` is a Vite *app*, not a
component library — there's no published dist entry. The bundle entry is a
GENERATED barrel of named re-exports: `.design-sync/ds-entry.ts` (the components
are `export default`, so `export *` won't pick them up — each is re-exported as
`export { default as <Name> }`). Adding/removing a component means editing BOTH
`ds-entry.ts` and `cfg.componentSrcMap`.

## Build invariants
- Run from `dashboard/`. `--entry ./.design-sync/ds-entry.ts`,
  `--node-modules ./node_modules`.
- npm is broken under this machine's zsh (nvm lazy-loader). Run node/npm via
  `env FUNCNEST=1000 bash -c '...'`. Render check uses system chromium:
  `DS_CHROMIUM_PATH=/usr/bin/chromium` on validate/capture/resync.

## The three forks/hacks that make this render (all in .design-sync/)
1. **`overrides/common.mjs`** (declared in cfg.libOverrides): injects dummy
   `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` into the IIFE `import.meta.env`
   define. WITHOUT IT the whole bundle throws "supabaseUrl is required." at init
   (src/supabase.ts calls createClient at module top level) and EVERY preview
   blanks. It mutates the shared IIFE_IMPORT_META_DEFINE object that lib/bundle.mjs
   reads. On re-sync, diff it against the bundled lib/common.mjs.
2. **`theme-provider.tsx`** (cfg.extraEntries + cfg.provider.component=DarkRoot):
   (a) forces `html.dark` so all cards render in the brand dark theme (the app
   defaults to light, which clashed with the hardcoded-dark components);
   (b) patches `window.fetch` to return empty 200s for `demo.supabase.co` so the
   data screens leave their perpetual loading state and render their EMPTY state.
   Empty-array mock only — no fabricated rows.
3. **cfg.overrides** cardMode:single for `UpgradeModal` + `LogDetailDrawer`
   (both root at `fixed inset-0`). LogDetailDrawer's preview also wraps it in a
   `transform`'d div so the fixed overlay's containing block is the card, not the
   viewport — otherwise it renders off-screen.

## Known render warns (triaged legitimate)
- `[RENDER_THIN] UpgradeModal (0px)` — it's a `fixed`-position modal; measured
  height is 0 but it renders fine (all 3 feature variants visible). Benign.

## Known DS-pane lint (claude.ai/design check_design_system) — COSMETIC, expected
The app's self-check flags ~17 CSS custom properties in `_ds_bundle.css` as
unclassified/misplaced "tokens". ALL are Tailwind v4 framework internals, NOT
AILedger tokens, and they are functionally harmless (components render fine):
- 6 "under component-style selectors": `--tw-space-y-reverse` / `--tw-divide-y-reverse`
  defaults Tailwind emits inside `:where(.space-y-* …)` utility rules.
- 11 "unclassified": `--tw-translate-*`, `--tw-ring-*`, `--tw-border-style`,
  `--tw-outline-style`, `--animate-spin`, `--animate-pulse`,
  `--default-transition-*`, `--default-*-font-*` — Tailwind preflight/@theme defaults.
The converter has NO token-prefix-ignore or `@kind` knob (checked), and editing the
compiled stylesheet is pointless (re-sync regenerates it). The real filter would
have to live in the claude.ai/design app (ignore `--tw-*`/`--animate-*`/`--default-*`),
which we don't control. **Do not chase this on re-sync — it's framework noise.**

## Re-sync risks (watch-list)
- **`.design-sync/dashboard-styles.css` is GENERATED** — it's a copy of the
  compiled Tailwind CSS from `dist/assets/*.css`. `cssEntry` points at it.
  Tailwind v4 only emits utilities it sees in the source, so after ANY component
  markup change you must rebuild the app and refresh this file:
  `npm run build && cp dist/assets/*.css .design-sync/dashboard-styles.css`
  A stale copy ships missing utility classes (silently unstyled spots).
- The 8 data-bound screens render their EMPTY state (via the fetch mock), not
  populated data. If you want populated previews later, extend the fetch mock in
  theme-provider.tsx with per-table fixtures (fragile — matches query shapes).
- Previews use demo/public mock props only (demo-customer ids, jane@acme.example,
  a synthetic inference log) — no real customer/internal data.
