# `ailedger attest` — monthly public-blockchain anchor

Operator guide for the `attest` subcommand of the `ailedger` CLI. This tool
computes a cryptographic root hash across every customer's current chain-head
and publishes it to a public blockchain. The regulator-facing primer §3.5 and
the Thursday call briefing §3 promise this; `attest` is the engineering
substantiation.

## Why this exists

AILedger's tamper-evident chain (migration `20260418_tamper_evident_chain.sql`)
guarantees that once a row is written, the chain links forward are
cryptographically locked. But AILedger still **writes** those rows — nothing
in the chain alone prevents AILedger from rewriting history before anyone
else observes it. Publishing a monthly root hash to a public blockchain
gives regulators an external, timestamped witness that the chain existed in
its current state at that moment. Bitcoin cannot be retroactively rewritten
by us.

## Seed implementation scope

- **Mock backend works end-to-end.** Compute → publish → verify round-trip is
  covered by tests; this is the default for dev + CI.
- **Bitcoin TestNet backend is stubbed.** Class skeleton exists; wiring to
  BTCPay / BlockCypher is a follow-up.
- **Bitcoin MainNet backend is hard-disabled.** It sends real money and
  requires explicit Jake signoff before the stub class is replaced with a
  real implementation.
- **Cron is not wired.** The seed implementation is manual CLI only.

## Prerequisites

Two environment values must be present for the attest commands (unlike
`verify` / `export`, these run operator-side and use the service role, not a
customer api-key):

| Variable                       | Required for  | Notes                                                               |
|--------------------------------|---------------|---------------------------------------------------------------------|
| `AILEDGER_SERVICE_ROLE_KEY`    | all           | Supabase service-role JWT. Bypasses RLS. Never commit this value.   |
| `AILEDGER_ANCHOR_BACKEND`      | publish/verify| `mock` (default), `bitcoin-testnet` (stub), `bitcoin` (disabled).   |

The `base-url` comes from the usual CLI config:

```
ailedger config --set base-url=https://<project>.supabase.co
```

Backend credentials (when BTC backends are filled in) read from
`~/gt-lab/.secrets/ailedger-attest-backend.env`. That file must NEVER be
committed.

## Commands

### `ailedger attest compute`

Dry run. Fetches every customer's chain-head via the service-role RPC
`ledger.all_chain_heads()`, derives the root hash, prints it. No database
write, no publish.

```
$ ailedger attest compute
root_hash      a3e7…<64 hex>…
customer_count 42
```

Use this to sanity-check the root hash before a real publish, or to compare
against a previously-published value.

### `ailedger attest publish`

Compute + publish + persist.

```
$ AILEDGER_ANCHOR_BACKEND=mock ailedger attest publish
network        mock
tx_id          c1b2…<64 hex>…
root_hash      a3e7…<64 hex>…
customer_count 42
anchored_at    2026-04-21T12:00:00+00:00
```

Override the backend per-invocation with `--backend`. Using `--backend bitcoin`
will exit non-zero: the money-spender is off until Jake replaces the stub.

The backend is called BEFORE the row is inserted. If publish fails, no row is
written — operators can retry without leaving half-anchored rows behind.

### `ailedger attest verify <tx-id>`

Given an on-chain tx id, verify the attestation end-to-end:

1. Look up the attestation row by `anchor_tx_id`.
2. Recompute the root hash from the stored `chain_head_map` and assert it
   matches the stored `root_hash`. This catches row-level tampering.
3. Ask the backend to verify the tx against the expected root hash.

```
$ ailedger attest verify c1b2…
OK — tx c1b2… anchors root_hash a3e7…<snip> (42 customers, mock)
```

Exit code 2 if any check fails; the CLI prints the reason.

### `ailedger attest list`

Shows the 20 most recent attestations (configurable via `--limit`):

```
$ ailedger attest list --limit 5
2026-04-21T12:00:00+00:00  mock             tx=c1b2d3e4f5a6b7c8…  root=a3e7…  customers=42
...
```

## Data model

`ledger.attestations` (migration `20260421_attestations_table.sql`):

| Column           | Type       | Notes                                                  |
|------------------|------------|--------------------------------------------------------|
| `id`             | uuid       | PK.                                                    |
| `root_hash`      | text(64)   | Hex SHA-256 of canonical chain-head serialization.     |
| `anchored_at`    | timestamptz| Set at insert time.                                    |
| `chain_head_map` | jsonb      | `{customer_id: chain_head_hash, ...}` snapshot.        |
| `anchor_network` | text       | `mock` / `bitcoin-testnet` / `bitcoin`.                |
| `anchor_tx_id`   | text       | Nullable (compute-only rows have none). Uniquely       |
|                  |            | indexed per network.                                   |
| `customer_count` | integer    | Snapshot size. `0` is a valid sentinel.                |

RLS: service_role only. Authenticated + anon are explicitly denied and lack
table grants.

## Canonical root-hash serialization

The root hash is reproducible by any regulator with access to the
`chain_head_map`:

```
sha256(
  "customer_a|<chain_head_hash_a>\n" +
  "customer_b|<chain_head_hash_b>\n" +
  ...
)
```

Customers are sorted lexicographically by `customer_id` before concatenation.
Empty map → `sha256("")`. See `compute_root_hash` in `cli/src/ailedger_cli/attest.py`
and its test fixtures for the canonical reference.

## Regulator verification path

A regulator holding the `chain_head_map` from the attestations row and the
`anchor_tx_id` can verify independently:

1. Recompute the root hash from the map (formula above).
2. Fetch the on-chain tx from a public Bitcoin explorer.
3. Assert the tx's OP_RETURN payload matches the root hash.

The CLI's `attest verify` automates steps 2-3 through the backend, but the
canonical serialization is intentionally simple so verification does not
depend on the CLI.

## Follow-ups

- Wire `bitcoin-testnet` backend to BTCPay Server or BlockCypher.
- Cron: invoke `ailedger attest publish` monthly from a controlled host.
- Surface past attestations on the customer dashboard (read-only).
- After Jake signoff: replace `BitcoinMainnetBackend` with a real impl,
  fund a wallet, and promote `bitcoin` to the default backend.
