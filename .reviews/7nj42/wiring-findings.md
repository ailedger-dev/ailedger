---
leg_id: wiring
review_target: proxy/src/index.ts
reviewer: ailedger/polecats/dust
formula: code-review
focus: Installed-but-not-wired gaps
---

# Wiring Review

## Summary

`proxy/src/index.ts` is largely well-wired. The single runtime dependency
(`canonicalize`) is imported and used in the JCS hash path; every field on the
`Env` interface is referenced in code; the `AILEDGER_CACHE` KV binding is
declared in both top-level and `staging` environments in `wrangler.jsonc` and
is read/written. The 2026-04-30 email-stack rip-out (commit 5651420) cleanly
removed `RESEND_API_KEY` from `Env` and gutted `sendWelcomeEmail`,
`sendPasswordResetEmail`, `runDripEmails`, and `sendDripEmail`.

The wiring problems left behind by that rip-out are config-shaped, not
import-shaped: a cron trigger that still fires daily into a no-op handler, a
`handleSignupHook` body that still parses Supabase `email_data` and builds a
magic link only to drop both into `console.log`, and stale wrangler.jsonc
comments asserting an EU "morning send-slot" optimization for a cron that no
longer sends anything. These are exactly the "dead config that suggests
incomplete migration" pattern the brief calls out.

## Critical Issues

(none)

## Major Issues

### M1 — Cron trigger still registered for an intentionally no-op handler

- **Where:** `proxy/wrangler.jsonc:33` (`"crons": ["13 7 * * *"]`) +
  `proxy/src/index.ts:33-37` (`scheduled` handler is a comment-only stub).
- **Impact:** Cloudflare will continue to invoke this Worker at 07:13 UTC
  every day. The handler runs, does nothing, and returns. Each firing is a
  billed cron invocation and a Worker cold-start (logs, observability events,
  and the `compatibility_flags: ["nodejs_compat", ...]` boot tax) for zero
  user-visible work. It also clouds dashboards: every "scheduled" entry in
  Workers Analytics is now noise.
- **Why this is a wiring gap:** the implementer removed `runDripEmails` (the
  only thing the cron existed to call) but left the trigger installed, exactly
  the "config defined but never loaded" failure mode.
- **Suggested fix:** drop the cron trigger from both production and `staging`
  in `wrangler.jsonc` (staging already has `"crons": []`, so production should
  match) AND delete the now-misleading EU-send-slot comment block on
  `wrangler.jsonc:27-33`. When Gmail-API replacement lands, the trigger
  re-installs in the same commit that wires the new send path — that keeps
  config and code in lockstep. If keeping the trigger is a deliberate "don't
  let the schedule rot" decision, document that explicitly in the handler
  comment so the next reviewer doesn't repeat this finding.

### M2 — `wrangler.jsonc:27-33` cron comment block describes behavior the code no longer has

- **Where:** `proxy/wrangler.jsonc:27-33` — the multi-line comment justifies
  the 07:13 UTC slot in terms of "EU morning commute / coffee window",
  "AILedger ICP = EU AI Act compliance officers", "morning-inbox-in-CET is
  the optimized send-slot", and "Minute 13 avoids stacking with :00 / :30
  cohorts."
- **Impact:** The cron fires a no-op (see M1); none of these justifications
  apply. A future contributor reading this comment will believe drip emails
  ship at 07:13 UTC and may build downstream assumptions on it (e.g. tuning
  Supabase queries to a 07:13 burst that does not exist).
- **Suggested fix:** if M1 is taken, the comment block goes with the trigger.
  If the trigger is kept as a placeholder, replace the comment with a single
  line: "Cron retained as a placeholder; handler is a no-op until Gmail API
  send path is wired (see commit 5651420)."

## Minor Issues

### m1 — `handleSignupHook` parses `email_data` and builds `magicLink` only to log them

- **Where:** `proxy/src/index.ts:609-628`. `emailData`, `actionType`,
  `tokenHash`, `redirectTo`, and `magicLink` are computed; the only consumer
  left is the `console.log` on line 628.
- **Impact:** Each signup-hook invocation does a JSON parse + a URL-encoding +
  a string interpolation whose only effect is a log line that contains a
  one-time-use Supabase auth `token_hash`. That's a verification token landing
  in Workers logs (Cloudflare Logs / observability sinks) on every signup,
  which is mild credential leakage even though the token is short-lived and
  single-use. The pre-rip code at least immediately consumed the token by
  sending the email; now the token sits in log storage.
- **Suggested fix:** either (a) gut the email-data parsing to match the
  scheduled-handler stub pattern (just `console.log("signup-hook: email
  suppressed (action=...) for <email>")` without `magicLink`, since no one is
  consuming it), or (b) keep the parsing but redact the token in the log
  (`magicLink=<suppressed: token>`). Option (a) is cleaner and matches how the
  scheduled handler was stubbed — leave the wiring gap in one place, not two.

### m2 — Comment-only "tombstone" block at index.ts:686-689 is non-load-bearing

- **Where:** `proxy/src/index.ts:686-689`. Four lines of comments noting that
  `runDripEmails` used to live here.
- **Impact:** Cosmetic. `git log` and the changelog already capture this; the
  comment will rot. Not a wiring bug — flagged only because the brief asks
  about old patterns left behind.
- **Suggested fix:** drop the block; the commit message is the durable record.
  Optional, low priority.

## Observations

- **`canonicalize` (package.json:20) is properly wired.** Imported at
  `index.ts:14`, used in `sha256jcs` at `index.ts:507`. The CHANGELOG entry
  and the inline rationale at `index.ts:467-488` justify the choice. Clean.
- **`Env` interface alignment is clean.** All six fields
  (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `SUPABASE_HOOK_SECRET`, `AILEDGER_CACHE`) are
  referenced. `RESEND_API_KEY` was correctly removed in commit 5651420 and
  no stale references remain in this file (only the historical mention in
  the comment block at line 688).
- **`AILEDGER_CACHE` KV binding** is declared in `wrangler.jsonc` for both
  the top-level production env (id `993c05bf...`) and `staging`
  (id `51d2b9f2...` — filled in by commit 924b8ff). Used in `resolveApiKey`
  (lines 528, 550) and `checkUsageLimit` (lines 636, 655). ✓
- **`verifyStandardWebhook` (index.ts:568) is still correctly wired** at
  `index.ts:596`, even though the email send paths it gated are gone. This
  is the right call — the signature check belongs there regardless of what
  happens after the parse, and it prevents an unauthenticated endpoint from
  being a free Supabase parser.
- **`devDependencies` audit:** `@cloudflare/vitest-pool-workers`, `vitest`,
  `wrangler`, `typescript`, `@types/node` — all standard tooling, all
  expected to be referenced indirectly via config files (`vitest.config.mts`,
  `tsconfig.json`, `wrangler.jsonc`). No stranded devDeps.
- **Outside this file's scope but worth noting for the convoy:** the commit
  message for 5651420 lists "wrangler secret delete RESEND_API_KEY across
  proxy + contractor-auth + onboard-auth envs" as a Jake-side pending action.
  If that hasn't run yet, the Worker still has a stale secret bound at the
  edge that no code reads — out of scope here (config lives in CF dashboard,
  not in the repo) but the integration-review leg may want to check.
