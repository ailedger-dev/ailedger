# SQL tests — T3 + T4

Real-Postgres tests for `proxy/migrations/20260418_tamper_evident_chain.sql`.

These cover:

- **T3** (`chain.spec.mjs`) — the BEFORE INSERT trigger:
  - sequential inserts produce a valid chain
  - 1000 concurrent inserts for one customer produce a valid chain (proves the
    per-customer advisory lock works)
  - concurrent inserts for different customers do not serialize against each
    other
  - genesis-disclosure rows reset the chain
- **T4** (`verify-chain.spec.mjs`) — `ledger.verify_chain(uuid)`:
  - empty / single / 1000-row chains
  - tampering at row N is reported with `expected_hash` / `actual_hash`
  - mid-chain genesis-disclosure rows produce a distinguishable signal
  - cross-tenant boundary: customer A calling `verify_chain(B)` sees an empty
    chain because RLS + SECURITY INVOKER hide B's rows

## Why a separate runner

The proxy itself is a Cloudflare Worker, so `vitest` runs in
`@cloudflare/vitest-pool-workers` with no Postgres. These tests need a real
Postgres (the trigger's `pg_advisory_xact_lock` and `digest()` aren't mockable
in any way that would still test what we actually ship). Keeping them in a
sibling package keeps the worker test loop fast and lets CI run them
separately.

## Running locally

You need Postgres ≥ 15 with `pgcrypto`.

```bash
# 1. Start a throwaway Postgres (any flavor — Docker is the easiest):
docker run --rm -d --name ailedger-pg \
  -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16

# 2. Point the tests at it:
export AILEDGER_TEST_DATABASE_URL="postgres://postgres:test@localhost:55432/postgres"

# 3. Run:
cd proxy/test/sql
npm install
npm test
```

The 1000-row tests take ~10–30 s depending on the Postgres host. Everything is
self-contained: each test creates its own customer UUIDs, so test files don't
collide and you can re-run without resetting the database.

## CI

Gate this to **nightly** CI (or a pre-release gate) — it's slow and needs a
real database. Suggested workflow step:

```yaml
- name: SQL tests (chain trigger + verify_chain)
  if: github.event_name == 'schedule'
  services:
    postgres:
      image: postgres:16
      env: { POSTGRES_PASSWORD: test }
      ports: ["5432:5432"]
      options: >-
        --health-cmd "pg_isready"
        --health-interval 5s
        --health-timeout 5s
        --health-retries 10
  env:
    AILEDGER_TEST_DATABASE_URL: postgres://postgres:test@localhost:5432/postgres
  run: |
    cd proxy/test/sql
    npm ci
    npm test
```

## What's mocked vs. real

| Component | In these tests |
|-----------|----------------|
| `auth.users` table | Mocked — id-only stub. The migration only uses the FK. |
| `auth.uid()` | Mocked — reads `current_setting('test.uid')`. Set per-transaction with `set local`. |
| `extensions.digest()` (pgcrypto) | **Real** — required for the SHA-256 chain. |
| `ledger.inference_logs` | **Real** — created from production schema. |
| The migration file | **Real** — applied verbatim, no edits. |
| The trigger + `verify_chain` + `chain_head` | **Real** — these are what's under test. |

If a future migration changes the canonical-hash field order, these tests will
catch it because the chain is constructed and verified entirely by production
code paths.
