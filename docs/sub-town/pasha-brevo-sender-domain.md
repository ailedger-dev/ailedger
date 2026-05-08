> ⚠ **DEPRECATED 2026-04-30** — Per Jake universal directive, the email stack is now **Google only**. Brevo and Resend are being ripped out (account closures pending). Do NOT follow any setup steps in this document that reference Brevo, Resend, or any non-Google email relay. The Gmail-API replacement runbook supersedes this. See `~/gt-lab/memory/feedback_email_stack_google_only.md`.

---

# Pasha Outbound: Brevo Sender Domain DNS + Account Setup

**Bead:** ai-3fc
**Audience:** Jake, clicking through each step in person when Pasha graduates from Day-1 (auth-only) to prospect outbound.
**Scope:** Brevo account creation, sender-domain authentication for `ailedger.dev`, the exact DNS records to plant in Cloudflare, the verification test procedure, and per-plan rate-limit expectations so you don't discover the cap during a real campaign.
**Not in scope:** Creating the Brevo account on Pasha's behalf (Jake does this personally — see §2), Apollo/CRM provisioning (runbook §1.C), writing the actual campaigns (Pasha's own agent work, gated on this doc being green).

**Authority:** `docs/sub-town/04-onboarding-offboarding-runbook.md` §1.A.1 (Surfaces sheet — Brevo listed as in-scope for the contractor), §1.C (Brevo key scoped to sender domain, vaulted), §1.E day-3 check (first outbound lands with SPF/DKIM/DMARC pass), `docs/sub-town/pasha-day1-dns-mailbox.md` (the auth-mail DNS baseline this doc extends, not replaces), Brevo developer docs (`developers.brevo.com`).

> **Read-before-you-click:** §1 is the load-bearing section. The runbook §1.A.1 calls the sender domain `sales.ailedger.dev` — but after the Day-1 DNS work, `sales.ailedger.dev` is a Cloudflare-proxied CNAME to the `onboard-auth` worker. You cannot cleanly plant mail records alongside a CNAME (RFC 1912 §2.4). §1 picks the right subdomain and flags the runbook edit that needs to follow.

---

## 0. Prerequisites (before you touch Brevo)

Do these once. If any is missing, stop and file a `bd create` — do not improvise.

- [ ] Day-1 DNS is green. Confirm: `~/bin/pasha-day0-smoke.sh onboard-auth.<your-subdomain>.workers.dev` exits 0. Without this, you are stacking Brevo records on top of unverified infrastructure.
- [ ] Pasha's mailbox `pasha@ailedger.dev` is live and receiving. Confirm: you can send a test mail to it from your personal Gmail and see `dkim=pass`, `spf=pass` in the headers. This matters because Brevo's verification emails land there during §2.
- [ ] You have decided the Brevo plan tier. §5 walks through the caps; if you haven't read §5, read it **before** creating the account — the free tier's 300/day cap will bite a real campaign within an hour.
- [ ] 1Password vault `sales-contractor-pasha` exists with the Day-1 credentials already dropped in. The Brevo API key goes there in §2.5.
- [ ] You have ~45 minutes of contiguous time. Brevo's domain verification is usually near-instant but DKIM propagation through Cloudflare + Brevo's re-check loop can stretch to 2h in the pathological case. Don't start this at 11pm the night before a send.

---

## 1. Architecture decision: which subdomain is the Brevo sender? (5 min, decide once)

**TL;DR:** Authenticate `mail.ailedger.dev` in Brevo, not `sales.ailedger.dev` and not the root `ailedger.dev`. Header-From stays `pasha@ailedger.dev` for readability; DMARC relaxed alignment (already configured) passes.

### 1.1 — Why not `sales.ailedger.dev` (the runbook's literal text)

Runbook §1.A.1 line 44 says "Brevo sender domain `sales.ailedger.dev`" — but that text predates the Day-1 work. As of Day-1 DNS:

- `sales.ailedger.dev` is a **CNAME** (Proxied, orange-cloud) pointing to `onboard-auth.<your-subdomain>.workers.dev`.
- RFC 1912 §2.4: a host with a CNAME record MUST NOT have any other record types. TXT/MX records alongside a CNAME are undefined behavior. Cloudflare's DNS editor will accept sibling records but some resolvers (particularly strict corporate resolvers at prospect sites) will refuse to resolve them — meaning your cold-outreach DKIM lookup fails at exactly the recipient you most want to reach.
- Even if you bypass that with Cloudflare flattening, you are now sharing Pasha's cold-outreach reputation with the auth worker's landing page. One spam complaint on a cold email drops the reputation of the subdomain the onboard-auth worker lives on. Bad trade.

**Action:** after §2–§4 land green, edit runbook §1.A.1 and §1.C to say `mail.ailedger.dev`. File as a follow-up bead; do not block this setup on it.

### 1.2 — Why not the root `ailedger.dev`

Technically works. SPF budget is the constraint:

- Root SPF already carries `include:_spf.google.com` (~3 lookups) + `include:amazonses.com` (~2 lookups) = ~5 of the 10 DNS-lookup cap used.
- Brevo's `include:spf.brevo.com` adds ~2–3 more. You end up at ~7–8, one provider change from PermError.
- Reputation is also mixed: a Pasha cold-outreach complaint drops the reputation of Jake's auth mail and any Workspace sends from `jake@ailedger.dev`.

Only use the root if you are certain you will never add another sender.

### 1.3 — Why `mail.ailedger.dev` (recommended)

- **Zero CNAME conflict.** `mail.ailedger.dev` has no existing records. Plant anything.
- **Isolated SPF.** The subdomain gets its own SPF TXT: `v=spf1 include:spf.brevo.com ~all`. Root SPF is unaffected.
- **Isolated DKIM.** Brevo's DKIM selector lives at `brevo1._domainkey.mail.ailedger.dev` — entirely separate key from the Resend/Workspace DKIMs on the root.
- **DMARC still passes.** The existing `_dmarc.ailedger.dev` record covers all subdomains (organizational-domain lookup) and uses `adkim=r; aspf=r` (relaxed alignment). Header-From `pasha@ailedger.dev` + DKIM signature on `mail.ailedger.dev` → same organizational domain → DMARC alignment passes.
- **Clean offboarding.** When Pasha's engagement ends, delete the four `mail.ailedger.dev` records and revoke the Brevo API key. No cross-cutting touch to the auth or Workspace stack.

### 1.4 — Header-From vs envelope-From (one line you will get asked about)

- **Envelope-From / Return-Path / MAIL FROM:** Brevo-controlled, on `mail.ailedger.dev` (bounces go to Brevo for processing). Invisible to recipients.
- **Header-From (what prospects see):** `Pasha <pasha@ailedger.dev>`. Configured in Brevo's sender profile in §2.4.
- **Reply-To:** `pasha@ailedger.dev`. Replies land in his Workspace inbox — that's the whole point of the Day-1 mailbox setup.
- DKIM alignment check: signature `d=` tag will be `mail.ailedger.dev`; header-From domain is `ailedger.dev`; organizational domain matches; `adkim=r` → aligned.

---

## 2. Brevo account setup (30 min, Jake-run only)

**Off-limits for agents, including polecats, including Pasha's own agent:** Brevo account creation. The account owner becomes the billing/legal principal for every send. That is Jake, personally, signed in from his own browser with his own 2FA device. Do not delegate.

### 2.1 — Create the account

- [ ] Go to `brevo.com` → Sign Up. Use email `jake@ailedger.dev` (not your personal Gmail — you want admin authority on the same domain as the mailboxes this account will send as).
- [ ] Company name: `Joyner Ventures` (legal entity, not `AILedger` — the latter isn't the billable principal).
- [ ] Enable 2FA **before** you log out of the first session. Brevo → My Account → Security → Two-factor authentication. Use the 1Password TOTP, not SMS.
- [ ] Drop the Brevo login credentials into 1Password vault `sales-contractor-pasha` under item `brevo-account-jake`. The contractor never gets this login — they get an API key in §2.5, not account access.

### 2.2 — Pick the plan

Read §5 first. As of 2026-04, the relevant ladder for MVP prospect outbound is:

- **Free** — 300 emails/day, no daily cap removal, no A/B testing, Brevo footer on every send. Good for the first verification test send in §4, **not** for real campaigns (one mid-sized campaign blows the cap in 20 minutes).
- **Starter** — starts ~$9/mo for 20k/mo, no daily cap, Brevo footer removable as add-on. This is the MVP-right tier.
- **Business** — adds send-time optimization, A/B testing, predictive analytics. Worth it after Pasha's volume justifies optimization — not on day one.
- **Enterprise** — dedicated IP, custom SLAs. Do not start here.

Recommendation: **Starter** from the outset. The $9/mo is cheaper than the time lost rebuilding campaigns around the 300/day free cap.

### 2.3 — Disable the things that default ON

Brevo ships with conveniences that are traps for a cold-outreach sender:

- [ ] Brevo → Senders & IP → Senders → **Uncheck** "Use Brevo's tracking domain on click links." If left on, every click URL in Pasha's mail points at `r.brevo.com/...` — a well-known ESP tracking domain that spam filters grade down. §3.5 sets up `em.ailedger.dev` as a Brevo-owned branded tracking CNAME instead.
- [ ] Brevo → Account → Settings → Disable "Automatic list cleaning suggestions" — Pasha's list curation is his job, not Brevo's heuristic's.
- [ ] Brevo → Contacts → Settings → Disable "Double opt-in default." For B2B cold outreach under CAN-SPAM, double opt-in is not required and will confuse the compliance story. If you later add a newsletter surface, turn it back on for that list only.
- [ ] Brevo → Campaigns → Settings → Disable "Add default unsubscribe footer" **only if** you will implement your own CAN-SPAM-compliant unsubscribe in the campaign template itself. If unsure, leave this ON — unsubscribe coverage is non-negotiable.

### 2.4 — Create the sender identity

- [ ] Brevo → Senders & IP → Senders → Add a sender.
  - Name: `Pasha (AILedger Sales)`
  - Email: `pasha@ailedger.dev`
  - Company info: fill in the Joyner Ventures registered address (CAN-SPAM §5 requires a physical postal address in the message footer; Brevo uses this automatically).
- [ ] Brevo will send a verification email to `pasha@ailedger.dev`. Sign in to the Workspace mailbox, click the verification link. The sender shows "Verified" after the click — record timestamp in your working notes.

### 2.5 — Generate the scoped API key

- [ ] Brevo → SMTP & API → API Keys → Generate a new API key.
  - Name: `pasha-outbound-v1`
  - Scope: as of 2026-04 Brevo's v3 API keys are account-scoped, not domain-scoped. The runbook §1.C wording ("scoped to `sales.ailedger.dev` sender domain only") is aspirational; enforce scoping at the agent-runtime layer instead: Pasha's agent code MUST set the `sender.email` field to `pasha@ailedger.dev` on every send, never read it from a variable. Code-review this explicitly.
- [ ] Copy the key value once (Brevo will not show it again). Drop into 1Password vault `sales-contractor-pasha` under item `brevo-api-key-pasha-outbound-v1`. Add a note: "Rotate every 30 days per runbook §1.C; rotate immediately if Pasha's agent runtime is compromised."
- [ ] Confirm the key works from your laptop (not from the agent runtime — that comes later):
  ```bash
  curl --request GET \
       --url https://api.brevo.com/v3/account \
       --header 'accept: application/json' \
       --header "api-key: $BREVO_API_KEY"
  ```
  Should return the account JSON. A 401 means you copied the key wrong.

---

## 3. DNS records in Cloudflare (15 min clicking, +30 min propagation)

All records go on `mail.ailedger.dev`, not the root. Brevo → Senders & IP → Domains → Add a domain → enter `mail.ailedger.dev`. Brevo shows you the exact records; **copy them verbatim** from the Brevo dashboard — do not hand-type selector names, do not guess the key value.

### 3.1 — Brevo domain verification (one-time)

- [ ] Brevo gives you a TXT record like:
  ```
  Type: TXT   Name: brevo-code.mail   Value: <short alphanumeric string Brevo generates>
  ```
  (The exact record name varies: sometimes `brevo-code` on the subdomain, sometimes a random-hashed name. Copy verbatim.)
- [ ] Cloudflare → `ailedger.dev` → DNS → Records → Add record. **Proxied: OFF** (grey cloud). TXT records cannot be proxied.

### 3.2 — SPF on the subdomain

- [ ] Add TXT record:
  ```
  Type: TXT   Name: mail   Value: v=spf1 include:spf.brevo.com ~all   TTL: Auto   Proxied: OFF
  ```
- [ ] **Do NOT** merge this into the root SPF. Subdomain SPF is looked up independently when the envelope-from domain is `mail.ailedger.dev`. Keeping them separate is the entire point of §1.3's reputation isolation.
- [ ] Confirm the root SPF is unchanged:
  ```bash
  dig +short TXT ailedger.dev | grep v=spf1
  # should still show: "v=spf1 include:_spf.google.com include:amazonses.com ~all"
  ```
  If this record mutated while you were in the DNS editor, revert immediately — you just broke auth mail and Workspace sends.

### 3.3 — DKIM CNAMEs (usually 2, occasionally 1 or 3)

Brevo's DKIM has varied over the years. As of 2026-04, expect **2 CNAME records**:

- [ ] Brevo will show something like:
  ```
  Type: CNAME   Name: brevo1._domainkey.mail   Target: brevo1._domainkey.brevo.com
  Type: CNAME   Name: brevo2._domainkey.mail   Target: brevo2._domainkey.brevo.com
  ```
  **Copy verbatim.** Brevo occasionally changes selector numbering per-account; hand-typing `brevo1` when your account got `brevo3` is the most common failure mode here.
- [ ] Cloudflare → add both as CNAME, **Proxied: OFF** (grey cloud). Proxying a DKIM CNAME rewrites the value and breaks verification — same rule as the Resend DKIMs in the Day-1 doc §2.2.

If Brevo shows a **TXT** record for DKIM instead of a CNAME (older account style, rare post-2024):

- [ ] Add as TXT, Proxied: OFF. The value is ~400 characters; copy in one go. Cloudflare's editor accepts the full string without splitting.

### 3.4 — Return-path / bounce CNAME (if Brevo provides one)

Some Brevo account tiers ship a bounce-handling CNAME. If present:

- [ ] Add as CNAME, Proxied: OFF. Typical shape: `Name: bounces.mail   Target: <brevo-provided>.brevomail.com` — copy verbatim.

If Brevo doesn't show this record for your account, skip. Brevo will fall back to its shared bounce infrastructure; this is fine for MVP.

### 3.5 — Branded tracking subdomain: `em.ailedger.dev` (optional, recommended)

Brevo rewrites outbound URLs to go through a tracking domain so clicks register. Default is `r.brevo.com` — a known ESP tracking domain that spam filters heavily penalize. Branded tracking uses your domain instead.

- [ ] Brevo → Senders & IP → Branded Domains → Add → enter `em.ailedger.dev`.
- [ ] Brevo shows a CNAME target. Add in Cloudflare:
  ```
  Type: CNAME   Name: em   Target: <brevo-provided>.brevomail.com   TTL: Auto   Proxied: OFF
  ```
- [ ] In Brevo, mark the branded domain as "Verify" once DNS propagates (~5 min typically). The tracked click URLs in Pasha's sends now read `https://em.ailedger.dev/...` instead of `https://r.brevo.com/...`.

Worth it for deliverability: prospects' corporate spam filters see the links originate from the same org domain as the sender, and grade the mail accordingly.

### 3.6 — What you did NOT touch

Explicitly, the following records remain **exactly as the Day-1 doc left them**:

- Root SPF: `v=spf1 include:_spf.google.com include:amazonses.com ~all` (unchanged)
- Root DKIM: `google._domainkey`, `resend._domainkey` (both unchanged)
- Root DMARC: `_dmarc.ailedger.dev` (unchanged — still `p=none` during the ramp window)
- `sales.ailedger.dev` CNAME to onboard-auth (unchanged)
- MX on root pointing at Workspace (unchanged)

If `dig` shows ANY of these changed, stop. Something else edited the zone while you were clicking. Figure out what before proceeding.

---

## 4. Verify in Brevo + first test send (10 min, +up to 2h for re-check)

### 4.1 — Hit "Verify" in Brevo

- [ ] Brevo → Senders & IP → Domains → `mail.ailedger.dev` → **Authenticate this domain**. Brevo checks all four/five records (verification TXT, SPF, DKIM1, DKIM2, optional bounce CNAME).
- [ ] First check usually completes within 30 seconds. If any record shows "Not yet verified":
  1. Wait 5 minutes.
  2. Run from your terminal:
     ```bash
     dig +short TXT brevo-code.mail.ailedger.dev
     dig +short TXT mail.ailedger.dev
     dig +short CNAME brevo1._domainkey.mail.ailedger.dev
     dig +short CNAME brevo2._domainkey.mail.ailedger.dev
     ```
     Compare each output character-for-character against what Brevo's dashboard expects. The failure is almost always a typo or a forgotten "Proxied: OFF."
  3. Re-click Verify in Brevo.
- [ ] When all records show green, record the verification timestamp in your working notes. This goes into `legal/contractors/pasha/week1.md` alongside the Day-1 smoke log as the evidence that outbound mail was authenticated before first send.

### 4.2 — Test send to Jake's mailbox

Do NOT send to Pasha's mailbox for the test — DKIM-signed mail from `mail.ailedger.dev` to `pasha@ailedger.dev` (both on the same Workspace tenant) skips parts of the external delivery path. Test to an address outside your Workspace.

- [ ] Brevo → Transactional → Send a test email (or the REST API equivalent):
  ```bash
  curl --request POST \
       --url https://api.brevo.com/v3/smtp/email \
       --header "api-key: $BREVO_API_KEY" \
       --header "content-type: application/json" \
       --data '{
         "sender": {"name": "Pasha (AILedger Sales)", "email": "pasha@ailedger.dev"},
         "to": [{"email": "<your-personal-gmail>@gmail.com"}],
         "subject": "Brevo auth test — ailedger.dev",
         "htmlContent": "<p>If you received this with dkim=pass and dmarc=pass, the Brevo sender domain is correctly set up.</p>"
       }'
  ```
- [ ] In your personal Gmail, open the received mail → three-dot menu → "Show original." Confirm:
  - `SPF: PASS` with `smtp.mailfrom=` pointing at a `mail.ailedger.dev` or `*.brevomail.com` address
  - `DKIM: PASS` with `d=mail.ailedger.dev` (the aligned signature — this is the critical one)
  - `DMARC: PASS` with alignment `relaxed` on DKIM
- [ ] If DKIM shows `d=brevo.com` only (not `d=mail.ailedger.dev`), your DKIM CNAMEs in §3.3 aren't being honored. Re-check Proxied: OFF on both, wait 15 minutes, re-send.
- [ ] Save the "Show original" headers to `legal/contractors/pasha/brevo-auth-test.eml`. This is the §1.E day-3 check evidence.

### 4.3 — Confirm `r.brevo.com` is NOT in the outbound

If you set up §3.5 branded tracking, send a test mail with a clickable link and inspect the rendered HTML. Links should rewrite to `https://em.ailedger.dev/...`, never `https://r.brevo.com/...`. If you see the latter, §3.5 did not propagate yet — wait 30 min and re-send.

---

## 5. Rate limits per plan tier (what will bite you)

As of 2026-04. Confirm current numbers on `brevo.com/pricing` at setup time — Brevo adjusts tiers ~annually.

| Plan | Monthly send limit | Daily cap | Throttling behavior | Notes |
|------|---------------------|-----------|---------------------|-------|
| **Free** | 9,000/mo (≈300/day) | **300/day hard cap** | Send blocked at 301/day until midnight UTC | Brevo footer on every mail (not removable). Adequate only for §4 test send. |
| **Starter** (~$9/mo base) | 20,000/mo (higher tiers add volume) | No daily cap | Soft throttle ~10 sends/sec per IP | Footer removable as add-on. **MVP-right tier.** |
| **Business** (~$18/mo base) | Same as Starter + A/B + send-time opt | No daily cap | Same ~10/sec | Worth adding only once Pasha has enough volume that A/B testing pays for itself. |
| **Enterprise** | Custom | Custom | Dedicated IP, SLAs | Only at scale. Not for MVP. |

**What Pasha's agent must respect regardless of plan:**

- Brevo's shared-IP pools rate-limit bursts of >50 emails in <10 seconds for new senders. Pasha's first week of campaigns should pace at ≤5 sends/sec with a brief pause every 100 messages, even if the plan allows more. This is reputation-warming, not a Brevo rule — but violating it gets your first campaigns spam-foldered disproportionately.
- Single-recipient campaigns > list blasts for cold outreach. Brevo's "Transactional" API endpoint (which is what §4.2 uses) has better deliverability than the "Campaign" endpoint for <100-recipient bespoke sends. Pasha's agent should default to Transactional for personalized outreach; Campaigns are for newsletter-style blasts.
- Bounce rate > 5% for 3 consecutive days triggers a Brevo account review. Pasha's list quality is his job; if he's bouncing that much, the problem is list curation, not Brevo's tolerance. Apollo's "verified email" filter should be on at the source.
- Complaint rate (spam reports) > 0.1% for 2 consecutive days also triggers review. At 300/day that's literally "more than one complaint in two days gets you reviewed." Treat complaints as a stop-the-line signal.

---

## 6. Wire the API key into Pasha's agent runtime (reference, not do)

This is in scope for the Phase D agent-runtime provisioning, not this doc. The structural expectation:

- The Brevo API key from §2.5 lives in `~/gt-lab-sales/polecats/pasha/.env` on the sub-town host, readable only by the `sales-agent` Linux user.
- Pasha's agent imports it as `BREVO_API_KEY` and calls `api.brevo.com/v3/smtp/email` with `sender.email = "pasha@ailedger.dev"` hard-coded per §2.5.
- The contractor's web UI (John's chat surface) never sees the key — Pasha types "send this draft to Lead X," John's orchestration invokes the outbound tool, the tool uses the keyed client, the key never touches Pasha's browser.
- Key rotation: every 30 days per runbook §1.C. Calendar reminder at setup time.

If you set up Brevo before the Phase D runtime exists, store the key in 1Password only. Do not drop into a `.env` until the runtime it belongs to exists.

---

## 7. What's NOT in this doc (and where it lives)

- **Apollo seat provisioning:** runbook §1.C. Separate workflow, different vendor, no DNS work.
- **CRM role / AILedger proxy key / Workspace Drive:** runbook §1.C and §1.D. Orthogonal to sender-domain setup.
- **Writing the first campaign template:** Pasha's own agent work, gated on §4 green in this doc.
- **Day-3 first-send verification:** runbook §1.E — "first outbound email through Brevo lands in a test mailbox Jake controls." The §4.2 test here satisfies the authentication side of that check; the day-3 check additionally verifies the Phase D runtime wiring is correct.
- **Switching DMARC from `p=none` to `p=quarantine`:** Day-1 doc §3.5 covers this. Do NOT tighten DMARC until you have 7 days of clean aggregate reports including at least 3 days of Brevo sends — Brevo alignment is a new signal in the report stream and you want to confirm it is clean before tightening.
- **Dedicated IP:** Brevo Enterprise only. Not in scope until volume + reputation warrant it (typically 50k+/mo sustained).
- **BIMI (brand logo in inbox):** optional polish. Requires DMARC at `p=quarantine` or `p=reject` first. Defer until DMARC tightens.

---

## 8. Failure modes specific to this setup (for the §5 runbook roll-up)

Four things that will break Pasha's first campaign if missed. Each has a direct check above.

- **DKIM CNAMEs proxied through Cloudflare (orange cloud instead of grey).** Proxying rewrites the CNAME target and Brevo's verification fails silently — dashboard shows "Not verified," first real send goes out with `d=brevo.com` only (unaligned), DMARC fails at the recipient, mail quarantined. §3.3 calls out "Proxied: OFF"; re-check if Brevo verification sticks on "Pending."
- **Adding Brevo's SPF include to the root record instead of `mail.ailedger.dev`.** The root SPF already sits at ~5 DNS lookups; adding Brevo pushes it toward the 10-lookup PermError cliff, and you've also collapsed the reputation isolation §1.3 exists to preserve. If you catch this, revert the root and re-add on the subdomain.
- **Header-From set to `pasha@mail.ailedger.dev` instead of `pasha@ailedger.dev`.** Technically aligned, but `pasha@mail.ailedger.dev` is not a real mailbox — replies bounce. Sender profile in §2.4 must have the bare `pasha@ailedger.dev` in the Email field; Brevo handles the envelope-From separately.
- **Key never rotated.** 30-day rotation per runbook §1.C is the backstop for "Pasha's agent runtime was compromised and we didn't notice." A key that sat for 6 months has lost the rotation defense entirely. Calendar reminder at setup; actually honor it.

---

## 9. Follow-ups (file as beads before closing this one)

- [ ] **Runbook edit:** §1.A.1 and §1.C say `sales.ailedger.dev` as the Brevo sender domain. After this doc lands green, update both to `mail.ailedger.dev` and add a one-line rationale pointing at §1 here. File as `bd create` with priority P2.
- [ ] **Brevo key scoping:** §2.5 notes that Brevo v3 API keys are account-scoped, not domain-scoped. The runbook's "scoped to sender domain only" language is aspirational. Either (a) enforce at the agent-runtime layer as §2.5 recommends and update the runbook language to match, or (b) investigate Brevo's sub-account feature (~Business tier and up) for true scoping. File as `bd create` P2.
- [ ] **DMARC tightening calendar:** the Day-1 doc §3.5 sets a T+7 reminder to review DMARC reports. Extend that to "after first week of Brevo sends" so Brevo alignment is in the report stream before any tightening decision. Update the calendar entry, no bead needed.

---

*Updated 2026-04-18 (Pasha outbound activation). Authority: runbook §1.C, Day-1 DNS doc, Brevo developer docs as of 2026-04. Rebuild PDF for handoff: `pandoc docs/sub-town/pasha-brevo-sender-domain.md -o ~/Downloads/pasha-brevo-sender-domain-$(date +%Y-%m-%d).pdf --pdf-engine=xelatex -V geometry:margin=0.75in`.*
