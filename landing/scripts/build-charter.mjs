// Renders the public charter page from the canonical source in ailedger-dev/charter.
//
// Single source of truth: the charter TEXT lives in ailedger-dev/charter
// (CHARTER.md). This page is a generated artifact — never hand-edit
// public/charter/index.html; it is rebuilt on every `npm run build`.
//
// The default ref is `main`, so the page mirrors whatever's live in the
// charter repo on the next site rebuild. Override with CHARTER_REF=<tag|sha>
// when a build must pin to a specific release. The version string shown on
// the page is read from the CHARTER.md H1, so it tracks the source.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const here = dirname(fileURLToPath(import.meta.url));
const landingRoot = resolve(here, '..');

const REPO = 'ailedger-dev/charter';
const REF = process.env.CHARTER_REF || 'main';
const SRC_URL = `https://raw.githubusercontent.com/${REPO}/${REF}/CHARTER.md`;
const TEMPLATE = resolve(here, 'charter-template.html');
const OUT = resolve(landingRoot, 'public/charter/index.html');

async function fetchCharter() {
  const res = await fetch(SRC_URL);
  if (!res.ok) {
    throw new Error(`charter: failed to fetch ${SRC_URL} — ${res.status} ${res.statusText}`);
  }
  return res.text();
}

// Relative links to sibling charter docs (e.g. ./STANDARDS.md) → absolute
// GitHub blob URLs. These track the charter repo's main branch (matching the
// "Source on GitHub" link in the template) rather than the pinned content ref,
// since STANDARDS.md updates without a Charter version bump.
function rewriteRepoLinks(html) {
  return html.replace(
    /href="\.?\/?([A-Za-z0-9_.-]+\.md)"/g,
    (_match, file) => `href="https://github.com/${REPO}/blob/main/${file}"`,
  );
}

// Charter convention: a paragraph beginning with '*' is a footnote.
function markFootnotes(html) {
  return html.replace(/<p>(\*)/g, '<p class="footnote">$1');
}

const md = await fetchCharter();

// First H1 carries the title + version; the rest of the document is the body.
const lines = md.split('\n');
const h1Index = lines.findIndex((l) => /^#\s+/.test(l));
if (h1Index === -1) throw new Error('charter: no H1 title found in CHARTER.md');
const h1 = lines[h1Index].replace(/^#\s+/, '').trim();
const versionMatch = h1.match(/v(\d+(?:\.\d+)+)/i);
const version = versionMatch ? versionMatch[1] : REF.replace(/^v/, '');
const bodyMd = lines.slice(h1Index + 1).join('\n').trim();

let body = marked.parse(bodyMd);
body = rewriteRepoLinks(body);
body = markFootnotes(body);

const html = readFileSync(TEMPLATE, 'utf8')
  .replaceAll('{{VERSION}}', version)
  .replace('{{CHARTER_BODY}}', body.trim());

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(`charter: rendered ${REPO}@${REF} (v${version}) → public/charter/index.html`);
