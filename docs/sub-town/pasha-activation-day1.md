# Pasha Activation — Day 1 Runbook

**Bead:** ai-gsa
**Audience:** Jake, executing in order on the day Pasha's MSA is countersigned through the moment Pasha successfully logs into John for the first time.
**Scope:** A single linear sequence. No architecture decisions, no rationale debates — those live in the source docs and are cross-referenced inline. If a step's source doc and this runbook disagree, the source doc wins and this runbook is wrong; file a `bd create` to correct.
**Not in scope:** Building any tooling. Everything below assumes the prerequisites from `04-onboarding-offboarding-runbook.md §0` are already green.

---

## Sources this runbook consolidates

| # | Source | Covers |
|---|--------|--------|
| S1 | `04-onboarding-offboarding-runbook.md` §0–§1 (the authority) | Prerequisites, Phase A paper, Phase B identity, Phase C tools, Phase D agent runtime, Phase D.1 session entry, Phase E week-1 verification |
| S2 | `pasha-call-quickref.md` "Getting into John" section | Pasha-facing first-session instructions, tmux/ssh pattern, what John can/can't do |
| S3 | `~/Downloads/pasha-welcome-DRAFT-2026-04-18.md` | The welcome PDF contractor receives with the URL |
| S4 | ADR-017 (signal/hail vocabulary) | Cross-silo comms wording used in this sequence |
| S5 | ADR-019 (Scout — one-shot plaza observer) | Week-1 observability posture for Pasha's first real session |
| S6 | `_templates/HANDOFF-john.md`, `_templates/john-session-entry.service` | Files required to boot John |

Each step below names its source so Jake can jump to the canonical text when off-shape happens.

---

## 0. Before you start the day

**You do not start Day 1 until all of these are true.** If any is false, stop and resolve; do not partial-activate.

- [ ] §0 prerequisites from `04-onboarding-offboarding-runbook.md` are green (sales sub-town scaffolded, dogfood tenant live, Brevo domain verified, contract templates in private repo, Apollo/Brevo/CRM provisioning paths documented, `incident-timeline.md` template exists).
- [ ] DNS + mailbox domain for the contractor (`sales.ailedger.dev` or chosen sender domain) is live. Blocked-by: **ai-lub**. If ai-lub is not closed, Day 1 does not start.
- [ ] `onboard-auth` worker (passkey + magic-link) is deployed and smoke-tested. Blocked-by: **ai-6qf** (merged). If it regresses, step 5 fails and Pasha cannot register.
- [ ] `_templates/HANDOFF-john.md` and `_templates/john-session-entry.service` exist under `~/gt-lab/docs/sub-town/_templates/`.
- [ ] PDF `~/Downloads/pasha-welcome-DRAFT-2026-04-18.pdf` has had Jake's final pass and is the version you intend to send.
- [ ] You have 3 hours of uninterrupted wall-clock time. Spread across the day is fine, but do not start Phase A and then drop off for 6 hours — the contractor is waiting.

Record `T+0` as the moment the countersigned MSA hits your inbox. All timestamps below are relative to that.

---

## 1. Paper (T+0 to T+30 min)

**Source:** S1 §1.A (Phase A — Paper first).

Before any system access. If Pasha refuses any of these, stop — do not provision anything.

- [ ] **1.1** Store the countersigned MSA + SOW at `legal/contractors/pasha/msa-sow.pdf`.
- [ ] **1.2** Send Pasha one email with four attachments:
  - Full executed MSA + SOW (PDF).
  - Standalone one-pager extracting **§3.9 (AILedger observability)** verbatim, prefaced with: *"Every prompt and response your agents send through our proxy is hashed and recorded into an immutable audit chain. We retain the chain. You do not. Do not send anything through these agents you would not want logged."*
  - Standalone one-pager extracting **§6.2 (return of confidential info)** verbatim.
  - The §1.A.1 Surfaces sheet (template in S1).
- [ ] **1.3** Wait for Pasha's reply containing the literal string `acknowledged: §3.9, §6.2, surfaces`. Save to `legal/contractors/pasha/acknowledgement.eml`.

**Expected outcome:** Countersigned paper stored; acknowledgement string received in writing.
**If off-shape:** If Pasha balks at §3.9 (observability) or §6.2 (return of info) after signing, do not proceed — mail Jake's counsel before any account creation. These clauses are load-bearing for the dogfood model; there is no "soft" version.
**Record to:** `legal/contractors/pasha/` (all of 1.1–1.3).

---

## 2. DNS + mailbox domain (verify, don't build — T+30 to T+40 min)

**Source:** S1 §0 (prerequisites) + bead **ai-lub**.

This runbook assumes ai-lub landed before Day 1. Re-verify at activation because DNS can silently break between setup and use.

- [ ] **2.1** `dig +short MX sales.ailedger.dev` returns Brevo (or chosen ESP) MX records.
- [ ] **2.2** `dig +short TXT sales.ailedger.dev` includes a `v=spf1` record that covers the chosen ESP.
- [ ] **2.3** DKIM selector resolves: `dig +short TXT <selector>._domainkey.sales.ailedger.dev` returns the DKIM pubkey the ESP registered.
- [ ] **2.4** DMARC record exists: `dig +short TXT _dmarc.sales.ailedger.dev` returns a `v=DMARC1` policy at least `p=quarantine`.
- [ ] **2.5** Brevo dashboard shows the domain as "verified" (not "pending").

**Expected outcome:** MX + SPF + DKIM + DMARC all resolve live; Brevo UI green.
**If off-shape:** If any record is missing, stop Day 1 here. Re-open ai-lub, do not attempt to fix DNS during activation. Reschedule Pasha for the next business day with a one-line note: *"Holding until sender infra verifies clean. Not a problem on your end."*
**Record to:** `legal/contractors/pasha/baseline.md` under a "DNS check, Day 1" heading with timestamps.

---

## 3. Mailbox + 1Password vault (T+40 to T+70 min)

**Source:** S1 §1.B (Phase B — Identity).

Identity first, then email, then secrets vault, then tools. A leak at any step does not cascade.

- [ ] **3.1** Create mailbox `pasha@sales.ailedger.dev` (or the chosen sender domain per ai-wuc). Do **not** set auto-forward to Pasha's personal address — the mailbox is the single identity anchor for everything downstream, including offboarding. Auto-forward is the silent-leak surface §2.B fights later; don't create it.
- [ ] **3.2** Create 1Password account using `pasha@sales.ailedger.dev`. Create vault `sales-contractor-pasha` (newly created, **not** the shared admin vault `sales-contractors`). Invite Pasha's new account to that vault only.
- [ ] **3.3** Ask Pasha to log in to the mailbox and to 1Password from his stated machine. Record the public IP from his email headers (the mailbox login triggers a confirmation email from 1Password) in `legal/contractors/pasha/baseline.md`.
  - Baseline IP is for later anomaly comparison only — not a blocker if it's a coffee-shop IP today; note it.

**Expected outcome:** Mailbox live, vault live, Pasha has authenticated into both from an IP you have on file.
**If off-shape:** If Pasha cannot log in (password reset loop, 2FA device not ready), pause here. Do not provision tools (step 4) against an identity Pasha cannot reach — you will have created credentials only Jake can access, which defeats the point.
**Record to:** `legal/contractors/pasha/baseline.md`.

---

## 4. Tool provisioning (T+70 to T+160 min)

**Source:** S1 §1.C (Phase C — Tools).

Provision in this exact order. After each, the credential goes into `sales-contractor-pasha` vault. Never send credentials in plaintext, never in Slack/Signal/SMS.

- [ ] **4.1 Apollo.** Default posture per ai-wuc: separate paid account billed to Joyner Ventures (cleaner offboarding). Credential → vault.
- [ ] **4.2 Brevo.** Create dedicated API key scoped to `sales.ailedger.dev` sender domain only. Credential → vault. Verify with one test send **to Pasha's mailbox** (not yours) — this also confirms step 3.1 mailbox receives mail, step 2 DNS signs it, and Brevo routes through the scoped key in one shot.
- [ ] **4.3 CRM.** Invite Pasha with role `sales-contractor` — **no admin, no export, no delete.** 2FA required at first login. Record the exact role string; mistyping to a permissive role here is §3's "accidental admin escalation" failure mode.
- [ ] **4.4 AILedger dogfood proxy key.** Generate a *contractor-scoped* proxy key for tenant `dogfood-sales`. Credential → vault. **Confirm in the AILedger dashboard that the key shows under tenant `dogfood-sales`, not under any production tenant.** Mis-scoped key here is the §D.1 failure mode "Proxy key not scoped to dogfood-sales" — if it lands on a production tenant, the §3.9 compliance posture collapses the moment Pasha sends his first prompt.
- [ ] **4.5 AI provider keys (OpenAI / Anthropic / Gemini).** Provision on separately-billable accounts owned by Joyner Ventures. Keys live **only** on the proxy worker side; Pasha never holds raw provider keys. Verification: try a direct provider call using Pasha's proxy key as if it were a raw key — should 401. If it doesn't, the proxy abstraction is broken; stop and escalate.
- [ ] **4.6 Shared Drive folder `Sales – Shared`.** Add `pasha@sales.ailedger.dev` with `Editor` role (not `Manager`).

**Expected outcome:** All six surfaces credential-issued to Pasha, all credentials in his 1Password vault, dogfood proxy key confirmed scoped to the right tenant, provider keys confirmed unreachable directly.
**If off-shape:** Any smoke test failure in 4.2 (Brevo test send doesn't arrive), 4.4 (key lands on wrong tenant), or 4.5 (direct provider call succeeds with proxy key) is a hard stop. Do not move forward to step 5 with broken infra — Pasha's first session will expose the break, and "the plumbing was broken all along" is a worse first impression than "we're holding until clean."
**Record to:** `legal/contractors/pasha/provisioning.md` — one line per surface with timestamp and the vault item name.

---

## 5. onboard-auth account + passkey registration (T+160 to T+175 min)

**Source:** S1 §1.D.1 provisioning bullets 1–3 (pre-flight) + bead **ai-6qf** (onboard-auth deployment).

Before John's session-entry UI can boot with Pasha's identity, Pasha must have a passkey registered against the `onboard-auth` worker. This is the "identity anchor" referenced in §D.1 step 4.

- [ ] **5.1** Confirm `~/gt-lab-sales/HANDOFF.md` exists and has not drifted since the last contractor baseline. If drifted, re-baseline from `~/gt-lab/docs/sub-town/_templates/HANDOFF-john.md` before adding Pasha-specific context.
- [ ] **5.2** Append a contractor-context block to `~/gt-lab-sales/memory/MEMORY.md` (NOT `HANDOFF.md`) naming Pasha, his SOW start date, and the in-scope surface list from step 1.2's §1.A.1 sheet. John reads memory on every session; this gives him the facts without baking Pasha's identity into the Mayor persona.
- [ ] **5.3** Flip `~/gt-lab-sales/config.json` from `status: "scaffolded_inactive"` to `status: "active"`. Until this flips, the session-entry URL refuses auth by design.
- [ ] **5.4** Email Pasha the passkey-registration URL from `onboard-auth` (magic link, one-time use, 15-minute TTL). He registers a passkey on the device he'll use for sessions.
- [ ] **5.5** Confirm in the `onboard-auth` admin view that Pasha's mailbox → passkey is bound. If not, the magic link was intercepted or expired; issue a new one, do not proceed with a second unbound link outstanding.

**Expected outcome:** `config.json` is `active`, memory has Pasha's context block, HANDOFF is clean, Pasha has a registered passkey bound to `pasha@sales.ailedger.dev`.
**If off-shape:** If 5.3 flips but 5.5 fails (passkey binding doesn't happen), **flip 5.3 back to `scaffolded_inactive`.** A live sub-town with no bound identity is a worse state than an inactive one; any opportunistic hit to the URL will get a login form against an empty identity store.
**Record to:** `legal/contractors/pasha/week1.md` under "Day 1 — identity provisioning."

---

## 6. First John session dry-run — Jake + Bob round-trip, no Pasha yet (T+175 to T+210 min)

**Source:** S1 §1.D.1 provisioning bullets 4–6 + S2 "Your first session with John" + ADR-017 (hail/signal vocabulary).

Before Pasha gets the URL, Jake and Bob (business-side Mayor) exercise the entire session path end-to-end. If anything is broken on this run, Pasha never sees it.

- [ ] **6.1** Start `john-session-entry.service` on the sub-town host, bound to `sales-town.joynerventures.com` (or the chosen hostname per ai-wuc). Unit template lives at `~/gt-lab/docs/sub-town/_templates/john-session-entry.service`. If missing, `bd create` for the template before continuing; do not improvise.
- [ ] **6.2** Confirm the UI fronts auth via the `onboard-auth` mailbox SSO + passkey from step 5 — **not** a separate password. The mailbox is the single identity anchor; when it dies at offboarding, session entry dies with it. This is load-bearing, not convenience.
- [ ] **6.3** Confirm `sales-agent` (not `jjoyner`) is the process owner of `john-session-entry.service`:
  ```bash
  ps -u sales-agent | grep john-session
  ```
  If it runs as `jjoyner`, **stop** — the Option B isolation boundary from ai-9is has been breached. No amount of application-layer auth will restore it. Diagnose and restart under the correct user before any login attempt.
- [ ] **6.4** Jake logs into the session-entry UI with his **own** onboard-auth account (Jake has one for this exact purpose; if not, provision one now — it's a one-time setup). Send one message to John in the UI.
- [ ] **6.5** Within 60 seconds of 6.4, confirm in the AILedger dashboard that the prompt landed in tenant `dogfood-sales`. If it does not appear, stop — the audit chain is not capturing session traffic. §3.9 compliance coverage is broken from the start. Do not proceed; escalate to Witness.
- [ ] **6.6** John files a test hail to Bob via the Plaza (the mechanism John uses when he needs to coordinate with Jake's business silo). Bob acknowledges receipt. This exercises the cross-silo path Pasha will later rely on when John needs business-side context for an outbound draft.
  - Command John uses (Jake observes in session): `echo "test hail from john, day-1 dry-run" | /srv/town/shared/bin/publish jake day1-dryrun-<YYYY-MM-DD>.md`
  - Bob's acknowledgement lands on Jake's terminal within seconds via `relayd`.
- [ ] **6.7** Jake logs out, kills the browser session, re-logs in with the same identity. Confirms his prior-conversation context is readable (persistence works — ai-b4q).

**Expected outcome:** UI runs under `sales-agent`, auth flows through onboard-auth, a Jake prompt lands in the dogfood chain within 60s, John and Bob complete one hail round-trip, session persistence confirmed.
**If off-shape:**
- **UI launches but auth fails against onboard-auth:** step 5 regressed. Re-verify 5.5 binding before any retry.
- **Prompt never reaches dogfood tenant:** proxy key mis-scoped (re-verify 4.4) or proxy worker not routing (escalate to Witness — production proxy health issue).
- **Hail to Bob times out:** Plaza publish path broken. File `bd create --priority=1`; do not activate Pasha — he'll blame himself when the first real cross-silo ask fails.
**Record to:** `legal/contractors/pasha/week1.md` under "Day 1 — dry-run results." Paste the dogfood tenant chain entry ID for 6.5; that's the evidence week-1 verification (step 8) will chain against.

---

## 7. Send Pasha the welcome PDF + URL (T+210 to T+220 min)

**Source:** S3 (`pasha-welcome-DRAFT-2026-04-18.md`), S1 §1.D.1 "First-contact protocol" paragraph, S2 "Your first session with John."

Only after step 6 is fully green. If any item in step 6 was yellow ("mostly worked, will fix later"), **do not send.** Pasha's first session will hit the yellow and it will read as incompetence.

- [ ] **7.1** Rebuild the welcome PDF with the final text:
  ```bash
  pandoc ~/Downloads/pasha-welcome-DRAFT-2026-04-18.md \
    -o ~/Downloads/pasha-welcome-$(date +%Y-%m-%d).pdf \
    --pdf-engine=xelatex -V geometry:margin=0.75in
  ```
- [ ] **7.2** Email Pasha from Jake's primary address (not a no-reply, not a shared alias) with three parts:
  - The welcome PDF attached.
  - The session-entry URL: `https://sales-town.joynerventures.com/`.
  - One line inline: *"Sign in with `pasha@sales.ailedger.dev` + your passkey. You'll land in a chat with an agent named John. Just say hi. That's the whole day-1 ask."*
- [ ] **7.3** Do **not** include any credentials in this email. All credentials are already in Pasha's 1Password vault (step 4). The email contains the URL and the identity he already registered in step 5; nothing secret.
- [ ] **7.4** Tell Pasha, in the same email or a short follow-up: *"If John is unreachable or the URL errors, text me. That's a me-problem, not a you-problem."* Mirrors S1 §1.D.1 first-contact protocol exactly.

**Expected outcome:** Pasha has the PDF and the URL, knows the identity to sign in with, knows the failure-escalation path is "text Jake" not "debug it yourself."
**If off-shape:** If Pasha replies asking about something the PDF already covers (CRM access, Apollo, provider keys), re-read the PDF draft — it may have drifted from what's actually provisioned. Don't answer ad-hoc; the PDF is the contract for what he expects.
**Record to:** `legal/contractors/pasha/week1.md` under "Day 1 — welcome sent," include the send timestamp and a pointer to the PDF version shipped.

---

## 8. Observe Pasha's first real session via Plaza signals (T+Pasha's first login, through EOD)

**Source:** S1 §1.E (Phase E — First-week verification, day 1 EOD item) + ADR-017 (signal vocabulary) + ADR-019 (Scout — one-shot observer).

Pasha's first login is not scheduled — it's whenever he opens the email and clicks. Could be 10 minutes after step 7, could be next morning. You observe, you do not drive.

- [ ] **8.1** Arm a Scout (ADR-019) on the `john-session-entry` access log to emit a signal (ADR-017) when Pasha's mailbox first authenticates. Scout auto-disarms after one hit — it is not a persistent monitor.
- [ ] **8.2** When the signal fires: within 5 minutes, check the AILedger dashboard and confirm Pasha's first prompt from that session landed in `dogfood-sales` (same verification as 6.5, now against Pasha's identity). This is the Day-1-EOD verification from §1.E line 1.
- [ ] **8.3** Do **not** join Pasha's session uninvited. John greets him; Pasha replies; that is a complete day-1 outcome per S3 ("first session should be a dry run — introduce yourself, ask him what he sees, stop there").
- [ ] **8.4** If Pasha texts with a blocker during his session, handle it in-line. If he completes without texting, send a short end-of-day note: *"Saw you made it in. Talk tomorrow."* Do not critique the session; Day-2 starts the real-work verification (§1.E line 2: `ledger.verify_chain()` on dogfood-sales).

**Expected outcome:** Pasha logged in once, his identity authenticated via onboard-auth, his first prompt chained into dogfood-sales, John greeted him professionally, he did not attempt outbound work.
**If off-shape:**
- **Scout fires but no prompt lands in dogfood:** Pasha hit the UI but couldn't or didn't send a message. Text him: *"Did you see John on your side? If the chat is blank or errored, text a screenshot."* Do not assume technical failure or user error — either is possible.
- **Pasha tries to send outbound email on day 1:** S3 and S1 §1.D.1 both explicitly hold outbound until Phase E day-2 chain verification. Text him to hold. This is expected; he's eager.
- **No login by EOD:** no action. Some contractors read paper for a day before touching tools. Day-2 check is the earliest you prompt.
**Record to:** `legal/contractors/pasha/week1.md` under "Day 1 EOD." Include Pasha's login timestamp, the dogfood chain entry ID of his first prompt, and a one-line subjective note (*"professional, no red flags"* / *"asked three good questions, stopped"* / etc.). §1.E week-review at day 7 reads these notes.

---

## Day 1 exit criteria

Day 1 is **done** when all of these are true:

- [ ] Paper stored and acknowledged (step 1).
- [ ] Sender-domain DNS verified live (step 2).
- [ ] Mailbox + vault provisioned and authenticated (step 3).
- [ ] All six tool surfaces credential-issued and vaulted (step 4).
- [ ] Passkey bound to Pasha's mailbox identity (step 5).
- [ ] Dry-run round-trip green: prompt → dogfood, John → Bob → John hail (step 6).
- [ ] Welcome PDF + URL sent from Jake's address (step 7).
- [ ] Pasha's first login chained into dogfood-sales with no errors (step 8).

Day 2 begins at the `ledger.verify_chain()` verification in §1.E line 2. That is not Day 1's concern.

---

## Cross-reference map

- Architecture / threat model underlying every isolation decision here: **ai-9is** (referenced throughout `04-onboarding-offboarding-runbook.md`).
- Per-credential provisioning + rotation specifics: **ai-wuc**.
- Dogfood tenant wire-up: **ai-8mv**.
- Contract clauses load-bearing here: **§3.9** (observability acknowledgement, step 1.2), **§6.2** (return of confidential info, step 1.2).
- Agent comms vocabulary (signal, hail, Scout): **ADR-017**, **ADR-019**.
- Full offboarding counterpart (not this runbook's scope): `04-onboarding-offboarding-runbook.md` §2 (amicable) and §3 (acrimonious). §D.1 "Cross-ref to offboarding" explicitly ties session-entry teardown back to §2.B.

## Failure-mode roll-up (shortlist from §5 of S1, applied to Day 1)

- **Auto-forward on the mailbox.** Don't create one at step 3.1. Easiest leak to forget, hardest to unwind at offboarding.
- **Proxy key scoped to wrong tenant.** Step 4.4 is the single check that catches this. Skipping it breaks §3.9 from the first prompt.
- **Session-entry URL live before `config.json` flip to `active`.** Step 5.3 is the flip. If the URL is live earlier, Pasha gets cryptic auth errors on day 1 and John looks broken when the problem is a config flag.
- **`john-session-entry.service` running under `jjoyner` instead of `sales-agent`.** Step 6.3 is the check. If it runs as Jake, Option B isolation from ai-9is is void; stop and restart under the correct user before any Pasha login.
- **Skipping `ledger.verify_chain()` later in the week.** Day 1 only chains evidence; Day 2's verify proves the chain is sound. If silently broken, §2.C offboarding audit-trail recovery has nothing to recover.

---

*Runbook consolidates: `04-onboarding-offboarding-runbook.md` §0–§1 + `pasha-call-quickref.md` + `pasha-welcome-DRAFT-2026-04-18.md` + ADR-017 + ADR-019 + sub-town templates. Each step names its source. If any step disagrees with its source, the source wins.*
