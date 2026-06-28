# design-sync notes — AILedger Marketing DS (landing/src/ds)

Project: AILedger Marketing DS (`702ae72d-518a-4188-8e18-6952d0ed2728`).
Source shape: **package**, **synth-entry** mode (no library build — `landing` is
a Vite *app*, not a published component lib).

## Build invariants
- Run from `landing/` (the config home). Build entry is the DS barrel:
  `--entry ./src/ds/index.ts` (esbuild bundles it into `window.MarketingDS`).
  `--node-modules ./node_modules`.
- **`--entry` disables synth-entry component discovery** (it only auto-discovers
  when the entry is *synthesized*). With no `.d.ts` tree, `exportedNames` finds
  nothing, so the 5 components are pinned explicitly in `cfg.componentSrcMap`.
  Adding/removing a DS component means editing that map.
- npm is broken under this machine's zsh (nvm lazy-loader → `_load_nvm` /
  FUNCNEST). Run all node/npm via `env FUNCNEST=1000 bash -c '...'`. esbuild's
  postinstall is blocked by allow-scripts — `npm approve-scripts esbuild` after install.
- Render check uses the **system chromium** (no ms-playwright cache): install the
  `playwright` package only (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`) and pass
  `DS_CHROMIUM_PATH=/usr/bin/chromium` to validate/capture/resync.

## Known render warns (triaged legitimate)
- `[FONT_REMOTE] "Inter"` — Inter loads via a Google Fonts `@import`; the bundle
  ships no `@font-face`. This is by design (the host page loads it). Not a miss.

## Re-sync risks (watch-list)
- **`.design-sync/ds-styles.css` is GENERATED** (concat of `src/ds/primitives.css`
  + `src/ds/tokens.css`), and `cssEntry` points at it. `tokensGlob` does nothing
  here because it needs a node_modules `tokensPkg`, and the tokens are a local
  file. If `primitives.css` or `tokens.css` changes, **regenerate** before build
  (keep the box-sizing reset line):
  `{ echo "/* GENERATED ... */"; cat src/ds/primitives.css; printf '\n*, *::before, *::after { box-sizing: border-box; }\n'; cat src/ds/tokens.css; } > .design-sync/ds-styles.css`
  Order matters: primitives FIRST (its Inter `@import` must be the first
  statement) then tokens. A stale ds-styles.css silently desyncs the shipped CSS.
- **box-sizing reset is REQUIRED in the shipped CSS** (added 2026-06-28). primitives.css
  depends on the global `*{box-sizing:border-box}` from the app's index.css (which we do
  NOT sync). Without it, `.ds-section`'s 240px gutters add to element width → every section
  overflows ~480px → and `:has(.ds-root){overflow-x:clip}` makes the overflow unscrollable
  → the page renders off-center and horizontally locked in Claude Design. The regen command
  above ships the reset so the DS is self-sufficient standalone.
- Previews compose with realistic public marketing copy (FRE 707 / EU AI Act),
  not real customer/internal content — safe to keep.
