"""Emitter tests — fake transport; validation must refuse before any I/O."""

from __future__ import annotations

import json
from typing import Any

import pytest

from ailedger_detection.decision_event import SeamSchemaError
from ailedger_detection.emitter import RelayEmitter, RelayError
from tests.test_decision_event import seam_event


class FakeTransport:
    def __init__(self, status: int = 202, body: dict[str, Any] | None = None) -> None:
        self.calls: list[tuple[str, dict[str, str], bytes]] = []
        self.status = status
        self.body = body if body is not None else {"status": "queued"}

    def __call__(self, url: str, headers: dict[str, str], body: bytes) -> tuple[int, bytes]:
        self.calls.append((url, headers, body))
        return self.status, json.dumps(self.body).encode()


def test_emit_posts_mapped_body_with_auth() -> None:
    transport = FakeTransport(body={"event_id": "x", "status": "queued"})
    emitter = RelayEmitter("http://relay:8788/", api_key="alk_test", transport=transport)
    result = emitter.emit(seam_event())
    assert result["status"] == "queued"
    url, headers, raw = transport.calls[0]
    assert url == "http://relay:8788/v2/detection-events"
    assert headers["Authorization"] == "Bearer alk_test"
    body = json.loads(raw)
    assert body["decision_type"] == "architecture_decision"
    assert body["inputs"]["rejected_alternatives"][0].startswith("duckdb")


def test_unwarranted_decision_routes_to_unwarranted_endpoint() -> None:
    # OWT: an unwarranted decision is RECORDED (gap-honest), not dropped.
    transport = FakeTransport(body={"event_id": "x", "status": "queued"})
    emitter = RelayEmitter("http://relay:8788", api_key="alk_test", transport=transport)
    for warrant, category in [
        ({"justification": "", "rejected_alternatives": ["x"]}, "missing-justification"),
        ({"justification": "why", "rejected_alternatives": []}, "empty-alternatives"),
        ({"justification": "why", "rejected_alternatives": ["x"], "confidence": 0.1}, "weak-warrant"),
    ]:
        transport.calls.clear()
        emitter.emit(seam_event(warrant=warrant))
        url, _, raw = transport.calls[0]
        assert url == "http://relay:8788/v2/unwarranted-events"
        body = json.loads(raw)
        assert body["unwarrant_category"] == category
        assert body["attempt"]["warrant"] == warrant  # full attempt carried for sealing


def test_malformed_decision_still_refused_pre_network() -> None:
    # A non-decision (no decision_id) is not recordable — still raises, no I/O.
    transport = FakeTransport()
    emitter = RelayEmitter("http://relay:8788", api_key="alk_test", transport=transport)
    bad = seam_event(warrant={"justification": "", "rejected_alternatives": ["x"]})
    del bad["decision_id"]
    with pytest.raises(SeamSchemaError):
        emitter.emit(bad)
    assert transport.calls == []


def test_non_2xx_raises_relay_error() -> None:
    emitter = RelayEmitter(
        "http://relay:8788", api_key="alk_test", transport=FakeTransport(status=401, body={"error": "unauthorized"})
    )
    with pytest.raises(RelayError, match="401"):
        emitter.emit(seam_event())


def test_inference_log_requires_timestamp_and_posts() -> None:
    transport = FakeTransport()
    emitter = RelayEmitter("http://relay:8788", api_key="alk_test", transport=transport)
    with pytest.raises(ValueError, match="timestamp"):
        emitter.emit_inference_log({"call_id": "c1"})
    emitter.emit_inference_log({"timestamp": "2026-06-12T22:00:00.000Z", "call_id": "c1"})
    assert transport.calls[0][0].endswith("/v2/inference-logs")


def test_key_sources_are_exclusive() -> None:
    with pytest.raises(ValueError):
        RelayEmitter("http://x", api_key="a", api_key_file="b")
    with pytest.raises(ValueError):
        RelayEmitter("http://x")
