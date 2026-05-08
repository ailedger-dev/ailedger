"""End-to-end tests for the Click CLI."""

from __future__ import annotations

import importlib.util

import pytest
from click.testing import CliRunner

from ailedger_cli.config import API_KEY_ENV_VAR, load_config
from ailedger_cli.main import cli

REPORTLAB_AVAILABLE = importlib.util.find_spec("reportlab") is not None


def test_cli_help():
    result = CliRunner().invoke(cli, ["--help"])
    assert result.exit_code == 0
    assert "verify" in result.output
    assert "export" in result.output
    assert "config" in result.output


def test_config_set_and_get(tmp_config):
    runner = CliRunner()
    r1 = runner.invoke(cli, ["config", "--set", "base-url=https://x.dev"])
    assert r1.exit_code == 0, r1.output
    assert load_config(tmp_config) == {"base-url": "https://x.dev"}

    r2 = runner.invoke(cli, ["config", "--get", "base-url"])
    assert r2.exit_code == 0
    assert r2.output.strip() == "https://x.dev"


def test_config_list_shows_api_key_status(tmp_config, monkeypatch):
    runner = CliRunner()
    runner.invoke(cli, ["config", "--set", "base-url=https://x.dev"])

    r = runner.invoke(cli, ["config", "--list"])
    assert r.exit_code == 0
    assert "base-url = https://x.dev" in r.output
    assert "api-key: not set" in r.output

    monkeypatch.setenv(API_KEY_ENV_VAR, "ail_sk_env")
    r = runner.invoke(cli, ["config", "--list"])
    assert "api-key: set (hidden)" in r.output


def test_config_rejects_api_key_via_set(tmp_config):
    r = CliRunner().invoke(cli, ["config", "--set", "api-key=ail_sk_x"])
    assert r.exit_code != 0
    assert "refusing to write api-key" in r.output.lower()


def test_config_get_unknown_key(tmp_config):
    r = CliRunner().invoke(cli, ["config", "--get", "base-url"])
    assert r.exit_code != 0
    assert "not set" in r.output


def test_verify_stub_when_flag_disabled(tmp_config):
    r = CliRunner().invoke(cli, ["verify"])
    assert r.exit_code == 0
    assert "v1.1" in r.output


def test_verify_errors_without_config_when_flag_enabled(tmp_config, monkeypatch):
    monkeypatch.setenv("AILEDGER_CHAIN_ENABLED", "1")
    r = CliRunner().invoke(cli, ["verify"])
    assert r.exit_code != 0
    assert "base-url not configured" in r.output


def test_verify_errors_without_api_key_when_flag_enabled(tmp_config, monkeypatch):
    monkeypatch.setenv("AILEDGER_CHAIN_ENABLED", "1")
    CliRunner().invoke(cli, ["config", "--set", "base-url=https://x.dev"])
    r = CliRunner().invoke(cli, ["verify"])
    assert r.exit_code != 0
    assert "api-key" in r.output.lower()


def test_export_rejects_reversed_dates(tmp_config, monkeypatch, tmp_path):
    monkeypatch.setenv(API_KEY_ENV_VAR, "ail_sk_env")
    CliRunner().invoke(cli, ["config", "--set", "base-url=https://x.dev"])
    out = tmp_path / "r.pdf"
    r = CliRunner().invoke(
        cli,
        ["export", "--from", "2026-03-31", "--to", "2026-01-01", "--out", str(out)],
    )
    assert r.exit_code != 0
    assert "on/after" in r.output


def test_export_rejects_bad_date(tmp_config, tmp_path):
    out = tmp_path / "r.pdf"
    r = CliRunner().invoke(
        cli,
        ["export", "--from", "not-a-date", "--to", "2026-01-01", "--out", str(out)],
    )
    assert r.exit_code != 0


@pytest.mark.skipif(not REPORTLAB_AVAILABLE, reason="reportlab not installed")
def test_export_writes_pdf(tmp_config, tmp_path, monkeypatch):
    monkeypatch.setenv(API_KEY_ENV_VAR, "ail_sk_env")
    CliRunner().invoke(cli, ["config", "--set", "base-url=https://x.supabase.co"])

    # Patch the LedgerClient the command uses to return canned rows.
    sample_rows = [
        {
            "id": "r-1",
            "customer_id": "c-1",
            "system_id": "s-1",
            "provider": "openai",
            "model": "gpt-4.1-mini",
            "input_hash": "ihash",
            "output_hash": "ohash",
            "status_code": 200,
            "latency_ms": 42,
            "started_at": "2026-01-15T00:00:00Z",
            "completed_at": "2026-01-15T00:00:01Z",
            "created_at": "2026-01-15T00:00:01Z",
            "prev_hash": "",
        }
    ]

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return None

        def fetch_rows(self, _opts):
            return sample_rows

        def close(self):
            pass

    monkeypatch.setattr("ailedger_cli.main.LedgerClient", FakeClient)

    out = tmp_path / "report.pdf"
    r = CliRunner().invoke(
        cli,
        ["export", "--from", "2026-01-01", "--to", "2026-01-31", "--out", str(out)],
    )
    assert r.exit_code == 0, r.output
    assert out.exists()
    assert out.stat().st_size > 500  # non-trivial PDF
    assert out.read_bytes().startswith(b"%PDF")
    assert "wrote 1 rows" in r.output
