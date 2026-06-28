# Genesis prompt — AILedger Marketing DS

Seed prompt for the Claude Design project
(https://claude.ai/design/p/702ae72d-518a-4188-8e18-6952d0ed2728). Paste into the
design agent to start building on-brand.

```
Build the AILedger landing hero + "why it matters" section using ONLY this
design system's components — no new primitives, no Tailwind, no invented classes.

AILedger makes every AI model decision a tamper-evident, court-admissible record
(Federal Rule of Evidence 707; EU AI Act Articles 12, 19, 26).

Use:
- <PageShell> as the root (it paints the dark .ds-root surface + Inter and owns
  the reveal-on-scroll observer). Everything mounts inside it.
- <Section pad="hero"> for the hero, <Section pad="standard"> for the body,
  <Section pad="cta"> to close.
- <Eyebrow> for the uppercase kicker over each heading.
- <DisplayHeading as="h1"> for the hero headline; as="h2" for section headings;
  add muted for de-emphasized CTA copy.
- <BackHomeLink> only if a standalone sub-page needs nav chrome.
- Body/lede text: the .ds-lede and .ds-body utility classes. Color via the
  --ds-text-1 / --ds-text-2 tokens; accent/links via --ds-accent.

Keep it flat — no shadows, no cards, single dark surface (#08090A). Three
sections: hero (eyebrow + headline + lede), a 3-point "what we believe" body,
and a closing CTA. Read styles.css first for the exact token/class vocabulary.
```
