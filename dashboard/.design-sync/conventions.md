# AILedger Product App — conventions

The AILedger dashboard (the product web app). Styling is **Tailwind v4 utility
classes** plus a few brand hex surfaces. It is a **dark-first** product UI; a
light theme exists but the components are designed and tuned for dark.

## Theme (read this first)

The theme is driven by a class on the document root: **`html.dark`** (or
`html.light`) — see the app's `useTheme`. Most components hardcode their dark
surfaces, but the page chrome (`body`, `header`) keys off that class, so when
building a screen, set `<html class="dark">` (or render inside something that
does). Without it the page background falls back to the light default
(`#f8fafc`) and clashes with the dark components.

## Styling idiom: Tailwind v4 utilities + brand surfaces

Style with **Tailwind utility classes** — this app has no custom class system
and no CSS-var token layer. Use the real palette the components use:

**Surfaces (brand hex, via `bg-[#…]`)**: `#0f1117` (page background),
`#13151c` (panels / drawers), `#1a1d27` (cards / elevated rows). Plus
`bg-slate-800` for subtle fills and `bg-slate-900` for insets.

**Text**: `text-white` (headings), `text-slate-300` (body), `text-slate-400` /
`text-slate-500` (secondary / muted labels), `text-slate-600` (faint).

**Accent & status**: `bg-indigo-600` / `bg-indigo-500` (primary buttons),
`text-indigo-400` (links), `text-emerald-400` (success / live), `text-red-400`
(error), `text-amber-400` (warning).

**Borders & shape**: `border-slate-800` (default dividers), `border-slate-700`
(inputs), `rounded-lg` (cards/buttons), `rounded-full` (badges/pills).

**Type & spacing**: `text-xs` / `text-sm` / `text-lg`; padding lives on
`px-4 py-3` (buttons/rows), `px-3 py-2` (compact); `gap-2` / `gap-3` for flex.

## Components are data-bound app screens

These are real product screens, not leaf primitives. Most fetch their own data
from Supabase on mount (`LogTable`, `AdminLogs`, `ApiKeys`, `SystemSettings`,
`Billing`, `OnboardingChecklist`, `ReportGenerator`, `ChainIntegrityPanel`) and
take a `customerId` plus callbacks (`onUpgrade`, etc.). Prop-driven ones:
`Header` (a Supabase `session`), `UpgradeModal` (`feature`), `LogDetailDrawer`
(a `log` object). Overlays (`UpgradeModal`, `LogDetailDrawer`) root at
`fixed inset-0` — to embed one in a non-fullscreen layout, wrap it in an element
with a `transform` (that makes it the containing block for the fixed overlay).

## Where the truth lives

- **`styles.css`** → `_ds_bundle.css`: the compiled Tailwind stylesheet — every
  utility the app uses plus the `html.dark` / `html.light` theme rules.
- **`components/<group>/<Name>/<Name>.d.ts`**: each component's prop contract.
- **`components/<group>/<Name>/<Name>.prompt.md`**: per-component usage.

## One build snippet

```jsx
import { LogTable, Header } from '<pkg>'
// ensure <html class="dark"> is set for the page
<div className="min-h-screen bg-[#0f1117] text-slate-300">
  <Header session={session} theme="dark" onToggleTheme={…} onLogoClick={…} />
  <main className="dashboard-main px-5 py-6">
    <LogTable customerId={customerId} onUpgrade={…} />
  </main>
</div>
```
