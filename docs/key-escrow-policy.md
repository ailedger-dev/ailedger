# Key escrow policy — the third adminKey

Every AILedger topic's adminKey is a 2-of-3 threshold: **operator**,
**customer**, **escrow**. The escrow slot exists for exactly two scenarios:

1. **Customer key loss** — operator + escrow rotate the customer back in.
2. **Operator failure or hostility** — customer + escrow rotate the operator
   out. This is the cryptographic "vendor death" exit: evidence custody
   survives AILedger.

Scenario 2 is only real if the escrow key is genuinely outside unilateral
operator control. This document states the custody ladder honestly.

## Custody ladder

| Stage | Custody | What can honestly be claimed |
|---|---|---|
| **0 — interim (current)** | Operator-segregated cold storage: generated at provisioning into `~/.secrets/hedera-escrow/` (own file, 0600), never loaded by any service or routine tooling; to be moved offline (hardware token / printed in a safe). | "Escrow key is segregated from operations." NOT claimable: "operator cannot seize" — all three keys trace to operator-controlled storage. |
| **1 — customer-side escrow (BYO tier)** | The customer designates their own escrow agent (their counsel, their security team) for their topic's third key. No AILedger-side party needed. | "Operator cannot rotate your topic without a key you control or designated." Available per-tenant the moment a customer wants it — the threshold accepts any public key. |
| **2 — independent standing escrow** | A named third party under written escrow agreement (candidates: independent counsel; an industry foundation; a specialized key-escrow/trustee service). Selection criteria below. | The full claim, for all tenants by default. |

Stage 0 → 1 requires no engineering (provisioning already accepts any public
key for the escrow slot). Stage 2 is a business engagement, triggered by
first revenue or the first BYO-tier design partner — whichever comes first.

## Stage-2 selection criteria

- **Independence:** no financial dependence on AILedger beyond the escrow fee;
  contractually barred from acting on operator instruction alone.
- **Liveness:** committed response time for rotation ceremonies (the 62-day
  scheduled-transaction window is the hard ceiling; target ≤ 2 weeks).
- **Key hygiene:** hardware custody, documented succession, audit trail.
- **Jurisdiction:** EU or US entity compatible with customer compliance
  postures; not a cloud KMS tenant of the operator's own accounts.

## Operational rules (all stages)

- The escrow private key is **never** loaded by provisioning, draining,
  monitoring, or any service. Tooling references the public key only.
- Escrow participation happens only in a rotation ceremony
  (`docs/key-rotation-runbook.md`), via scheduled transaction, with the
  ceremony recorded on `registry.keys`.
- Key inventory review (names only) verifies escrow reachability
  periodically; an unreachable escrow key is a standing FAIL — with 2-of-3,
  losing escrow + one other key bricks the ceremony.
- The claims register (`docs/claims.yaml`) gates marketing language on the
  custody stage actually reached.
