"""Direct tests for the PDF export logic."""

from __future__ import annotations

import datetime as dt
import importlib.util

import pytest

from ailedger_cli.export import ExportWindow, generate_report

REPORTLAB_AVAILABLE = importlib.util.find_spec("reportlab") is not None
pytestmark = pytest.mark.skipif(
    not REPORTLAB_AVAILABLE, reason="reportlab not installed"
)


def _rows(n: int) -> list[dict]:
    return [
        {
            "id": f"r-{i}",
            "customer_id": "c",
            "system_id": "s",
            "provider": "openai",
            "model": "gpt-4.1-mini",
            "input_hash": f"in-{i}",
            "output_hash": f"out-{i}",
            "status_code": 200,
            "latency_ms": 10,
            "started_at": f"2026-01-{i + 1:02d}T00:00:00Z",
            "completed_at": f"2026-01-{i + 1:02d}T00:00:01Z",
            "created_at": f"2026-01-{i + 1:02d}T00:00:01Z",
            "prev_hash": "",
        }
        for i in range(n)
    ]


def test_generate_report_produces_pdf(tmp_path):
    out = tmp_path / "r.pdf"
    generate_report(
        _rows(3),
        ExportWindow(start=dt.date(2026, 1, 1), end=dt.date(2026, 1, 31)),
        out,
    )
    assert out.exists()
    assert out.read_bytes().startswith(b"%PDF")
    assert out.stat().st_size > 500


def test_generate_report_handles_empty_window(tmp_path):
    out = tmp_path / "r.pdf"
    generate_report(
        [],
        ExportWindow(start=dt.date(2026, 1, 1), end=dt.date(2026, 1, 31)),
        out,
    )
    assert out.exists()
    assert out.read_bytes().startswith(b"%PDF")


def test_generate_report_with_chain_enabled(tmp_path):
    out = tmp_path / "r.pdf"
    generate_report(
        _rows(2),
        ExportWindow(start=dt.date(2026, 1, 1), end=dt.date(2026, 1, 31)),
        out,
        chain_enabled=True,
    )
    assert out.exists()
    assert out.read_bytes().startswith(b"%PDF")
