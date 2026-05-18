# AILedger Proxy — Code Review Notes

**Started:** 2026-04-25
**Reviewer:** Jake (first end-to-end read of own codebase)
**Goal:** own every line of `proxy/src/index.ts`, the migrations, and the test surface. No enterprise customer-facing technical conversation should rely on code Jake hasn't read.

**Discipline:** capture findings as you read, don't fix mid-read. Fixing mid-read loses the thread and turns review into refactoring. One pass for understanding + capture, separate pass for fixes.

---

## Section index

When reading, fill in what each section/function does in plain English. The act of restating it in your own words is the point — if you can't restate it, you don't actually understand it yet.

### `src/index.ts` (1020 lines)

| Lines | Section / function | What it does (your words) | Notes |
|---|---|---|---|
| | | | |

### Migrations

| File | Purpose | Notes |
|---|---|---|
| `20260418_account_settings_delete_policy.sql` | | |
| `20260418_account_settings_delete_repro.sql` | | |
| `20260418_api_keys_system_id_set_null.sql` | | |
| `20260418_tamper_evident_chain.sql` (235 lines, the big one) | | |
| `20260421_attestations_table.sql` | | |

### Tests
| File | Coverage | Gaps you noticed |
|---|---|---|
| `test/index.spec.ts` (60 lines) | | |
| `test/jcs.spec.ts` (271 lines) | | |

---

## Findings

### F1. Bugs (real or suspected)

Format per finding:
- **Where:** file + line range
- **What:** plain-English description
- **Severity:** critical / high / medium / low
- **Evidence / repro idea:** how would you verify it's actually a bug
- **Fix idea:** rough — actual fix happens in a separate session

(none yet)

### F2. Mental-model gaps

Places where what you THOUGHT the code did differs from what it actually does. These are the highest-value findings of this exercise — they reveal assumptions you'd defend on a customer call but that aren't true.

(none yet)

### F3. Claim-vs-code drift

Places where a customer-facing claim (landing page, dashboard, README, pitch deck) is not directly backed by code. Per `feedback_claims_must_be_backed_by_code.md`, every technical claim has to be grep-verifiable.

Run during review:
```bash
# claims to verify against code:
# - "tamper-evident hash chain"
# - "no prompts stored"
# - "no outputs stored"
# - "SHA-256 fingerprints + metadata"
# - "regulator-ready Article 12 audit trail"
# - any specific perf / latency / SLA claim
```

(none yet)

### F4. Tedium / boilerplate that's fine

You'll feel pressure to "do something" with every section. Most code is fine. Use this section to mark things you've read, understood, and are explicitly not concerned about — so you don't keep re-reading them.

(none yet)

---

## Open questions for follow-up

Things to figure out *after* the read pass — research, ask someone, or experimentally verify.

(none yet)

---

## Architecture-from-memory whiteboard

Before reading the code: draw what you THINK is happening, photo or commit the diagram, then compare to reality during the read.

- [ ] Component diagram (Worker, R2, D1/Supabase, SDK, customer's app)
- [ ] Single-request flow (SDK → proxy → upstream LLM → audit log → response)
- [ ] Trust boundaries (where does auth happen, what's signed by whom)
- [ ] Failure modes (R2 down, chain write fails, concurrent writes, key rotation, upstream timeout)

**Whiteboard artifact:** [path or note when committed]
**Date drawn:** [YYYY-MM-DD]
**Date compared to code:** [YYYY-MM-DD]

---

## Session log

Track sessions to keep momentum honest — don't fool future-Jake about how much was actually read.

| Date | Section | Time spent | What got read | What's left |
|---|---|---|---|---|
| 2026-04-25 | (kickoff) | — | scaffolding this notes file | Tier 1 read |

---

*This file lives in the repo so it survives. When the review is complete, it becomes part of the audit-trail story Jake can show a security reviewer or a sophisticated buyer: "yes, I have personally read every line of this codebase, here are the notes I took."*
