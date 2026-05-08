# ailedger-cli

Command-line companion for [AILedger](https://ailedger.dev).

## Install

```sh
pip install ailedger-cli
# or from this repo:
pip install -e ./cli
```

Requires Python 3.11+.

## Configure

`ailedger-cli` reads its base URL from `~/.config/ailedger/config.toml`. API
keys are **never** stored in that file — supply them via the `AILEDGER_API_KEY`
environment variable, or install the `keyring` extra to use your OS credential
store (`pip install 'ailedger-cli[keyring]'`).

```sh
# Point the CLI at your AILedger deployment.
ailedger config --set base-url=https://proxy.ailedger.dev

# Inspect current values.
ailedger config --get base-url

# Store / retrieve the API key via OS keyring (requires the `keyring` extra).
ailedger config --set-secret api-key
ailedger config --get api-key
```

If you have not installed the keyring extra, set the key in the environment:

```sh
export AILEDGER_API_KEY=ail_sk_…
```

## Subcommands

### `ailedger verify`

Recomputes the hash-chain across inference rows and reports integrity.

```sh
ailedger verify                         # all rows visible to your key
ailedger verify --customer <uuid>       # filter to one customer
ailedger verify --since 2026-01-01      # filter by ISO date
```

> **Note**: chain verification is gated behind the `AILEDGER_CHAIN_ENABLED`
> environment variable until the `chain_prev_hash` column lands in production
> (targeted for v1.1). Without it, `verify` prints a friendly stub.

### `ailedger export`

Fetches rows in a date range and renders a tamper-evident PDF compliance
report. Each row includes its per-row content hash and the metadata required by
EU AI Act Article 12. Once the chain is live, the report also carries the
chain-head signature for the exported window.

```sh
ailedger export --from 2026-01-01 --to 2026-03-31 --out q1-report.pdf
```

### `ailedger config`

```sh
ailedger config --set base-url=https://proxy.ailedger.dev
ailedger config --get base-url
ailedger config --list
ailedger config --set-secret api-key   # keyring extra required
```

## Security

- API keys are never written to disk by this CLI. `--set api-key=…` is rejected.
- Config lives at `~/.config/ailedger/config.toml` (0600).
- All network calls use HTTPS and the Supabase REST endpoint configured via
  `base-url`.

## Development

```sh
pip install -e '.[dev,keyring]'
pytest
ruff check src tests
```
