"""Tests for the stdlib indexer client (enumeration + sealing confirmation)."""

from __future__ import annotations

import json
import urllib.error

import pytest

from ailedger_detection import IndexerClient, IndexerError

_EVENTS = [
    {"seq": 2, "event_id": "e2", "decision_type": "screening", "ts": "2026-06-14T00:00:02Z"},
    {"seq": 1, "event_id": "e1", "decision_type": "screening", "ts": "2026-06-14T00:00:01Z"},
]


def _opener(routes: dict[str, object]):
    """Fake opener: returns JSON bytes for known paths, raises HTTPError(404) else."""

    def _open(url: str) -> bytes:
        for suffix, payload in routes.items():
            if url.endswith(suffix):
                return json.dumps(payload).encode("utf-8")
        raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)  # type: ignore[arg-type]

    return _open


def test_tenant_events_unwraps_envelope():
    ix = IndexerClient(
        "http://ix",
        opener=_opener({"/v1/tenants/jv-fleet/events?limit=1000": {"events": _EVENTS}}),
    )
    assert [e["event_id"] for e in ix.tenant_events("jv-fleet")] == ["e2", "e1"]


def test_event_present_and_absent():
    ix = IndexerClient("http://ix", opener=_opener({"/v1/events/e1": _EVENTS[1]}))
    assert ix.event("e1")["seq"] == 1
    assert ix.event("missing") is None  # 404 → None


def test_malformed_events_envelope_raises():
    ix = IndexerClient("http://ix", opener=_opener({"/v1/tenants/x/events?limit=1000": ["not", "wrapped"]}))
    with pytest.raises(IndexerError):
        ix.tenant_events("x")


def test_wait_for_sealed_polls_then_resolves():
    calls = {"n": 0}

    def opener(url: str) -> bytes:
        calls["n"] += 1
        if calls["n"] < 3:
            raise urllib.error.HTTPError(url, 404, "pending", {}, None)  # type: ignore[arg-type]
        return json.dumps({"event_id": "e1", "seq": 1}).encode("utf-8")

    ix = IndexerClient("http://ix", opener=opener)
    clock = {"t": 0.0}
    sealed = ix.wait_for_sealed(
        "e1",
        timeout=100,
        interval=1,
        now=lambda: clock["t"],
        sleep=lambda s: clock.__setitem__("t", clock["t"] + s),
    )
    assert sealed is not None and sealed["event_id"] == "e1"


def test_wait_for_sealed_times_out_to_none():
    def opener(url: str) -> bytes:
        raise urllib.error.HTTPError(url, 404, "pending", {}, None)  # type: ignore[arg-type]

    ix = IndexerClient("http://ix", opener=opener)
    clock = {"t": 0.0}
    sealed = ix.wait_for_sealed(
        "never",
        timeout=5,
        interval=1,
        now=lambda: clock["t"],
        sleep=lambda s: clock.__setitem__("t", clock["t"] + s),
    )
    assert sealed is None
