#!/usr/bin/env node
// SEO build automation for the landing site.
//   node scripts/seo.mjs stamp   — postbuild: refresh lastmod / freshness dates in dist/
//   node scripts/seo.mjs check    — guardrail: assert built SEO matches seo.config.json
// Operates on the built artifact in dist/ so what ships is what's verified.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const config = JSON.parse(readFileSync(join(root, "seo.config.json"), "utf8"));
const today = new Date().toISOString().slice(0, 10);

const read = (p) => readFileSync(join(dist, p), "utf8");
const write = (p, s) => writeFileSync(join(dist, p), s);

function requireDist() {
  if (!existsSync(dist)) {
    console.error("seo: dist/ not found — run the build first.");
    process.exit(1);
  }
}

// --- extractors (controlled, hand-authored markup — regex is sufficient) ---
const getTitle = (html) => (html.match(/<title>([^<]*)<\/title>/i) || [])[1]?.trim();
const getMeta = (html, name) =>
  (html.match(new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, "i")) || [])[1];
const getProp = (html, prop) =>
  (html.match(new RegExp(`<meta\\s+property="${prop}"\\s+content="([^"]*)"`, "i")) || [])[1];
const getCanonical = (html) =>
  (html.match(/<link\s+rel="canonical"\s+href="([^"]*)"/i) || [])[1];

const splitKeywords = (s) => (s || "").split(",").map((k) => k.trim()).filter(Boolean);

function stamp() {
  requireDist();

  // sitemap.xml — bump <lastmod> for the configured locs to the deploy date.
  let sitemap = read("sitemap.xml");
  for (const loc of config.stampSitemapLocs) {
    const re = new RegExp(
      `(<loc>${loc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</loc><lastmod>)[^<]*(</lastmod>)`,
    );
    sitemap = sitemap.replace(re, `$1${today}$2`);
  }
  write("sitemap.xml", sitemap);

  // llms.txt — refresh a freshness footer only; prose is hand-maintained.
  if (existsSync(join(dist, "llms.txt"))) {
    let llms = read("llms.txt").replace(/\n*_Last updated: \d{4}-\d{2}-\d{2}\._\s*$/s, "");
    llms = `${llms.replace(/\s*$/, "")}\n\n_Last updated: ${today}._\n`;
    write("llms.txt", llms);
  }

  console.log(`seo: stamped lastmod/freshness to ${today}`);
}

function check() {
  requireDist();
  const html = read("index.html");
  const errors = [];

  const title = getTitle(html);
  if (title !== config.title) errors.push(`title: expected "${config.title}", got "${title}"`);

  const desc = getMeta(html, "description");
  if (desc !== config.description)
    errors.push(`description: expected "${config.description}", got "${desc}"`);

  const kw = splitKeywords(getMeta(html, "keywords"));
  const expected = config.keywords;
  if (kw.length !== expected.length || kw.some((k, i) => k !== expected[i]))
    errors.push(`keywords: expected [${expected.join(", ")}], got [${kw.join(", ")}]`);

  const canonical = getCanonical(html);
  if (canonical !== config.canonical)
    errors.push(`canonical: expected "${config.canonical}", got "${canonical}"`);

  for (const prop of ["og:title", "og:description"]) {
    if (!getProp(html, prop)) errors.push(`missing ${prop}`);
  }

  // sitemap: well-formed-ish + every file-like <loc> resolves to a real artifact.
  const sitemap = read("sitemap.xml");
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  if (locs.length === 0) errors.push("sitemap: no <loc> entries");
  for (const loc of locs) {
    const path = loc.replace(/^https?:\/\/[^/]+/, "");
    // Only file-like paths (with an extension) must exist on disk; extensionless
    // paths are SPA client routes served via the index.html fallback.
    if (/\.[a-z0-9]+$/i.test(path)) {
      const rel = path.replace(/^\//, "");
      if (!existsSync(join(dist, rel)))
        errors.push(`sitemap: <loc> ${loc} has no file in dist (soft-404)`);
    }
  }

  if (errors.length) {
    console.error("SEO check failed:\n  - " + errors.join("\n  - "));
    process.exit(1);
  }
  console.log("SEO check passed.");
}

const cmd = process.argv[2];
if (cmd === "stamp") stamp();
else if (cmd === "check") check();
else {
  console.error("usage: seo.mjs <stamp|check>");
  process.exit(1);
}
