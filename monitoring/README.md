# monitoring/

AILedger Grafana dashboards defined as code, with tests.

## Why this exists

Dashboards drift when they live only in Grafana's UI. This module:
- Defines every panel as a Python object (`grafana_ailedger.panels`)
- Generates the dashboard JSON deterministically (`grafana_ailedger.dashboard`)
- Tests every panel's SQL against the live schema before it ships (`tests/`)
- POSTs the result to the live Grafana via API (`bin/build-dashboard.py`)

Adding a panel is one Python tuple; tests automatically pick it up.

## What's covered (Tier 1)

Dashboard: **AILedger — Business Pulse** (uid `ailedger-business-pulse`), 16 panels in 4 rows:

| Row | Panels |
|---|---|
| Business Pulse | inference ingest 24h, active customers 7d, proxy heartbeat, ingest rate timeseries |
| Reliability | error rate %, latency p50/p95/p99, provider/model mix, top-10 noisy customers |
| Audit Surface | unchained logs, decision events rate, dogfeed canary, customers with chained rows |
| Tenants & Subscriptions | events per customer, subscriptions by plan, idle API keys, API keys per customer |

## Layout

```
monitoring/
├── src/grafana_ailedger/
│   ├── panels.py          # PANELS = [Panel(...), ...]
│   ├── dashboard.py       # builds dashboard JSON from panels
│   └── client.py          # SupabaseClient + GrafanaClient (live ops)
├── tests/
│   ├── test_dashboard.py  # dashboard JSON structure (no network)
│   ├── test_schema.py     # asserts referenced tables/columns exist  [live]
│   └── test_panels.py     # each panel SQL runs + returns expected columns  [live]
├── bin/
│   ├── build-dashboard.py # POST dashboard to live Grafana
│   └── render-json.py     # dump dashboard JSON to stdout
├── pyproject.toml
└── README.md
```

## Running tests

```sh
# Local dev — install once
python3 -m pip install -e ".[dev]"

# Structure tests (no network, always runnable, runs in CI)
pytest -m "not live"

# Live integration tests (requires Supabase Management API PAT)
SUPABASE_PAT=$(cat ~/.secrets/supabase-pat) pytest

# Just the live tests
SUPABASE_PAT=... pytest -m live
```

## Shipping a dashboard change

```sh
# 1. Edit src/grafana_ailedger/panels.py
# 2. Run live tests (catches schema/SQL drift before it hits Grafana)
SUPABASE_PAT=$(cat ~/.secrets/supabase-pat) pytest

# 3. POST to live Grafana
GRAFANA_URL=http://100.113.167.50:3001 \
GRAFANA_USER=admin \
GRAFANA_PASSWORD=$(cat ~/.secrets/grafana-admin) \
python3 bin/build-dashboard.py
```

## CI

`.github/workflows/deploy.yml` `gates` job runs `pytest -m "not live"` in this dir.
Live tests run only if the repo has `SUPABASE_PAT` set as a GitHub Actions secret;
otherwise CI tests structure-only. The dashboard POST is **not** automated from
CI — production-grade rollout pattern would be Grafana provisioning YAML synced
by a separate job. Today the POST is operator-triggered via `bin/build-dashboard.py`.

## Where the live dashboard lives

`http://100.113.167.50:3001/d/ailedger-business-pulse` (Tailscale-only; reach forge from outside via `ssh -L 3001:localhost:3001 100.113.167.50`).
