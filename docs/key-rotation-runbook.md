# Runbook — HCS topic submitKey rotation (2-of-3 adminKey ceremony)

Every AILedger tenant topic is created with:

- **submitKey** — a single Ed25519 key; the only credential that can write
  messages. One holder at a time (operator KMS by default; customer KMS on the
  BYO tier).
- **adminKey** — a 2-of-3 `ThresholdKey` (operator key, customer key, escrow
  key). It cannot write messages and cannot alter past consensus history; its
  only product role is this ceremony: replacing a lost, compromised, or
  custody-migrating submitKey on the *same* topic, preserving topic id,
  sequence numbers, and running-hash continuity.

## When to run

| Trigger | Urgency |
|---|---|
| submitKey compromise suspected | Immediately; pause submits first |
| submitKey lost (KMS failure, offboarding) | Before next submit window |
| Custody migration (operator → customer BYO tier) | Scheduled |
| Routine rotation policy | Scheduled |

## Procedure

1. **Pause the writer.** Stop the outbox drain for the tenant (relay flag) or,
   for BYO tenants, the customer pauses their submitter. In-flight messages
   sealed before the update remain valid forever.
2. **Generate the new submitKey** inside the destination KMS (never on a
   shared host; never written to disk in cleartext). Export only the public key.
3. **Build the `TopicUpdateTransaction`** setting the new submit public key.
4. **Collect 2-of-3 admin signatures.** Same-session holders sign directly;
   otherwise use a scheduled transaction (expiry window up to 62 days) so the
   second signer can sign asynchronously. Any 2 of the 3 keys satisfy the
   threshold — the ceremony works with the operator absent (customer + escrow)
   or with the customer absent (operator + escrow).
5. **Execute and confirm:** `TopicInfoQuery` must show the new submit key.
6. **Verify both directions:** a message signed with the old key must be
   rejected (`INVALID_SIGNATURE`); a message signed with the new key must seal.
7. **Record the rotation** as an event on the `registry.keys` topic (Phase 3+)
   and update the key inventory (names only — key material stays in KMS).
8. **Resume the writer.**

Verification note: the verifier flags any message sealed after a recorded
rotation that was *announced* as compromise-driven — consumers of the registry
treat the announcement consensus timestamp as the trust boundary.

## Rehearsal

The ceremony is rehearsed on testnet with throwaway keys:

```
source ~/.secrets/hedera-testnet.env
cd proxy
node scripts/spike-hcs.mts lifecycle          # creates topic, saves spike keys
node scripts/spike-hcs.mts rotate <topicId>   # rotation + both-direction proof
```

Rehearsal status and measured ceremony latency are recorded in
`docs/adr/016-hedera-hcs-spike.md`.

## Failure modes

- **Only 1 of 3 admin keys reachable:** ceremony impossible by design. Escrow
  custody and reachability is a standing operational requirement — check it in
  the periodic key inventory review.
- **adminKey itself compromised (2 keys):** attacker can rotate the submitKey
  and write *future* messages, but cannot rewrite, reorder, or delete history
  (consensus + record files). Response: announce on `registry.keys`, create a
  successor topic, publish a continuity link (old topic id + final running
  hash) as the successor's first message.
- **Update executed but writer not switched:** old-key submits fail with
  `INVALID_SIGNATURE`; the outbox retries surface the misconfiguration without
  data loss (durable buffer holds the records).
