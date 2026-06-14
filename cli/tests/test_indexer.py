"""Tests for the indexer read client + the `events` command (reads cut-over)."""

from __future__ import annotations

import httpx
from click.testing import CliRunner

from ailedger_cli.indexer import IndexerClient
from ailedger_cli.main import cli

_EVENTS = [
    {"seq": 2, "event_id": "e2", "decision_type": "employment_screening", "ts": "2026-06-14T00:00:02Z"},
    {"seq": 1, "event_id": "e1", "decision_type": "employment_screening", "ts": "2026-06-14T00:00:01Z"},
]


def _handler(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path == "/v1/tenants/jv-fleet/events":
        return httpx.Response(200, json={"events": _EVENTS})
    if path == "/v1/events/e1":
        return httpx.Response(200, json=_EVENTS[1])
    if path == "/v1/events/missing":
        return httpx.Response(404, json={"error": "not found"})
    if path == "/v1/tenants/jv-fleet/chain":
        return httpx.Response(200, json={"topic_id": "0.0.200", "records": 2, "continuous": True})
    return httpx.Response(404, json={"error": f"unexpected {path}"})


def _client() -> IndexerClient:
    return IndexerClient("http://ix", transport=httpx.MockTransport(_handler))


def test_tenant_events_unwraps_the_envelope():
    with _client() as ix:
        events = ix.tenant_events("jv-fleet")
    assert [e["event_id"] for e in events] == ["e2", "e1"]


def test_event_returns_none_on_404():
    with _client() as ix:
        assert ix.event("e1")["seq"] == 1
        assert ix.event("missing") is None


def test_chain_status():
    with _client() as ix:
        assert ix.chain("jv-fleet")["records"] == 2


def test_wait_for_sealed_polls_until_present():
    # Handler that 404s the first two polls, then returns the event.
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] < 3:
            return httpx.Response(404, json={"error": "pending"})
        return httpx.Response(200, json={"event_id": "e1", "seq": 1})

    ix = IndexerClient("http://ix", transport=httpx.MockTransport(handler))
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
    ix = IndexerClient(
        "http://ix",
        transport=httpx.MockTransport(lambda r: httpx.Response(404, json={})),
    )
    clock = {"t": 0.0}
    sealed = ix.wait_for_sealed(
        "never",
        timeout=5,
        interval=1,
        now=lambda: clock["t"],
        sleep=lambda s: clock.__setitem__("t", clock["t"] + s),
    )
    assert sealed is None


def test_events_command_via_indexer(monkeypatch):
    transport = httpx.MockTransport(_handler)
    monkeypatch.setattr(
        "ailedger_cli.indexer.IndexerClient",
        lambda base, **kw: IndexerClient(base, transport=transport),
    )
    result = CliRunner().invoke(
        cli, ["events", "--tenant", "jv-fleet", "--indexer", "http://ix"]
    )
    assert result.exit_code == 0, result.output
    assert "2 decision event(s) from indexer" in result.output
    assert "e2" in result.output and "e1" in result.output
