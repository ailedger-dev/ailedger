# Genesis prompt — AILedger Product App

Seed prompt for the Claude Design project
(https://claude.ai/design/p/5a265513-32bc-483e-9161-20b5d2125b06). Paste into the
design agent to start building on-brand.

```
Build the AILedger dashboard's main "Inference Logs" screen using this design
system's real components, in the brand DARK theme.

First: set <html class="dark"> (the components are tuned for dark; the page
defaults to light and will clash otherwise). Wrap the page in
`min-h-screen bg-[#0f1117] text-slate-300`.

Compose, top to bottom:
- <Header session={…} theme="dark" onToggleTheme onLogoClick /> — the top bar.
- A <main className="dashboard-main px-5 py-6"> containing:
  - <LogTable customerId={…} onUpgrade={…} /> — the primary log table (it
    includes the usage meter + chain-integrity panel).
  - A row linking to <ApiKeys>, <Billing>, and <SystemSettings>.
- Wire <UpgradeModal feature="report" …> behind a "Export report" action and
  <LogDetailDrawer log={…} …> behind a row click.

Style with Tailwind utilities only — no custom classes. Use the brand palette:
surfaces #0f1117 / #13151c / #1a1d27, text text-white / text-slate-300 /
text-slate-400, accent bg-indigo-600 + text-indigo-400, status text-emerald-400
(live) / text-red-400 (error), borders border-slate-800, rounded-lg. These are
data-bound screens — show realistic populated rows. Read styles.css and each
component's .d.ts first.
```
