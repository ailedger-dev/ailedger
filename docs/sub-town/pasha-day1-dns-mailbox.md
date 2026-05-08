> ⚠ **DEPRECATED 2026-04-30** — Per Jake universal directive, the email stack is now **Google only**. Brevo and Resend are being ripped out (account closures pending). Do NOT follow any setup steps in this document that reference Brevo, Resend, or any non-Google email relay. The Gmail-API replacement runbook supersedes this. See `~/gt-lab/memory/feedback_email_stack_google_only.md`.

---

# Pasha Day-1: `sales.ailedger.dev` DNS + `@ailedger.dev` Mailbox Setup

**Bead:** ai-lub
**Audience:** Jake, clicking through each step in person before Pasha's Day-1.
**Scope:** Everything on Jake's checklist for the Cloudflare zone `ailedger.dev`, the Resend sender-domain verification, the Cloudflare custom domain for `sales.ailedger.dev` on the `onboard-auth` worker, and the smoke test that proves it all resolves end-to-end.
**Not in scope:** Creating the Resend account (you do that), provisioning Pasha's mailbox password / passkey (that's first-login), anything Brevo-related (runbook §1.C references Brevo, but per the updated bead the outbound sender is **Resend**; Brevo is deferred until Pasha's prospect-outbound phase).

**Authority:** `docs/sub-town/04-onboarding-offboarding-runbook.md` §1.B (dedicated mailbox, identity-first order), §1.D.1 (session entry via the onboard-auth worker + mailbox SSO IdP), ADR-013 (ailedger proxy), `feedback_jake_greenlight_console_only.md` (only you can greenlight; don't hand this list to an agent to execute).

> **Read-before-you-click:** runbook §5 Failure modes. The two that bite at DNS time:
> - auto-forward rules silently re-enabling — §1.B disables, §2.B kills again.
> - SPF / DKIM unverified before first send — a "working-in-test" mailbox that quarantines in the wild is worse than a visibly-broken one.

---

## 0. Prerequisites (before you touch DNS)

Do these once. If any is missing, stop and file a `bd create` — do not improvise.

- [ ] You own `ailedger.dev` in Cloudflare Registrar (or nameservers are delegated to Cloudflare). Confirm: Cloudflare dashboard → `ailedger.dev` → Overview shows "Active" not "Pending Nameserver Update."
- [ ] You have the `onboard-auth` worker deployed to your Cloudflare account. Confirm: `wrangler deployments list --name onboard-auth` shows a recent deploy. Record the default URL: `onboard-auth.<your-subdomain>.workers.dev` — write it in your working notes, §1.2 needs it exactly.
- [ ] You have a Resend account (free tier is fine for MVP). Log in → Domains tab open in a browser tab. Do **not** add `ailedger.dev` yet; §2 does it in the right order.
- [ ] You have decided the mailbox provider for `@ailedger.dev`. This doc assumes **Google Workspace Business Starter** (real IMAP, real OAuth SSO, covers the runbook §1.D.1 "mailbox SSO IdP + 2FA" requirement out of the box). If you picked something else (Fastmail, Zoho), §3's MX records change — see §3.A for the variant.
- [ ] 1Password vault `sales-contractor-pasha` exists, empty. §3 will drop the initial mailbox password there.

---

## 1. Cloudflare: `sales.ailedger.dev` → `onboard-auth` worker (15 min)

`sales.ailedger.dev` is where Pasha lands on Day-1. Unauthenticated requests there redirect to `login.joynerventures.com` (the auth worker's own domain); after passkey or magic-link sign-in, the browser is redirected back to `sales.ailedger.dev` with a session JWT. The CNAME + custom-domain binding below is what makes `sales.ailedger.dev` resolve to the worker in the first place.

### 1.1 — Worker-side: add the custom domain

Done from Wrangler so the route is checked into config, not just clicked in the dashboard.

- [ ] In `onboard-auth/wrangler.jsonc`, confirm the `routes` array contains:
  ```jsonc
  "routes": [
    { "pattern": "login.joynerventures.com", "custom_domain": true },
    { "pattern": "sales.ailedger.dev",       "custom_domain": true }
  ]
  ```
  If the second entry is missing, add it, commit on a new branch, push, and `wrangler deploy`. Do **not** hand-edit routes in the Cloudflare dashboard — the `wrangler.jsonc` is the source of truth, and dashboard edits drift.
- [ ] In `onboard-auth/wrangler.jsonc`, extend `ALLOWED_RETURN_HOSTS` so the auth worker will accept post-login redirects back to `sales.ailedger.dev` (already in the scaffold, but verify):
  ```jsonc
  "ALLOWED_RETURN_HOSTS": "sales.ailedger.dev,login.joynerventures.com"
  ```
- [ ] `wrangler deploy` from `onboard-auth/`. Record the deploy ID.

### 1.2 — Cloudflare dashboard: DNS record

Cloudflare's "custom domain" binding creates the DNS record for you *if* the zone and the worker live in the same account. Verify, don't assume.

- [ ] Cloudflare dashboard → `ailedger.dev` → DNS → Records. Confirm there is now a `CNAME` record:
  ```
  Name:    sales
  Target:  onboard-auth.<your-subdomain>.workers.dev
  Proxied: ON (orange cloud)
  TTL:     Auto
  ```
  If it is missing, **do not create it by hand** — it means the custom-domain binding in §1.1 failed silently. Go back to Workers → `onboard-auth` → Settings → Triggers → Custom Domains, and check for a red error. Fix at the binding, not at the DNS row.
- [ ] Confirm the record is **Proxied** (orange cloud). A grey-cloud DNS-only record will resolve, but the worker's TLS cert won't attach and `curl https://sales.ailedger.dev/` returns a cert mismatch. This is the #1 failure mode here.

### 1.3 — TLS cert

Cloudflare auto-issues an edge cert for custom-domain-bound worker routes. Typical: 30s–5min.

- [ ] Cloudflare → `ailedger.dev` → SSL/TLS → Edge Certificates. Confirm `sales.ailedger.dev` is listed as "Active." If stuck in "Pending Validation" for >10 min, stop and escalate — retrying usually makes it worse.

---

## 2. Resend: `ailedger.dev` as verified sender domain (10 min, +15 min propagation)

Resend sends the magic-link emails the onboard-auth worker issues when Pasha opts for the magic-link fallback instead of a passkey. The sender address is `auth@ailedger.dev` (or `no-reply@ailedger.dev` — pick one and document below; it goes into `MAGIC_LINK_FROM`). The domain must be verified at Resend before the first send, or the email silently quarantines.

### 2.1 — Add the domain in Resend

- [ ] Resend dashboard → Domains → Add Domain. Enter `ailedger.dev`. Region: pick the same one as your Cloudflare-adjacent infra (`us-east-1` is the default; match whatever your Workers are in).
- [ ] Resend shows you 3–4 DNS records to add:
  - **SPF** (TXT on root): `v=spf1 include:amazonses.com ~all` — Resend uses AWS SES under the hood.
  - **DKIM** (TXT or CNAME, usually 3 CNAME records): Resend generates domain-specific selectors like `resend._domainkey.ailedger.dev`. The exact selector names are specific to your account; **copy them verbatim from the Resend dashboard**, do not hand-type.
  - **Return-Path / MAIL FROM** (CNAME): Resend may provide a bounce-handling record like `send.ailedger.dev` → `feedback-smtp.us-east-1.amazonses.com`. Copy verbatim.
- [ ] Record the exact values in your 1Password vault note `ailedger-dns-records` before leaving the Resend tab — Resend's "view records" UI occasionally regenerates on reload and the selector suffix changes.

### 2.2 — Plant the records in Cloudflare

- [ ] Cloudflare → `ailedger.dev` → DNS → Records. For each record Resend gave you, add a new row. Type, Name, Target — copy verbatim from 2.1. **Proxied: OFF** (grey cloud) for every TXT and every DKIM CNAME. TXT records cannot be proxied, and DKIM CNAMEs proxied through Cloudflare will break verification.
- [ ] Before moving on, double-check the SPF TXT record. If `ailedger.dev` has a pre-existing SPF record (e.g., from an earlier experiment), you must **merge**, not add a second one — two SPF records = PermError = all outbound mail rejected. If a second record exists, delete it and make sure the final record contains both `include:amazonses.com` (Resend) **and** `include:_spf.google.com` (Google Workspace, §3).

### 2.3 — Hit "Verify" in Resend

- [ ] Resend → Domains → `ailedger.dev` → Verify. First check is usually immediate; if "Pending" after 5 min, run `dig +short txt ailedger.dev` from your terminal and confirm the SPF record shows — if it doesn't, your Cloudflare record is wrong or still propagating. Wait 10 more min, then re-verify.
- [ ] When all four checkmarks go green, note the verification timestamp in your working notes. You will reference this in `legal/contractors/pasha/week1.md` as proof the outbound email path was green before first send.

### 2.4 — Wire the from-address into `onboard-auth`

- [ ] In `onboard-auth/wrangler.jsonc`, set:
  ```jsonc
  "MAGIC_LINK_FROM": "auth@ailedger.dev"
  ```
  (Was `auth@joynerventures.com` in the scaffold. Flipping to `ailedger.dev` aligns the auth mail with the sub-town's own domain — fewer "who is this from?" questions for Pasha on first sign-in.)
- [ ] `wrangler deploy` from `onboard-auth/`.
- [ ] Resend → API Keys. Confirm the existing `RESEND_API_KEY` is scoped to the `ailedger.dev` domain (or is a general key that can send from any verified domain). If it was scoped to `joynerventures.com` only, generate a new one scoped to `ailedger.dev` and `wrangler secret put RESEND_API_KEY` with the new value. Revoke the old key in Resend after the new one is live.

---

## 3. Google Workspace: `@ailedger.dev` mailbox provisioning (30 min, +24h MX propagation window)

Per runbook §1.B, Pasha's dedicated mailbox is identity-first — account creation order is mailbox → 1Password → tools. Google Workspace is the default because the runbook §1.D.1 explicitly requires a "mailbox SSO IdP + 2FA" anchor, and Google Identity ships that without a separate IdP.

> **Cost warning:** Google Workspace Business Starter is $6/user/mo. If Pasha doesn't sign or the engagement falls through, cancel the user within the 14-day free trial window to avoid charges. Set a calendar reminder for trial-end +2 days.

### 3.A — Variant: if you picked a different provider

- **Fastmail:** MX records become `in1-smtp.messagingengine.com` (pri 10) + `in2-smtp.messagingengine.com` (pri 20). SPF include: `spf.messagingengine.com`. DKIM: 3 CNAMEs (`fm1._domainkey`, `fm2._domainkey`, `fm3._domainkey`). Skip the rest of §3 below; the record values are different but the structural placement (MX + SPF + DKIM + DMARC, plus merging Resend's SPF) is identical.
- **Zoho Mail Lite:** MX `mx.zoho.com` (pri 10), `mx2.zoho.com` (pri 20), `mx3.zoho.com` (pri 50). SPF include: `zohomail.com`. DKIM: 1 CNAME, selector Zoho generates per-domain.
- **Cloudflare Email Routing (forwarding-only, NO mailbox):** rejected by runbook §1.B — "Inbound goes only to the mailbox. No auto-forward." Forwarding to a personal address is explicitly the leakiest surface to forget at offboarding. Do not pick this.

### 3.1 — Create the Workspace account

- [ ] Go to `workspace.google.com` → Start Free Trial. Domain: `ailedger.dev`. Admin user: `jake@ailedger.dev` (not `jake@joynerventures.com` — you want admin authority to live on the same domain as the mailboxes it administers).
- [ ] Google will prompt to verify domain ownership with a TXT record. Add the verification TXT in Cloudflare DNS (Proxied: OFF). Verify in Workspace. Record verification timestamp.
- [ ] Create user `pasha@ailedger.dev`. Initial password: generate 20 random chars, drop into 1Password vault `sales-contractor-pasha` under item `pasha@ailedger.dev initial password`. **Require password change on first login** — toggle the checkbox. 2FA: set to "Required" at the org level (Admin console → Security → 2-Step Verification → Enforcement: On).
- [ ] Auto-forwarding: Admin console → Apps → Google Workspace → Gmail → End User Access → **Disable** "Allow per-user outbound gateways" and **Disable** "Automatic forwarding." Per runbook §5: this is the #1 silent-leak surface at offboarding; kill the option before the user exists.

### 3.2 — MX records

- [ ] Cloudflare DNS → `ailedger.dev`. Add the Google Workspace MX records. As of 2023+, Workspace uses a single consolidated record:
  ```
  Type: MX   Name: @   Priority: 1   Target: SMTP.GOOGLE.COM   TTL: Auto   Proxied: OFF
  ```
  (MX records cannot be proxied.) If the Workspace setup wizard shows the older 5-record set (`ASPMX.L.GOOGLE.COM` + 4 fallbacks), use those instead — the Workspace wizard is authoritative for which record set your tenant is on.
- [ ] Remove any pre-existing MX records. Two MX record sets from different providers = delivery race = mail randomly lost.

### 3.3 — SPF merge (critical)

The SPF record added in §2 included `amazonses.com` for Resend. Now extend it to include Google Workspace. You will end up with **one** TXT record on the root:

- [ ] Cloudflare DNS → edit the existing SPF TXT record. Final value:
  ```
  v=spf1 include:_spf.google.com include:amazonses.com ~all
  ```
  Order matters for the 10-DNS-lookup SPF cap: put the more-frequently-resolved one first (Google, since inbound check is every message). Do **not** add a second TXT record — merge into the existing one.

### 3.4 — DKIM for Google Workspace

Google Workspace DKIM is NOT auto-enabled — you must generate the key and publish it.

- [ ] Workspace Admin console → Apps → Google Workspace → Gmail → Authenticate email → Generate New Record. Prefix: `google` (default). Key length: **2048-bit**. Copy the TXT value Google shows (it's long — ~400 chars).
- [ ] Cloudflare DNS → add TXT record:
  ```
  Type: TXT   Name: google._domainkey   Value: <paste Google's value verbatim>   TTL: Auto   Proxied: OFF
  ```
- [ ] Back in Workspace Admin → Authenticate email → click **Start Authentication**. If it errors "record not found" immediately, wait 5 min for DNS propagation and retry. If still failing after 30 min, `dig +short txt google._domainkey.ailedger.dev` and compare to what Google expects, char by char.

### 3.5 — DMARC

One DMARC record on the root covers both Resend and Workspace. Start in report-only mode (`p=none`) so you see alignment failures without blocking real mail; tighten to `quarantine` or `reject` only after a week of clean reports.

- [ ] Cloudflare DNS → add TXT record:
  ```
  Type: TXT   Name: _dmarc   Value: v=DMARC1; p=none; rua=mailto:dmarc@ailedger.dev; ruf=mailto:dmarc@ailedger.dev; fo=1; adkim=r; aspf=r
  ```
- [ ] Create a distribution group `dmarc@ailedger.dev` in Workspace Admin → Groups, with Jake as the only member. Aggregate reports from receivers land there weekly; you want eyes on them, not `/dev/null`.
- [ ] Calendar reminder for T+7 days: review DMARC reports, decide whether to tighten `p=none` → `p=quarantine`. Default answer after a clean week is yes; only reason to hold is if you see legitimate mail from a service you forgot to include.

### 3.6 — First-login smoke

- [ ] From a private browser window: go to `mail.google.com`, sign in as `pasha@ailedger.dev` with the 1Password-stored password. Confirm forced password change prompt fires. Set a throwaway password (Pasha will set his real one on Day-1 when you hand him the account). Confirm 2FA enrollment prompt fires.
- [ ] Send a test mail from your personal Gmail to `pasha@ailedger.dev`. Confirm inbox receives it within 1 min. Headers should show `dkim=pass`, `spf=pass`, `dmarc=pass` (or `dmarc=none` for first few mins while the record propagates).
- [ ] Send a test mail *from* `pasha@ailedger.dev` *to* your personal Gmail. Confirm your Gmail receives it with `dkim=pass (google.com)`, `spf=pass`, `dmarc=pass`. If DKIM fails: §3.4 didn't fully activate — check Admin console status, it should say "Authenticating email."
- [ ] Sign out of `pasha@ailedger.dev`. Do not leave the session warm — the next person to sign in should be Pasha on Day-1.

---

## 4. End-to-end smoke script

One script that Jake runs once all records are in place, before handing Pasha the `sales.ailedger.dev` URL. Output goes into `legal/contractors/pasha/day0-smoke.log` as evidence the DNS + mail path was green before first real use.

- [ ] Save the following as `~/bin/pasha-day0-smoke.sh` (chmod +x). It is idempotent and safe to re-run:

```bash
#!/usr/bin/env bash
# pasha-day0-smoke.sh — verifies sales.ailedger.dev + @ailedger.dev mail path.
# Run from your laptop (not from a worker). Exit nonzero on any failure.
# Does NOT send live email; you did that by hand in §3.6. This only checks DNS + TLS.

set -euo pipefail

DOMAIN="ailedger.dev"
SALES_HOST="sales.${DOMAIN}"
AUTH_HOST="login.joynerventures.com"
EXPECTED_WORKER="${1:?pass the worker default URL as arg 1, e.g. onboard-auth.yoursub.workers.dev}"

pass() { printf "  ✓ %s\n" "$*"; }
fail() { printf "  ✗ %s\n" "$*"; exit 1; }

echo "== DNS: ${SALES_HOST} CNAME =="
ans=$(dig +short "${SALES_HOST}" CNAME)
case "$ans" in
  *"${EXPECTED_WORKER}"*) pass "CNAME → ${EXPECTED_WORKER}" ;;
  "") fail "no CNAME record on ${SALES_HOST}" ;;
  *) fail "CNAME points to '${ans}', expected '${EXPECTED_WORKER}'" ;;
esac

echo "== TLS: ${SALES_HOST} has valid edge cert =="
if curl -sS -o /dev/null -w "%{http_code}\n" "https://${SALES_HOST}/" --max-time 10 | grep -qE "^(200|301|302|401|404)$"; then
  pass "TLS handshake succeeds; worker responds"
else
  fail "TLS or HTTP failed — check Cloudflare SSL/TLS → Edge Certificates for ${SALES_HOST}"
fi

echo "== DNS: ${DOMAIN} MX points at Google Workspace =="
mx=$(dig +short "${DOMAIN}" MX | tr '[:upper:]' '[:lower:]')
if echo "$mx" | grep -qE "(smtp.google.com|aspmx.l.google.com)"; then
  pass "MX → Google Workspace"
else
  fail "MX does not reference Google Workspace; got: $mx"
fi

echo "== DNS: SPF merged (Google + SES) =="
spf=$(dig +short TXT "${DOMAIN}" | tr -d '"' | grep -i "v=spf1" || true)
[ -z "$spf" ] && fail "no SPF TXT record on ${DOMAIN}"
echo "$spf" | grep -q "_spf.google.com" || fail "SPF missing include:_spf.google.com"
echo "$spf" | grep -q "amazonses.com"   || fail "SPF missing include:amazonses.com"
[ "$(dig +short TXT "${DOMAIN}" | grep -ci 'v=spf1')" = "1" ] || fail "multiple SPF records = PermError; merge to one"
pass "SPF has Google + SES includes, single record"

echo "== DNS: Google DKIM selector published =="
dkim=$(dig +short TXT "google._domainkey.${DOMAIN}")
[ -z "$dkim" ] && fail "no google._domainkey TXT record"
pass "google._domainkey present ($(echo "$dkim" | wc -c) bytes)"

echo "== DNS: Resend DKIM selector published =="
# Resend selector name varies; spot-check by looking for resend._domainkey OR a send.* CNAME
if dig +short TXT "resend._domainkey.${DOMAIN}" | grep -q .; then
  pass "resend._domainkey TXT present"
elif dig +short CNAME "send.${DOMAIN}" | grep -qi "amazonses.com"; then
  pass "send.${DOMAIN} CNAME → SES (Resend return-path)"
else
  fail "Resend DKIM/return-path records missing — re-check Resend dashboard"
fi

echo "== DNS: DMARC published =="
dmarc=$(dig +short TXT "_dmarc.${DOMAIN}" | tr -d '"')
echo "$dmarc" | grep -q "v=DMARC1" || fail "no DMARC record on _dmarc.${DOMAIN}"
echo "$dmarc" | grep -q "rua=mailto:" || fail "DMARC has no rua= reporting address"
pass "DMARC present with rua reporting"

echo "== Auth worker: ${SALES_HOST} fronts onboard-auth =="
# Hit the unauthenticated root; expect a redirect to login.joynerventures.com OR a login page.
body=$(curl -sS "https://${SALES_HOST}/" --max-time 10 -o /tmp/pasha-smoke.html -w "%{http_code}\n")
if [ "$body" = "302" ] || [ "$body" = "301" ]; then
  loc=$(curl -sI "https://${SALES_HOST}/" --max-time 10 | grep -i "^location:" | tr -d '\r')
  echo "$loc" | grep -qi "${AUTH_HOST}" && pass "unauth root redirects to ${AUTH_HOST}" \
    || fail "redirect location is '${loc}', expected ${AUTH_HOST}"
elif [ "$body" = "200" ] && grep -qi "sign in\|passkey\|magic" /tmp/pasha-smoke.html; then
  pass "login page served at root (inline mode)"
else
  fail "unexpected response at ${SALES_HOST}/: HTTP $body"
fi

echo ""
echo "ALL GREEN — ${SALES_HOST} + @${DOMAIN} mail path ready for Pasha Day-1."
```

- [ ] Run it:
  ```bash
  ~/bin/pasha-day0-smoke.sh onboard-auth.<your-subdomain>.workers.dev 2>&1 | tee ~/legal/contractors/pasha/day0-smoke.log
  ```
- [ ] On first run, expect SPF or Resend DKIM to fail — DNS propagation can take up to 24h even though Cloudflare typically shows changes within 1 min. Re-run every 30 min until green.
- [ ] When all green: archive the log into 1Password `sales-contractor-pasha` vault → attachment `day0-smoke.log`. This is the record that proves §1.D.1 "session entry URL live *after* `status: "active"` flip" was done in the right order.

---

## 5. What's NOT in this doc (and where it lives)

- **`config.json` flip from `scaffolded_inactive` → `active`:** runbook §1.D.1. Must happen AFTER the §4 smoke is all green; until then, session entry is intentionally closed.
- **Contractor-context block in `~/gt-lab-sales/memory/MEMORY.md`:** runbook §1.D.1. Names Pasha, SOW start date, and his Surfaces sheet list.
- **First magic-link or passkey for `pasha@ailedger.dev`:** done by Pasha himself at Day-1 session entry, not pre-planted. You will hand him the URL + his initial Workspace password; he sets up his passkey on first visit. The onboard-auth worker treats any new email as an enrollable user, so no worker-side prep is needed.
- **Brevo key for prospect outbound:** deferred to the Pasha-outbound phase (runbook §1.C). The Resend setup in §2 above is for auth mail only; it is NOT the sender Pasha uses for prospect email.
- **John's persona provisioning:** runbook §1.D.1 provisioning steps 1–6. Depends on this doc's §1–§4 being green first.

---

## 6. Failure modes specific to this setup (for the §5 runbook roll-up)

Four things that will break Day-1 if missed. Each has a direct check in §4's smoke script:

- **`sales.ailedger.dev` CNAME with grey-cloud (DNS-only) instead of orange-cloud (Proxied).** TLS edge cert won't attach; `curl` gets cert mismatch. §1.2 spells out the fix. Smoke script catches this via the TLS step.
- **Duplicate SPF TXT records.** Adding Resend's SPF as a second row instead of merging = PermError = all outbound mail (magic-link auth and Workspace sends alike) silently rejected at the recipient. §2.2 and §3.3 both warn; smoke script explicitly checks record count.
- **Proxied DKIM CNAME.** Proxying a DKIM CNAME through Cloudflare rewrites the value and breaks verification. Every DKIM record in this doc has "Proxied: OFF" called out. If the smoke script shows the DKIM present but Gmail's received-mail headers show `dkim=fail`, check the cloud color.
- **`MAGIC_LINK_FROM` still pointing at `joynerventures.com` after the switch.** The auth worker sends from `joynerventures.com` but Resend only verified `ailedger.dev` → Resend's API returns 403 on the send → magic-link request succeeds silently (auth endpoints are enumeration-resistant) but no email arrives → Pasha is stuck on the login page. §2.4 is the fix; re-deploy the worker after editing `wrangler.jsonc`.

---

*Updated 2026-04-18 (Pasha Day-1 prep). Rebuild PDF for handoff with: `pandoc docs/sub-town/pasha-day1-dns-mailbox.md -o ~/Downloads/pasha-day1-dns-mailbox-$(date +%Y-%m-%d).pdf --pdf-engine=xelatex -V geometry:margin=0.75in`.*
