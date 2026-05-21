"""Live SQL tests for every panel.

For each panel:
  - the SQL runs without error against live Supabase
  - the returned columns include the panel's expects_columns

Grafana template macros ($__timeFilter / $__timeGroupAlias) only resolve in
Grafana, not in raw Postgres — for those, we substitute a 24h window before
sending to Supabase. The substitution mirrors what Grafana's Postgres
datasource would generate.
"""
from __future__ import annotations
import re
import pytest

from grafana_ailedger.panels import PANELS, Panel


pytestmark = pytest.mark.live


def _expand_grafana_macros(sql: str) -> str:
    """Substitute Grafana's Postgres template macros with concrete SQL for
    live testing against the Management API.

      $__timeFilter(col)        → col BETWEEN <24h ago> AND <now>
      $__timeGroupAlias(col, k) → date_trunc('...', col) AS time
    """
    sql = re.sub(
        r"\$__timeFilter\(([^)]+)\)",
        r"(\1 BETWEEN now() - interval '24 hours' AND now())",
        sql,
    )

    def _group(match: re.Match) -> str:
        col, bucket = [s.strip() for s in match.group(1).split(",")]
        bucket = bucket.strip("'\"")
        unit = {"1m": "minute", "5m": "minute", "1h": "hour", "1d": "day"}.get(bucket, "minute")
        return f"date_trunc('{unit}', {col}) AS time"

    sql = re.sub(r"\$__timeGroupAlias\(([^)]+)\)", _group, sql)
    return sql


@pytest.mark.parametrize("panel", PANELS, ids=lambda p: p.slug)
def test_panel_sql_runs_without_error(supabase, panel: Panel):
    sql = _expand_grafana_macros(panel.sql)
    # Wrap as a subquery so we don't depend on result shape — just that it parses + executes.
    probe = f"SELECT 1 AS ok FROM ({sql.rstrip(';')}) panel_q LIMIT 1;"
    # Empty-result panels are allowed (decision_events is currently empty); the
    # important thing is no SQL/permissions error.
    supabase.sql(probe)


@pytest.mark.parametrize("panel", PANELS, ids=lambda p: p.slug)
def test_panel_returns_expected_columns(supabase, panel: Panel):
    sql = _expand_grafana_macros(panel.sql)
    rows = supabase.sql(sql)
    if not rows:
        # No rows returned — column shape can't be verified, but the SQL ran
        # (covered by the other test). For decision_events (empty table) this
        # is the expected state.
        pytest.skip(f"{panel.slug}: SQL ran but returned no rows; column shape unverifiable")
    returned = set(rows[0].keys())
    missing = set(panel.expects_columns) - returned
    assert not missing, (
        f"{panel.slug}: expected columns {panel.expects_columns} "
        f"but got {sorted(returned)} (missing: {sorted(missing)})"
    )
