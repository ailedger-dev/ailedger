"""
Panel definitions for the AILedger — Business Pulse dashboard.

Adding a panel: append a Panel(...) to PANELS. Tests in tests/test_panels.py
will automatically pick it up: schema-coverage, SQL-runs, columns-match.

Grid coordinates: Grafana grid is 24 columns wide; w/h in grid units.
Y positions stack from 0 down; existing panels occupy y=0..35 below.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Literal


DATASOURCE_UID = "ffmjsmjbkkw74c"  # AILedger Supabase (pooler, grafana_reader.<ref>)

PanelType = Literal["stat", "timeseries", "barchart", "table", "piechart"]
PanelFormat = Literal["table", "time_series"]


@dataclass(frozen=True)
class Panel:
    id: int
    slug: str  # snake_case, stable identifier used by tests
    title: str
    sql: str
    expects_columns: tuple[str, ...]
    panel_type: PanelType
    grid: tuple[int, int, int, int]  # (x, y, w, h)
    format: PanelFormat = "table"
    description: str = ""
    thresholds: tuple[dict, ...] = ()
    unit: str = "short"
    decimals: int | None = None

    @property
    def gridpos(self) -> dict[str, int]:
        x, y, w, h = self.grid
        return {"x": x, "y": y, "w": w, "h": h}


# ────────────────────────────────────────────────────────────────────────
# Required schema — tested directly in test_schema.py. If a panel references
# a column not listed here, add it and a new test will fail until you also
# add the panel's SQL.
# ────────────────────────────────────────────────────────────────────────

REQUIRED_SCHEMA: dict[str, dict[str, str]] = {
    "ledger.inference_logs": {
        "id": "bigint",
        "logged_at": "timestamp with time zone",
        "customer_id": "uuid",
        "provider": "text",
        "model_name": "text",
        "path": "text",
        "status_code": "integer",
        "latency_ms": "integer",
        "chain_prev_hash": "text",
    },
    "ledger.decision_events": {
        "event_id": "uuid",
        "timestamp": "timestamp with time zone",
        "tenant_id": "uuid",
    },
    "ledger.dogfeed_events": {
        "id": "bigint",
        "received_at": "timestamp with time zone",
        "tenant_id": "uuid",
    },
    "ledger.subscriptions": {
        "id": "bigint",
        "status": "text",
        "plan": "text",
    },
    "ledger.api_keys": {
        "id": "bigint",
        "customer_id": "uuid",
        "last_used_at": "timestamp with time zone",
    },
}


# ────────────────────────────────────────────────────────────────────────
# Threshold helpers
# ────────────────────────────────────────────────────────────────────────

def _t(steps: list[tuple[str | None, str]]) -> tuple[dict, ...]:
    """[(value, color), ...] → Grafana threshold steps. First step value is None."""
    return tuple({"value": v, "color": c} for v, c in steps)


GREEN_GROWING = _t([(None, "red"), (10, "yellow"), (100, "green")])
RED_AT_ONE = _t([(None, "green"), (1, "red")])
YELLOW_AT_ONE = _t([(None, "yellow"), (1, "green")])
HEARTBEAT_MIN = _t([(None, "green"), (5, "yellow"), (30, "red")])
ERROR_PCT = _t([(None, "green"), (1, "yellow"), (5, "red")])


# ────────────────────────────────────────────────────────────────────────
# Panels
# ────────────────────────────────────────────────────────────────────────

PANELS: list[Panel] = [
    # ── Row 1: Business Pulse (4 stats) ──
    Panel(
        id=1, slug="ingest_24h",
        title="Inference logs ingested (24h)",
        sql="SELECT count(*)::bigint AS value FROM ledger.inference_logs WHERE logged_at > now() - interval '24 hours';",
        expects_columns=("value",), panel_type="stat", grid=(0, 0, 6, 4),
        thresholds=GREEN_GROWING,
    ),
    Panel(
        id=2, slug="active_customers_7d",
        title="Active customers (7d)",
        sql="SELECT count(DISTINCT customer_id)::bigint AS value FROM ledger.inference_logs WHERE logged_at > now() - interval '7 days';",
        expects_columns=("value",), panel_type="stat", grid=(6, 0, 6, 4),
        thresholds=YELLOW_AT_ONE,
    ),
    Panel(
        id=3, slug="proxy_heartbeat_min",
        title="Minutes since last inference_log",
        sql="SELECT EXTRACT(EPOCH FROM (now() - max(logged_at)))/60.0 AS minutes FROM ledger.inference_logs;",
        expects_columns=("minutes",), panel_type="stat", grid=(12, 0, 6, 4),
        thresholds=HEARTBEAT_MIN, unit="m", decimals=1,
        description="Proxy heartbeat. Green < 5 min, yellow 5–30 min, red > 30 min.",
    ),
    Panel(
        id=4, slug="customers_with_chained_rows",
        title="Customers with chained rows",
        sql="SELECT count(DISTINCT customer_id)::bigint AS value FROM ledger.inference_logs WHERE chain_prev_hash IS NOT NULL;",
        expects_columns=("value",), panel_type="stat", grid=(18, 0, 6, 4),
        thresholds=YELLOW_AT_ONE,
        description="Lightweight chain-coverage indicator: how many customers have at least one chained inference_log row. Deeper per-customer verify_chain dashboard is a TODO (pg_cron + ledger.integrity_runs).",
    ),

    # ── Row 2: ingest rate timeseries (full width) ──
    Panel(
        id=5, slug="ingest_rate_per_min",
        title="Ingest rate (events/min)",
        sql="SELECT $__timeGroupAlias(logged_at, '1m'), count(*)::bigint AS events FROM ledger.inference_logs WHERE $__timeFilter(logged_at) GROUP BY 1 ORDER BY 1;",
        expects_columns=("time", "events"), panel_type="timeseries", format="time_series",
        grid=(0, 4, 24, 7),
    ),

    # ── Row 3: Reliability stats ──
    Panel(
        id=6, slug="error_rate_pct_1h",
        title="Proxy 5xx error rate % (1h)",
        sql="SELECT (100.0 * count(*) FILTER (WHERE status_code >= 500) / NULLIF(count(*), 0))::numeric(6,3) AS error_pct FROM ledger.inference_logs WHERE logged_at > now() - interval '1 hour';",
        expects_columns=("error_pct",), panel_type="stat", grid=(0, 11, 6, 4),
        thresholds=ERROR_PCT, unit="percent", decimals=2,
        description="5xx-as-percent-of-total over the last hour. Yellow > 1%, red > 5%.",
    ),
    Panel(
        id=7, slug="unchained_logs_1h",
        title="Unchained logs (1h, excluding genesis)",
        sql=(
            "SELECT count(*)::bigint AS value FROM ledger.inference_logs "
            "WHERE logged_at > now() - interval '1 hour' "
            "AND chain_prev_hash IS NULL "
            "AND NOT (provider = 'ailedger-system' AND path = '/_chain/genesis');"
        ),
        expects_columns=("value",), panel_type="stat", grid=(6, 11, 6, 4),
        thresholds=RED_AT_ONE,
        description="Rows written to inference_logs in the last hour with no chain_prev_hash (chain integrity gap), excluding /_chain/genesis disclosures which legitimately don't chain. Target: 0.",
    ),
    Panel(
        id=8, slug="decision_events_24h",
        title="Decision events (24h)",
        sql='SELECT count(*)::bigint AS value FROM ledger.decision_events WHERE "timestamp" > now() - interval \'24 hours\';',
        expects_columns=("value",), panel_type="stat", grid=(12, 11, 6, 4),
        description="Higher-level audit surface (charter / AI Act Article 50). Distinct volume from inference_logs; currently empty pending Decision Event writer.",
    ),
    Panel(
        id=9, slug="dogfeed_heartbeat_min",
        title="Dogfeed canary: minutes since last received",
        sql="SELECT EXTRACT(EPOCH FROM (now() - max(received_at)))/60.0 AS minutes FROM ledger.dogfeed_events;",
        expects_columns=("minutes",), panel_type="stat", grid=(18, 11, 6, 4),
        thresholds=HEARTBEAT_MIN, unit="m", decimals=1,
        description="Synthetic dogfeed canary heartbeat (proxy-side). If this goes red while the main heartbeat is green, the dogfeed runner is broken — proxy may still be ingesting customer traffic.",
    ),

    # ── Row 4: latency + provider mix ──
    Panel(
        id=10, slug="latency_quantiles_1h",
        title="Latency p50/p95/p99 (5m buckets, excludes 5xx)",
        sql=(
            "SELECT $__timeGroupAlias(logged_at, '5m'), "
            "percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms) AS p50, "
            "percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95, "
            "percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms) AS p99 "
            "FROM ledger.inference_logs "
            "WHERE $__timeFilter(logged_at) AND status_code < 500 "
            "GROUP BY 1 ORDER BY 1;"
        ),
        expects_columns=("time", "p50", "p95", "p99"),
        panel_type="timeseries", format="time_series",
        grid=(0, 15, 12, 7), unit="ms",
    ),
    Panel(
        id=11, slug="provider_mix_24h",
        title="Provider mix (24h)",
        sql=(
            "SELECT provider, count(*)::bigint AS events "
            "FROM ledger.inference_logs WHERE logged_at > now() - interval '24 hours' "
            "GROUP BY 1 ORDER BY events DESC;"
        ),
        expects_columns=("provider", "events"),
        panel_type="barchart", grid=(12, 15, 12, 7),
        description="Upstream provider mix. Single-provider concentration means proportional blast radius from a provider outage.",
    ),

    # ── Row 5: events per customer + noisy customers ──
    Panel(
        id=12, slug="events_per_customer_24h",
        title="Events per customer (24h)",
        sql=(
            "SELECT customer_id::text AS customer, count(*)::bigint AS events "
            "FROM ledger.inference_logs WHERE logged_at > now() - interval '24 hours' "
            "GROUP BY 1 ORDER BY events DESC LIMIT 20;"
        ),
        expects_columns=("customer", "events"),
        panel_type="barchart", grid=(0, 22, 12, 8),
        description="customer_id is a uuid. grafana_reader can't read auth.users (PII protection) — cross-reference in Supabase dashboard.",
    ),
    Panel(
        id=13, slug="noisy_customers_1h",
        title="Noisiest customers by 5xx rate (1h, ≥10 reqs)",
        sql=(
            "SELECT customer_id::text AS customer, "
            "count(*) AS total, "
            "count(*) FILTER (WHERE status_code >= 500) AS errors_5xx, "
            "round(100.0 * count(*) FILTER (WHERE status_code >= 500) / NULLIF(count(*), 0), 2) AS error_pct "
            "FROM ledger.inference_logs WHERE logged_at > now() - interval '1 hour' "
            "GROUP BY 1 HAVING count(*) > 10 ORDER BY error_pct DESC LIMIT 10;"
        ),
        expects_columns=("customer", "total", "errors_5xx", "error_pct"),
        panel_type="table", grid=(12, 22, 12, 8),
        description="Per-tenant SLO view: which customer is currently degrading the error budget.",
    ),

    # ── Row 6: subs + api keys per customer ──
    Panel(
        id=14, slug="subscriptions_by_plan",
        title="Subscriptions by plan × status",
        sql=(
            "SELECT coalesce(plan, '(no plan)') AS plan, status, count(*)::bigint AS subscribers "
            "FROM ledger.subscriptions GROUP BY plan, status ORDER BY subscribers DESC;"
        ),
        expects_columns=("plan", "status", "subscribers"),
        panel_type="table", grid=(0, 30, 12, 6),
    ),
    Panel(
        id=15, slug="api_keys_per_customer",
        title="API keys per customer",
        sql=(
            "SELECT customer_id::text AS customer, count(*)::bigint AS keys "
            "FROM ledger.api_keys GROUP BY 1 ORDER BY keys DESC LIMIT 20;"
        ),
        expects_columns=("customer", "keys"),
        panel_type="barchart", grid=(12, 30, 12, 6),
    ),

    # ── Row 7: idle api keys ──
    Panel(
        id=16, slug="api_keys_idle_30d",
        title="API keys idle ≥30d (or never used)",
        sql=(
            "SELECT count(*)::bigint AS idle FROM ledger.api_keys "
            "WHERE last_used_at IS NULL OR last_used_at < now() - interval '30 days';"
        ),
        expects_columns=("idle",), panel_type="stat", grid=(0, 36, 6, 4),
        description="Idle keys are rotation candidates: high count suggests stale onboarding leftovers.",
    ),
]


def panel_by_slug(slug: str) -> Panel:
    for p in PANELS:
        if p.slug == slug:
            return p
    raise KeyError(slug)
