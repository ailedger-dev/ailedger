"""Tests for the hash-chain replay logic."""

from __future__ import annotations

from ailedger_cli.verify import (
    CHAIN_FLAG_ENV,
    chain_enabled,
    row_content_hash,
    verify_chain,
)


def _row(index: int, prev_hash: str, **overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "id": f"row-{index}",
        "customer_id": "cust-1",
        "system_id": "sys-1",
        "provider": "openai",
        "model": "gpt-4.1-mini",
        "input_hash": f"in-{index}",
        "output_hash": f"out-{index}",
        "status_code": 200,
        "latency_ms": 123,
        "started_at": f"2026-01-{index:02d}T00:00:00Z",
        "completed_at": f"2026-01-{index:02d}T00:00:01Z",
        "prev_hash": prev_hash,
    }
    base.update(overrides)
    return base


def test_chain_enabled_respects_env():
    assert chain_enabled({CHAIN_FLAG_ENV: "1"})
    assert chain_enabled({CHAIN_FLAG_ENV: "true"})
    assert chain_enabled({CHAIN_FLAG_ENV: "ON"})
    assert not chain_enabled({CHAIN_FLAG_ENV: "0"})
    assert not chain_enabled({CHAIN_FLAG_ENV: ""})
    assert not chain_enabled({})


def test_row_content_hash_is_deterministic():
    row = _row(1, "")
    assert row_content_hash(row) == row_content_hash(dict(row))


def test_row_content_hash_changes_when_field_changes():
    before = row_content_hash(_row(1, ""))
    after = row_content_hash(_row(1, "", output_hash="tampered"))
    assert before != after


def test_row_content_hash_handles_none_like_missing():
    row = _row(1, "")
    row["system_id"] = None
    # missing key vs None should be treated the same
    without_key = {k: v for k, v in row.items() if k != "system_id"}
    assert row_content_hash(row) == row_content_hash(without_key)


def test_verify_chain_happy_path():
    rows = []
    prev = ""
    for i in range(1, 4):
        row = _row(i, prev)
        rows.append(row)
        prev = row_content_hash(row)

    report = verify_chain(rows)
    assert report.ok
    assert report.row_count == 3
    assert report.chain_head == prev
    assert "OK" in report.summary()


def test_verify_chain_detects_break():
    rows = []
    prev = ""
    for i in range(1, 4):
        row = _row(i, prev)
        rows.append(row)
        prev = row_content_hash(row)

    # Corrupt the middle row's prev_hash — the second row's prev should have
    # matched row 0's hash, but we overwrite it.
    rows[1]["prev_hash"] = "tampered"

    report = verify_chain(rows)
    assert not report.ok
    assert len(report.breaks) >= 1
    assert report.breaks[0].index == 1
    assert "BROKEN" in report.summary()


def test_verify_chain_empty():
    report = verify_chain([])
    assert report.ok
    assert report.row_count == 0
    assert report.chain_head is None
    assert "no rows" in report.summary()


def test_verify_chain_first_row_prev_must_be_empty():
    rows = [_row(1, "nonempty-prev")]
    report = verify_chain(rows)
    assert not report.ok
    assert report.breaks[0].expected_prev == ""
    assert report.breaks[0].actual_prev == "nonempty-prev"
