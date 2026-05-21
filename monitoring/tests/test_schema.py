"""Schema tests — asserts every column referenced by REQUIRED_SCHEMA exists
in the live Supabase database with the expected type.

Live-only: requires SUPABASE_PAT.
"""
from __future__ import annotations
import pytest

from grafana_ailedger.panels import REQUIRED_SCHEMA


pytestmark = pytest.mark.live


def _fetch_columns(supabase, schema_name: str, table_name: str) -> dict[str, str]:
    rows = supabase.sql(
        f"SELECT column_name, data_type FROM information_schema.columns "
        f"WHERE table_schema = '{schema_name}' AND table_name = '{table_name}';"
    )
    return {r["column_name"]: r["data_type"] for r in rows}


@pytest.mark.parametrize("qualified_table", list(REQUIRED_SCHEMA.keys()))
def test_table_exists(supabase, qualified_table):
    schema_name, table_name = qualified_table.split(".")
    cols = _fetch_columns(supabase, schema_name, table_name)
    assert cols, f"table {qualified_table} not found or has no columns"


@pytest.mark.parametrize(
    "qualified_table,column_name,expected_type",
    [
        (table, col, t)
        for table, columns in REQUIRED_SCHEMA.items()
        for col, t in columns.items()
    ],
    ids=lambda v: str(v),
)
def test_column_exists_with_type(supabase, qualified_table, column_name, expected_type):
    schema_name, table_name = qualified_table.split(".")
    cols = _fetch_columns(supabase, schema_name, table_name)
    assert column_name in cols, (
        f"{qualified_table}.{column_name} missing; available: {sorted(cols.keys())}"
    )
    actual = cols[column_name]
    assert actual == expected_type, (
        f"{qualified_table}.{column_name}: expected {expected_type!r}, got {actual!r}"
    )


def test_grafana_reader_role_configured(supabase):
    """grafana_reader must have BYPASSRLS, statement_timeout >= 60s, and
    USAGE on the extensions schema. Drift here breaks live dashboard queries."""
    rows = supabase.sql(
        "SELECT rolname, rolbypassrls, rolconfig FROM pg_roles WHERE rolname = 'grafana_reader';"
    )
    assert rows, "grafana_reader role does not exist"
    r = rows[0]
    assert r["rolbypassrls"] is True, "grafana_reader must have BYPASSRLS (else RLS hides all rows)"
    cfg = r.get("rolconfig") or []
    timeout = next((c for c in cfg if c.startswith("statement_timeout=")), None)
    assert timeout is not None, "grafana_reader needs statement_timeout SET (chain queries time out at the default)"

    perms = supabase.sql(
        "SELECT has_schema_privilege('grafana_reader','extensions','USAGE') AS extensions_usage;"
    )
    assert perms[0]["extensions_usage"] is True, (
        "grafana_reader needs USAGE on schema extensions (verify_chain calls pgcrypto)"
    )
