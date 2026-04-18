# Pasha 1Password Vault — Template + Provisioning / Offboarding Checklist

**Bead:** ai-90e
**Audience:** Jake, clicking through each step in person in the 1Password admin console. Every create / invite / delete click in this doc happens under Jake's admin account — never handed to an agent.
**Scope:** The concrete vault template for `sales-contractor-pasha`, the provisioning checklist that stands the vault up empty, the labeling + tagging conventions that make offboarding mechanical, the populated-at table that says when each credential enters the vault, and the destroy-at-offboarding procedure (amicable and acrimonious variants).
**Not in scope:** Actually creating the vault today (runbook §1.B is the trigger — this doc is the script Jake follows at that moment, not a license to pre-provision). Choice of 1Password tier (assumed: 1Password Business — Teams lacks per-vault activity logging, which §6.5 depends on). The `sales-contractors` admin vault itself (runbook §0 prereq; Jake-only, never shared with any contractor).

**Authority:** `docs/sub-town/04-onboarding-offboarding-runbook.md` §1.A (Surfaces sheet: *"any 1Password vault other than `sales-contractor-<name>`"* is explicit out-of-scope for Pasha — the vault is the authority boundary, so its ACL is load-bearing, not a convenience), §1.B (identity-first order: mailbox → 1Password → tools; the vault gets invited *after* the dedicated mailbox exists, not before), §1.C (each Phase-C surface drops its cred into this vault at a specific moment — see §5 populated-at table), §2.A / §3.B (offboarding cred-rotation order, which this doc's §6 operationalizes for the vault-shaped slice), `memory/feedback_permission_weakened_users_cannot_escalate.md` (the Pasha user must not hold, via this vault or anywhere else, any credential that would let him change files or systems that grant authority — the §2 "what does NOT go in this vault" list is the direct translation of that memory to 1P-shaped surfaces), `memory/feedback_jake_greenlight_console_only.md` (only Jake creates vaults; this doc is a checklist, not an execution plan for an agent).

> **Read-before-you-click:** runbook §5 Failure modes. The two that bite at vault time:
> - An admin credential filed into the contractor vault by muscle memory — §2 is the fence, §5's populated-at table is the check.
> - Vault deleted before the `rotate-at-offboard` sweep — once gone, you've lost the ledger of what was ever issued to Pasha. §6.1 is hard-ordered before §6.3.

---

## 0. Prerequisites (before you open 1Password)

Do these once. If any is missing, stop and file a `bd create` — do not improvise.

- [ ] 1Password Business account exists, Jake is an Owner (not just an Admin). Confirm: 1Password admin console → People → your own row shows role = Owner. Teams tier is insufficient; §6.5 acrimonious capture depends on Business-tier activity logs.
- [ ] Admin vault `sales-contractors` exists, Jake-only, populated per runbook §0 with provisioning-paths notes (Apollo add-seat URL, Brevo API-key URL, CRM invite URL). Confirm the existence of a note item literally named `provisioning-paths` — §5 items reference it by name.
- [ ] `pasha@ailedger.dev` does **not yet** have a 1Password account. The vault is created empty in §3 and Pasha is invited *only* in runbook §1.B after the mailbox is live and he's been handed the §1.A.1 Surfaces sheet. Creating his 1P account before the mailbox exists inverts the identity-first order and leaves a dangling invite tied to an address that doesn't resolve.
- [ ] You have read `memory/feedback_permission_weakened_users_cannot_escalate.md` in the last 24 hours. The §2 list below is the 1P-surface projection of that memory; if the memory has been updated since you last read it, re-read before continuing — a permission-escalation surface opened in that file is a permission-escalation surface that must be closed here too.

---

## 1. Vault template: `sales-contractor-pasha`

The vault is structured as six item-sections. Every item in the vault belongs to exactly one section, and its name starts with that section's prefix (see §4 labeling). Sections are not subfolders in 1Password — they're a naming discipline that makes item search, audit, and offboarding rotation tractable without custom tooling.

### 1.1 — `mailbox:` (Google Workspace / `pasha@ailedger.dev`)

Purpose: the identity anchor. If this section is lost, Pasha can't sign in to 1Password (SSO via mailbox), so he can't reach any other item. Runbook §1.B makes the mailbox load-bearing; this section treats it that way.

Items:
- `mailbox: pasha@ailedger.dev initial password` — 20-char random, set by Jake at Workspace user creation; force-change-on-first-login is ON (see `docs/sub-town/pasha-day1-dns-mailbox.md` §3.1). Lives here for the ~minutes between "Jake creates the user" and "Pasha does first login." After first login, the field is stale; tag it `stale-after-first-login` and let the offboarding sweep remove it.
- `mailbox: 2fa recovery codes (pasha copy)` — populated *by Pasha himself* at 2FA enrollment time. Jake never sees the codes; Pasha is instructed to paste them here during enrollment. Jake's copy lives in the admin `sales-contractors` vault under `pasha: 2fa recovery codes (jake copy)` — separate item, separate vault, so losing one does not lose both.
- `mailbox: first-login url` — the Google Workspace sign-in URL pre-filled with `pasha@ailedger.dev`. Convenience item; not a credential.

### 1.2 — `crm:` (CRM tenant, role `sales-contractor`)

Purpose: the working surface where Pasha logs deals and prospects. Role is constrained per runbook §1.C — no admin, no export, no delete. The items here are the keys to that role, not to admin.

Items:
- `crm: login` — username `pasha@ailedger.dev` + password. Password is Pasha-owned after first login; Jake drops only the invite-accept link and the initial password if the CRM issues one.
- `crm: api token (sales-contractor scope)` — if the CRM supports per-user API tokens, Pasha generates one post-signup and stores it here; Jake never types it, only confirms it exists. If the CRM issues only tenant-wide tokens, the token lives in the admin `sales-contractors` vault instead and this item is omitted — **do not** put a tenant-wide token here (see §2).
- `crm: role docs` — link to the CRM's docs page describing what the `sales-contractor` role can and cannot do, so Pasha has an authoritative reference when he asks "can I do X." Not a credential.

### 1.3 — `apollo:` (prospecting)

Purpose: Apollo seat Pasha uses for prospect search. Per runbook §1.C default, this is a separate Apollo account billed to Joyner Ventures, not a seat under Jake's personal Apollo — cleaner offboarding.

Items:
- `apollo: seat login` — username `pasha@ailedger.dev` + password (Pasha-owned after first login; initial password is Jake-set if Apollo's invite flow requires one).
- `apollo: api key (seat-scoped)` — key Pasha's agent uses to call Apollo's API. Scoped to his seat; no admin privileges. If Apollo's API-key UI surfaces "admin" / "workspace" / "team" as a scope option, confirm it is NOT selected (screenshot the scope page and attach to this item so offboarding can verify the scope was correct when issued).

### 1.4 — `brevo:` (ESP, prospect-outbound phase)

Purpose: the API key Pasha's agent uses to send prospect email through Brevo, scoped to sender domain `sales.ailedger.dev`. Note: this is distinct from the Resend key the auth worker uses for magic-link auth mail — that one stays in the admin vault (see §2).

Items:
- `brevo: api key (sales.ailedger.dev)` — Brevo-issued, scoped to `sales.ailedger.dev` sender only. Scope is verified at issuance by a smoke send (runbook §1.C Brevo step); attach the smoke-send result email (headers, not body) to this item as issuance evidence.
- `brevo: sender-identity config` — the `From`-name, reply-to, and list-unsubscribe defaults Pasha's agent must use. Not a credential; operational doc so Pasha's agent config is reproducible from the vault.

### 1.5 — `ailedger:` (dogfood proxy key, tenant `dogfood-sales`)

Purpose: the key that makes every LLM call Pasha's agents issue route through `proxy.ailedger.dev` and land in the `dogfood-sales` AILedger tenant's immutable chain. This is the §3.9 compliance anchor — if this key is wrong, the whole observability posture collapses.

Items:
- `ailedger: dogfood-sales proxy key` — issued per runbook §1.C AILedger step. **Attach** to this item the AILedger dashboard screenshot showing the key listed under tenant `dogfood-sales` (not any production tenant). If the dashboard ever shows the key against a different tenant, stop and escalate — the key must be re-issued against `dogfood-sales` before Pasha's agent issues another call.
- `ailedger: dashboard url (dogfood-sales, read-only)` — the URL Pasha uses to view his own tenant's chain. Read-only view; no write, no export. Not a credential; convenience.

### 1.6 — `misc:` (links + pointers Pasha needs, which are not credentials)

Purpose: things Pasha needs to look up by name during the engagement without memorizing URLs. Nothing in this section should be a credential — if it is a credential, it belongs in one of §1.1–§1.5.

Items:
- `misc: sales.ailedger.dev session entry url` — the John session-entry URL per runbook §1.D.1. Added *after* `status: "active"` flip is done per `pasha-day1-dns-mailbox.md` §5.
- `misc: jake contact info` — Jake's direct email + escalation phrasing ("If John is unreachable, email Jake directly" per runbook §1.D.1 first-contact protocol).
- `misc: surfaces sheet` — the §1.A.1 Surfaces sheet text, verbatim, so Pasha has the in-scope / out-of-scope list reachable without searching his email for Day-1 paper.

---

## 2. What does NOT go in this vault (load-bearing; direct from `feedback_permission_weakened_users_cannot_escalate.md`)

The Pasha user operates with deliberately weakened permissions. The vault is the largest concrete collection of credentials under his reach, so it is also the largest available surface for an accidental privilege grant. **Every item below must NOT enter `sales-contractor-pasha` — if found here during any audit, move it to `sales-contractors` (admin) immediately and rotate if there is any chance it was read.**

- **Jake's own credentials of any kind.** Workspace super-admin (`jake@ailedger.dev` with admin role), Jake's personal email / 1Password / GitHub / Cloudflare. These live in Jake's personal 1P vaults, never touched by this doc.
- **Admin credentials for Pasha-adjacent surfaces:** Apollo workspace admin, Brevo account admin, CRM tenant admin, Google Workspace admin console. These live in `sales-contractors` (Jake-only admin vault).
- **AILedger production-tenant keys.** Pasha has one key, to `dogfood-sales`, read-write through proxy. Any production-tenant key (any tenant other than `dogfood-sales`) is out-of-scope and its presence in this vault is an immediate P0.
- **Raw AI-provider API keys (OpenAI, Anthropic, Gemini).** Per runbook §1.C, these are configured only on the proxy-worker side — Pasha's agents talk to the proxy with the AILedger key, not to providers directly. The raw provider keys live on the proxy worker's secrets (runbook §1.C confirms this by attempting a direct provider call with Pasha's proxy key and observing a 401). No provider key ever enters this vault.
- **Cloudflare dashboard auth, Wrangler API tokens, or any infra-side credential.** Pasha does not deploy; he uses deployed surfaces. Infra lives on Jake's personal 1P.
- **The `onboard-auth` worker's `RESEND_API_KEY`.** This sends *auth* mail (magic links), a surface Jake operates, not Pasha. It's in admin `sales-contractors` as `resend: api key (auth-worker)`. The Brevo key in §1.4 is what Pasha gets for prospect outbound — different vendor, different purpose, separate lifecycle.
- **Anything owned by jjoyner on the Gas Town host.** Per span-all, sub-town users cannot read or write anything jjoyner-owned; the 1P equivalent is "no item whose rotation would require touching jjoyner-owned files ever lives here." Nudge definitions, systemd user units, Plaza manifest, border policy: not here, not ever.
- **1Password admin console auth** (the Owner credential for the 1P account itself). Jake's 1P Owner login is protected at the 1P account level, not stored in any 1P vault — it is the root of trust that unlocks every other vault, including this one.
- **Items "shared with" this vault from `sales-contractors`.** 1P Business lets you share an individual item cross-vault. Do not do it — sharing blurs the ACL boundary. If Pasha needs a cred, a scoped copy is issued fresh into `sales-contractor-pasha`; the admin cred stays in `sales-contractors`. §6.4 sweeps for this at offboarding.

If an item does not obviously belong in one of §1.1–§1.5 and is not listed in §1.6 misc, assume it belongs on the §2 list until proven otherwise. The default is exclude.

---

## 3. Vault provisioning checklist (Jake runs these, at the right moment)

Timing matters. The vault is created empty shortly *before* runbook §1.B (identity phase) so §1.B can invite Pasha to an existing vault; it is populated only incrementally as each Phase-C surface is provisioned (§5). Creating the vault too early (before Pasha has signed MSA + SOW) risks an idle vault sitting named after someone who never becomes a contractor — a minor mess but a real one in the 1P admin UI.

### 3.1 — When to create the vault

- [ ] Creation trigger: countersigned MSA + SOW have landed (runbook §1.A complete) AND the mailbox is about to be provisioned (§1.B is the next step you'll take this morning). If you're more than 2 hours ahead of §1.B, wait.
- [ ] Do **not** create the vault as part of §0 prereqs for a hypothetical future contractor. The vault is per-contractor and ephemeral; `sales-contractors` is the permanent admin vault and already exists per runbook §0.

### 3.2 — Create the vault

- [ ] 1Password admin console → Vaults → New Vault.
- [ ] Name: exactly `sales-contractor-pasha` (lowercase, hyphens, no trailing whitespace). Names elsewhere in this doc and in `pasha-day1-dns-mailbox.md` reference this string literally; a typo breaks the search.
- [ ] Description: copy verbatim:
  ```
  Pasha (sales contractor) — sub-town credentials per runbook §1.B.
  ACL: Jake = owner. Pasha = read-only (no manage, no export, no share).
  Offboarding: destroy per docs/sub-town/pasha-1password-vault.md §6.
  Off-limits list in §2 of same doc; do not file admin creds here.
  ```
- [ ] Icon / color: pick any icon but flag it with a color that is NOT used by `sales-contractors` (the admin vault). Visual distinction at the top-level vault list prevents drag-drop mistakes.

### 3.3 — Verify ACL at creation (before inviting anyone)

- [ ] Vault → Permissions tab. Confirm:
  - Owner / Manage Vault: Jake only (should be automatic; verify).
  - No other user or group has any permission on the vault yet.
  - No "Everyone in team" or "Default" group is present.
- [ ] If any group appears by default (some 1P org settings auto-add an "All Admins" group): remove it. The vault must have exactly one principal — Jake — until §3.4 adds Pasha.

### 3.4 — Prepare Pasha's ACL row (but DO NOT invite yet)

Pasha's invite goes out only as part of runbook §1.B, after his mailbox is live. §3.4 below is what you'll do *when* §1.B says "invite to `sales-contractor-<name>` vault."

When that moment arrives:
- [ ] People → Invite user → `pasha@ailedger.dev` (the mailbox from runbook §1.B, not any other address Pasha might prefer). Provisioning against a non-`ailedger.dev` address inverts the identity-first order.
- [ ] Vault permissions for Pasha — least-privilege. Exact 1P permission names vary by tier release, but the policy is:
  - **Allow viewing (read items):** ON.
  - **Allow editing (modify items):** OFF. Pasha should not modify items in his own vault — if a password needs a new value, Jake rotates it and updates the item, so the audit log tracks one writer.
  - **Manage Vault:** OFF. (This is the big one — it would let him change ACLs, re-invite users, rename the vault.)
  - **Manage People:** OFF.
  - **Export:** OFF. (So he cannot bulk-extract item contents to a local file.)
  - **Print:** OFF.
  - **Copy / Share item outside vault:** OFF if 1P surfaces this as a separable permission; else accept the residual risk and log it in §8 failure modes.
  If 1P surfaces a preset like "Read-only" or "Allow Viewing only," that preset is fine *iff* manual inspection confirms every sub-permission above matches. Do not accept a preset on trust — the preset contents change across 1P releases.
- [ ] Vault description visibility: Pasha can see the description (that's fine; he should know the vault is destroyed at offboarding — no surprise). But the description must not leak the existence of `sales-contractors` admin vault beyond the already-acknowledged fact that Jake holds admin creds elsewhere.

### 3.5 — Verify after invite (before populating any item)

- [ ] People → `pasha@ailedger.dev` → confirm account state is "Invited" or "Confirmed" (after he accepts). Confirm his 1P role at the account level is **Member**, not Admin / Owner / Group Manager. Account-level role trumps vault-level ACL; an accidentally-admin Pasha can see every vault in the org regardless of vault ACL.
- [ ] Vaults → `sales-contractor-pasha` → Permissions. Confirm exactly two principals: Jake (Owner) + Pasha (permission set per §3.4). No others. Screenshot the Permissions tab and attach to an item `misc: acl baseline` so a later diff is possible if the ACL drifts.
- [ ] Log vault creation timestamp + ACL verification timestamp to `legal/contractors/pasha/week1.md` under a new sub-heading `## 1Password vault baseline`. Two lines: "vault created UTC <ts>, ACL verified UTC <ts>."

---

## 4. Labeling + tagging convention

Every item in the vault follows one naming format and carries a small set of tags. The point is not aesthetic — at offboarding (§6) Jake needs to filter the vault by tag and rotate every live credential mechanically. Items without the convention are invisible to that sweep.

### 4.1 — Name format

`<section-prefix>: <purpose>` — colon-space separator. Section prefix is exactly one of the §1 section names (`mailbox`, `crm`, `apollo`, `brevo`, `ailedger`, `misc`). Purpose is short, lowercase where possible, and names the specific artifact (not "password for login" but "seat login"; not "key" but "api key (seat-scoped)"). Keep scope qualifiers in parentheses at the end so filters can match on them — e.g., `apollo: api key (seat-scoped)` is scannable vs. `apollo: seat-scoped api key` which isn't.

Canonical examples (all items that should exist in a fully-populated vault):
- `mailbox: pasha@ailedger.dev initial password`
- `mailbox: 2fa recovery codes (pasha copy)`
- `mailbox: first-login url`
- `crm: login`
- `crm: api token (sales-contractor scope)`
- `crm: role docs`
- `apollo: seat login`
- `apollo: api key (seat-scoped)`
- `brevo: api key (sales.ailedger.dev)`
- `brevo: sender-identity config`
- `ailedger: dogfood-sales proxy key`
- `ailedger: dashboard url (dogfood-sales, read-only)`
- `misc: sales.ailedger.dev session entry url`
- `misc: jake contact info`
- `misc: surfaces sheet`
- `misc: acl baseline` (screenshot from §3.5)

If you find yourself wanting to name an item that doesn't start with one of the six section prefixes, stop — you are probably about to file a `sales-contractors`-vault item in the wrong place. Re-check §2.

### 4.2 — Tag set (applied per item, at creation)

Three tag dimensions. Every item gets all three; missing any one breaks the offboarding sweep.

- **`surface:<section>`** — one of `surface:mailbox`, `surface:crm`, `surface:apollo`, `surface:brevo`, `surface:ailedger`, `surface:misc`. Redundant with the name prefix but lets 1P's tag-filter UI slice the vault without text search (text search in 1P occasionally misses items when they're archived).
- **`onboarded:<YYYY-MM-DD>`** — UTC date the item was added (the wall-clock day Jake filed it). Enables a "what was issued in Pasha's first week?" review at runbook §1.E day-7.
- **`rotate-at-offboard`** (applied only to live credentials, not to URLs / docs / screenshots) — every key, token, or password that has to be rotated at offboarding gets this tag. URLs, role docs, sender-identity config, and screenshots do NOT get this tag (nothing to rotate). The §6.1 sweep filters on this tag literally; mis-tagging a live cred means it silently skips rotation.

Optional fourth tag: **`stale-after-first-login`** — only on items whose value becomes invalid once Pasha does first login (the §1.1 initial mailbox password is the canonical case). The offboarding sweep removes these items rather than rotating them.

### 4.3 — Item fields (1P's structured fields, beyond name+value)

For each credential item, fill:
- **Password / value** field: the credential itself.
- **URL:** the surface it's used against (so 1P's autofill works; also a built-in pointer for audit).
- **Notes:** a one-line provenance record: "issued by Jake <UTC ts>, scope: <scope>, rotated: <UTC ts or 'never'>." The rotated-at line gets updated in place at offboarding §6.1; don't delete the history.
- **Attached files** (Business-tier feature): at issuance, attach any evidence that substantiates the scope (AILedger tenant screenshot, Brevo smoke-send headers, Apollo scope screenshot). 5MB/file cap on current 1P; images are plenty.

---

## 5. Populated-at table (cross-reference to runbook phases)

Every item in §4.1's canonical list enters the vault at a specific moment in the onboarding runbook. The table below makes "when do I file this item?" mechanical. If an item Jake is about to add doesn't appear in this table, that is a strong signal it belongs in `sales-contractors` (admin) or not in 1P at all — go re-check §2.

| Item | Populated at |
|---|---|
| `mailbox: pasha@ailedger.dev initial password` | runbook §1.B, step "Create 1Password account using the dedicated mailbox" → in fact this item is populated *before* that step, so Pasha's first-login password is retrievable from somewhere he can reach. Practically: populated by Jake immediately after he creates the Workspace user per `pasha-day1-dns-mailbox.md` §3.1, and before the 1P invite in runbook §1.B is sent. Tag `stale-after-first-login`. |
| `mailbox: 2fa recovery codes (pasha copy)` | runbook §1.B, by Pasha himself at 2FA enrollment on first mailbox login. Jake does not populate this; Jake's separate copy lives in `sales-contractors`. |
| `mailbox: first-login url` | runbook §1.B, by Jake, right after Workspace user is created. Not a credential; no `rotate-at-offboard` tag. |
| `crm: login` | runbook §1.C CRM step. |
| `crm: api token (sales-contractor scope)` | runbook §1.C CRM step, by Pasha after first login if per-user tokens; else **item does not exist** (tenant-wide token stays in `sales-contractors`). |
| `crm: role docs` | runbook §1.C CRM step, by Jake, link-only. |
| `apollo: seat login` | runbook §1.C Apollo step. |
| `apollo: api key (seat-scoped)` | runbook §1.C Apollo step; attach scope screenshot. |
| `brevo: api key (sales.ailedger.dev)` | runbook §1.C Brevo step; attach smoke-send headers (the test send referenced in the runbook step). |
| `brevo: sender-identity config` | runbook §1.C Brevo step; link-only item. |
| `ailedger: dogfood-sales proxy key` | runbook §1.C AILedger step; attach dashboard screenshot showing tenant. |
| `ailedger: dashboard url (dogfood-sales, read-only)` | runbook §1.C AILedger step; link-only. |
| `misc: sales.ailedger.dev session entry url` | runbook §1.D.1, **only after** `status: "active"` flip per `pasha-day1-dns-mailbox.md` §5. Until that flip, this URL will 401 and handing it to Pasha early is confusing. |
| `misc: jake contact info` | runbook §1.D.1, first-contact protocol. |
| `misc: surfaces sheet` | runbook §1.A.1 (the same Surfaces sheet Jake already hands Pasha on paper in Phase A). Copy the text in here on the same day §1.A Phase A runs. |
| `misc: acl baseline` | §3.5 of this doc, at vault creation. |

If at day-7 verification (runbook §1.E) any row in the table above is still blank when its runbook phase is complete, that is a defect — either the surface wasn't provisioned at all, or the cred was dropped somewhere other than the vault (both are bad).

---

## 6. Offboarding: destroy vault + rotate shared credentials

Trigger: Jake decides to end the engagement. Both amicable (runbook §2) and acrimonious (runbook §3) paths destroy the vault — the difference is the order of evidence capture and the level of formality around the demand for confidential-info return. The mechanical 1P steps are the same; §6.5 adds the acrimonious-only captures.

**Hard ordering:** §6.1 (rotation sweep) → §6.2 (revoke access) → §6.3 (destroy vault) → §6.4 (shared-cred sweep) → §6.5 (acrimonious-only, where applicable). Do not re-order; §6.3 destroys the ledger §6.1 depends on.

### 6.1 — Rotation sweep (before touching the vault itself)

The vault is evidence: every item's notes field holds provenance + rotation history (§4.3). If you delete the vault before every `rotate-at-offboard`-tagged cred is rotated elsewhere, the audit story fragments.

- [ ] Filter the vault by tag `rotate-at-offboard`. Confirm the list matches §5's rotation-eligible items exactly. Any surprise item = go investigate before rotating.
- [ ] For each item in the filtered list:
  - Confirm the corresponding upstream cred has been rotated per runbook §2.A (or §3.B for acrimonious — the rotation steps are the same; §3.B just happens after evidence capture).
  - Update the item's Notes field in place: append `rotated: <UTC timestamp>`. Do not delete prior provenance lines.
- [ ] Filter by tag `stale-after-first-login`. For each item: delete it from the vault (the value is already stale; no rotation needed). These are the only items deleted *in place* before the vault itself is destroyed.
- [ ] Export the vault contents: 1Password admin → Vaults → `sales-contractor-pasha` → Actions → Export → `.1pux` (1Password's own encrypted format, preserves attachments). Save to `legal/contractors/pasha/vault-archive.1pux`. Hash the file (sha256) and record the hash in `legal/contractors/pasha/week1.md` under a new `## offboarding` section; the hash goes in the incident timeline too if acrimonious.

### 6.2 — Revoke Pasha's access (before destroying, so the last-window can't be weaponized)

- [ ] 1Password admin → Vaults → `sales-contractor-pasha` → Permissions. Remove `pasha@ailedger.dev`. Timestamp this; it's one of the rows in the incident timeline template (runbook §3.E).
- [ ] 1Password admin → People → `pasha@ailedger.dev` → Suspend (Business-tier feature). Suspension blocks new sign-ins but preserves audit history; §6.5 depends on that history. **Do not** delete the 1P account until after the §6.5 capture (acrimonious) or until the 90-day audit window closes (amicable). Auto-calendar a reminder for T+90d to re-visit; until then, the suspended account is inert but retrievable evidence.
- [ ] Confirm by sign-in test (from a private browser window, attempting to sign in as `pasha@ailedger.dev` via Pasha's stated sign-in URL): 1P returns a "suspended" message, not a password prompt. If it returns a password prompt, suspension did not stick — retry, and escalate if it still fails after the second attempt.

### 6.3 — Destroy the vault

- [ ] Re-confirm `legal/contractors/pasha/vault-archive.1pux` exists and is >0 bytes. If missing, stop and re-run §6.1 export. The archive is the only thing that survives the next step.
- [ ] 1Password admin → Vaults → `sales-contractor-pasha` → Actions → Delete Vault. 1P asks for confirmation and a typed vault name — type `sales-contractor-pasha` verbatim.
- [ ] 1P places deleted vaults in the admin trash. Business tier retains trashed vaults for 30 days before auto-purge. **Leave it in trash.** Do not manually purge — in an acrimonious case, counsel may want the raw 1P-side record of the vault's final state, and 1P's admin activity log references vaults by ID for 30 days after deletion.
- [ ] Log deletion timestamp into the incident timeline (runbook §3.E) for acrimonious, or into `legal/contractors/pasha/offboarding-timeline.md` for amicable.

### 6.4 — Shared-cred sweep (items that were never in Pasha's vault but are affected by his departure)

Some credentials live in the admin `sales-contractors` vault or on other systems entirely and are touched by Pasha's offboarding even though they're not inside `sales-contractor-pasha`. Sweep them here so nothing lingers:

- [ ] Google Workspace `Sales – Shared` Drive folder: remove `pasha@ailedger.dev` from the folder's permissions (runbook §2.B already calls this out; confirm it's done).
- [ ] Cross-vault shares: 1P admin → Vaults → `sales-contractors` → filter items by "Shared with" including `sales-contractor-pasha`. Expected result: **zero items**. If any item appears, that item was shared contrary to §2's rule — rotate the underlying credential immediately (treat as if Pasha had the admin cred for the item's tenure) and update this doc's §2 / §8 to name the incident so future audits watch for it.
- [ ] `sales-contractors` admin vault — spot-check: does any item mention `pasha` in its Notes field? Items that reference Pasha by name (e.g., `pasha: 2fa recovery codes (jake copy)`) stay (they are Jake's record of what was issued). But if an item's value is Pasha-specific in a way that makes it stale or misleading post-offboarding, either rotate (preferred) or annotate the Notes field with a "superseded after pasha offboarding <UTC ts>" line so the next contractor's onboarding doesn't accidentally reuse stale state.
- [ ] `pasha@ailedger.dev` auto-forward rules on the Workspace mailbox: runbook §2.B kills these, and this doc's §2 prohibits their 1P-side equivalent (any item named `forward: ...`). Confirm both are absent post-offboarding.

### 6.5 — Acrimonious-only additions (runbook §3 triggered)

If the trigger was runbook §3 (acrimonious), add these captures **before** §6.2 (revoke access). The order inverts the amicable flow: capture evidence, *then* revoke. 1P-side:

- [ ] 1P admin → Activity Log → filter by user `pasha@ailedger.dev` and by vault `sales-contractor-pasha` → export to CSV. Save to `legal/contractors/pasha/incident/1password-activity.csv`. Activity covers the full account lifetime, not just the last N days; do not filter by date.
- [ ] For each item in the vault, record its last-accessed timestamp (if 1P's per-item access audit is enabled on your tier; Business has it). Compile into a one-line-per-item CSV at `legal/contractors/pasha/incident/1password-item-access.csv`. This is the artifact that answers "did Pasha read the AILedger proxy key on <date>?" — a question counsel will ask.
- [ ] Snapshot the vault's Permissions tab (as it stands, before §6.2 revocation). Save as a screenshot, not just a text log, so the timestamped admin UI itself is the evidence: `legal/contractors/pasha/incident/1password-acl-at-termination.png`.
- [ ] Only then proceed to §6.2.

---

## 7. What this doc deliberately does NOT do

- **Does not authorize creating the vault today.** Per `memory/feedback_jake_greenlight_console_only.md`, only Jake creates vaults, and only at the moment runbook §1 dictates. Running §3 as a dry-run or "just to have it ready" leaves a dangling empty vault and is indistinguishable in the 1P admin UI from a half-offboarded one.
- **Does not place any admin credential into `sales-contractor-pasha`.** §2 is the fence; §5's populated-at table is the check. If in doubt, the credential belongs in `sales-contractors` (Jake-only admin).
- **Does not replicate runbook §1.B / §1.C / §2 / §3.** This doc is the vault-shaped operationalization of those sections, not a substitute. At every populated-at moment, the runbook is the authority; this doc tells you where in 1P the runbook's credential lands.
- **Does not hand the vault lifecycle to an agent.** John (the sales sub-town Mayor) never touches 1P admin — Pasha's John-session surface is downstream of the ACL set here, not upstream of it. The permission-escalation memory is explicit: permission-weakened users cannot modify files / systems that grant authority; 1P vault ACLs grant authority, so only Jake modifies them.
- **Does not cover 1P account recovery if Jake loses his Owner creds.** That is a root-of-trust concern that lives in Jake's personal vault / paper backup per 1P's own recovery kit, out of scope here.

---

## 8. Failure modes specific to this setup (for the runbook §5 roll-up)

Five things that will break the authority boundary if missed. Each has a direct check in this doc:

- **Vault created with Pasha having "Manage Vault" permission** (or any permission beyond "Allow viewing"). He could then re-ACL the vault to add himself as owner, or invite another identity, or rename + export. The permission-weakened user model collapses. §3.4 spells out the exact permission set; §3.5 screenshot is the after-the-fact evidence, and §6.5 ACL snapshot is the at-termination evidence. If at any routine audit the ACL has drifted from the baseline screenshot, treat as a privilege-escalation incident, not a paperwork issue.
- **Admin credential filed into `sales-contractor-pasha` by muscle memory.** Apollo workspace admin, Brevo account admin, or Workspace super-admin password dropped into the wrong vault is the single most likely way for the contractor to acquire authority he shouldn't have. §2's exhaustive "does NOT go here" list is the fence; §5's populated-at table is the check (if you cannot name a runbook-phase row for an item, you are probably filing it in the wrong vault). §4.1 name-prefix discipline catches most such mistakes at the naming step — if you cannot prefix the item with one of six section names, stop and re-check.
- **Vault deleted before the §6.1 rotation sweep.** Once the vault is in 1P's 30-day trash, you have the archive file (§6.1 export) but the in-place provenance + rotation notes on each item are frozen at last-write-before-delete. If rotations were still in flight, you've lost the in-vault record of which were done and which were pending — and the archive is a point-in-time snapshot that doesn't show the rotation-in-progress states. Hard-order §6.1 → §6.3 is load-bearing.
- **Missing `rotate-at-offboard` tag on a live credential.** The §6.1 filter literally reads that tag; an untagged live cred silently skips the rotation sweep and lives on as an orphaned key. §4.2 makes the tag mandatory at creation; §5 table is the cross-check (every row with a "key," "password," or "token" in the item name must carry the tag when filed). Spot-check at week-1 verification (runbook §1.E day-7) by filtering on the tag and confirming the count matches the rotation-eligible count you'd expect.
- **Cross-vault item share from `sales-contractors` into `sales-contractor-pasha`.** 1P Business lets you share an individual item across vaults; this silently moves the item under the more-permissive reader's ACL for that item, regardless of which vault shows it. §2 prohibits this entirely; §6.4 sweep verifies the prohibition held at offboarding time. If any share is found, the item has leaked — rotate the underlying credential as if Pasha held the admin version for the whole tenure, and open an incident even on the amicable path.

---

*Updated 2026-04-18 (Pasha activation). Rebuild PDF for handoff with: `pandoc docs/sub-town/pasha-1password-vault.md -o ~/Downloads/pasha-1password-vault-$(date +%Y-%m-%d).pdf --pdf-engine=xelatex -V geometry:margin=0.75in`.*
