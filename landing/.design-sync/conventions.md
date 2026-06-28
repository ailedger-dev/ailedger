# AILedger Marketing DS — conventions

A flat, **dark, single-palette** marketing/landing design language (extracted
from the `/hiring` page). Components are thin; the look lives in **`.ds-*`
utility classes + `var(--ds-*)` tokens**. There are no shadows and no
light/dark flip — the surface is always dark.

## Wrapping (required — read this first)

Every token is scoped to the **`.ds-root`** element and the dark surface + Inter
font are painted there. **Outside `.ds-root`, every `var(--ds-*)` resolves to
nothing and the design renders unstyled on white.** So always mount inside
`<PageShell>` (it renders `.ds-root`, paints the surface, and runs the
reveal-on-scroll observer over its `<section>` children). If you need the scope
without the observer, use a plain `<div className="ds-root">` instead.

```jsx
import { PageShell, Section, Eyebrow, DisplayHeading } from '<pkg>'

<PageShell>
  <Section pad="hero" ariaLabelledby="h">
    <Eyebrow>WHAT WE BELIEVE</Eyebrow>
    <DisplayHeading as="h1" id="h">Evidence you can take to court.</DisplayHeading>
    <p className="ds-lede">One tamper-evident record per model decision.</p>
  </Section>
</PageShell>
```

## The styling idiom: `.ds-*` classes + `--ds-*` tokens

Style with the design system's **own utility classes** for type and layout glue
— do not invent class names, and do not reach for Tailwind/inline colors. Use
the tokens (`var(--ds-*)`) for any custom value.

**Type classes** (carry the responsive ladder — prefer these over raw font
tokens): `.ds-display-xl`, `.ds-display-md`, `.ds-display-md--muted`,
`.ds-title-lg`, `.ds-title-md`, `.ds-lede`, `.ds-body`, `.ds-eyebrow`,
`.ds-label`, `.ds-link-sm`.

**Layout / chrome classes**: `.ds-root` (surface scope), `.ds-section` +
`.ds-section--{standard|hero|cta|topbar}` (vertical-rhythm tiers — set via the
`Section` `pad` prop, not by hand), `.ds-home` / `.ds-home__arrow` (back link),
`.ds-reveal` (opt a child into the fade+lift reveal), `.ds-focus` (focus ring).

**Color tokens**: `--ds-bg` (#08090A page surface — the only surface, no card
variant), `--ds-text-1` (headings/primary), `--ds-text-2` (secondary / `muted`),
`--ds-text-3` (decorative only — fails contrast for body text), `--ds-accent`
(links AND focus rings). **Other tokens**: `--ds-font-sans` (Inter, weights
400/500 only), `--ds-fs-*` / `--ds-lh-*` / `--ds-ls-*` (font-size/line-height/
letter-spacing, **px**), `--ds-space-*` (spacing scale, px), `--ds-measure*`
(text measure). Units are px throughout — never rem/em.

## Where the truth lives

- **`styles.css`** → `_ds_bundle.css`: the full class + token source. Read it
  before styling anything custom.
- **`components/ds/<Name>/<Name>.d.ts`**: the prop contract for each component.
- **`components/ds/<Name>/<Name>.prompt.md`**: per-component usage.

## Gotchas

- The `Section` `pad` prop is the only correct way to set section rhythm; pass
  `pad="none"` to opt out.
- `DisplayHeading` decouples visual scale from semantic level: `as="h1|h2|h3"`
  all render the same `.ds-display-md` size — use `as` for document structure,
  `muted` for the only visual variant.
- `Eyebrow` renders a `<p>`; give it an `id` to use as a heading's
  `aria-labelledby` target.
