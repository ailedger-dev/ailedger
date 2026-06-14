# Mainnet cutover runbook (Phase 3)

Everything below is rehearsed on testnet. The only inputs that do not exist
yet are the funded mainnet payer account and the explicit go decision — the
same discipline as the old hard-disabled bitcoin-mainnet backend: **a human
signs off before real value moves.**

## 0. Funding (operator action, ~15 minutes)

1. Create a mainnet account. NOTE: portal.hedera.com is testnet/previewnet
   ONLY — it cannot issue a mainnet account. A mainnet account is created when
   a key is first funded on-ledger, so bootstrap from outside the network:
   a wallet (HashPack/Blade/Kabila) + an exchange that lists HBAR — buy ~100 ℏ,
   withdraw to the wallet (the first inbound transfer creates + activates the
   account id), then export the key. Or generate an ECDSA keypair locally and
   fund its public-key/EVM-address alias (HIP-32 auto-create) for cleaner
   custody. ECDSA key recommended; record only the account id in ops docs.
2. Fund: **~100 ℏ** is ample runway — fees are USD-pegged. Cost basis at
   measured rates (ADR-016): ~$0.0007/decision-record, ~$0.05/topic,
   $0.0502/topic with threshold adminKey. 100 ℏ ≈ tens of thousands of
   sealed records at pre-revenue volume.
3. Land credentials exactly like testnet — never in a transcript or repo:
   `~/.secrets/hedera-mainnet.env` with `HEDERA_NETWORK=mainnet`,
   `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY` (0600).
4. Treasury rule: keep the payer account low-balance (top up monthly);
   monitor v2's `payer-balance` check alerts under threshold.

## 1. Preflight checklist

- [ ] Escrow custody at stage 0+ with the mainnet escrow key generated
      OFFLINE and stored per `docs/key-escrow-policy.md` (never on a host
      that runs services).
- [ ] `proxy npm test`, `indexer npm test`, `cli pytest`, `detection pytest`,
      `sdk npm test` all green at the cutover commit.
- [ ] Key-rotation ceremony rehearsed ON MAINNET with a throwaway topic
      before any tenant topic exists (spike-hcs.mts rotate).
- [ ] Fee sanity: one lifecycle run (`npm run spike lifecycle`) on mainnet;
      confirm fees within 20% of ADR-016 numbers.
- [ ] `docs/claims.yaml` reviewed; mainnet-gated claims flip only after §4.

## 2. Provision (same tooling, different env)

```
set -a; source ~/.secrets/hedera-mainnet.env; set +a
cd proxy
node scripts/provision-topics.mts init          # registries + checkpoints
node scripts/provision-topics.mts tenant jv-fleet
```

State lands in `~/.secrets/hedera-provision.mainnet.json` (escrow private key
auto-segregated to `~/.secrets/hedera-escrow/escrow-admin.mainnet.json` —
move it offline immediately).

## 3. Genesis attestations

First message on each mainnet tenant topic witnesses all pre-mainnet history:

- For tenants with testnet history (jv-fleet): genesis carries the testnet
  topic id + final running hash + final app chain head + record count —
  a continuity link, double-computed independently before publish
  (genesis is append-only forever; a wrong genesis can only be corrected
  by append, per the corrective-append procedure).
- For tenants with legacy Postgres chains: genesis carries
  `{legacy_chain_head, legacy_algo: "pg-pipe-v0", row_count, merkle_root,
  pg_snapshot_ts}` per the approved plan.

## 4. Cutover order (each step reversible until §4.4)

1. Outbox drain target → mainnet topics (testnet topics stay readable
   forever; nothing is deleted).
2. Indexer + monitor → `HEDERA_NETWORK=mainnet`, registry topic from §2.
3. Archiver → mainnet bundle directory; first court bundle archived and
   `validateBundle` green.
4. Reads cutover + ack semantics flip ("sealed" = mainnet consensus receipt).
5. `HederaAnchorBackend` into `attest` (monthly cross-topic checkpoint);
   delete the bitcoin stubs in the same change.
6. Verifier spot-run: `ailedger verify-evidence --network mainnet --topic …`
   → VERDICT OK, then once more offline from the archived bundle.

## 5. Rollback

Flags restore testnet posture at any step before §4.4; mainnet topics simply
sit unused (cost: the $0.05 creates). After §4.4, rollback = re-pointing
reads back while dual-write continues — the same posture the plan held
through Phase 3.
