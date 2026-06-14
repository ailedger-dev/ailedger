"""Relay emitter — POST validated decision events and inference logs to an
AILedger evidence relay (the self-host Node relay or the hosted endpoint).

stdlib-only (urllib); the HTTP transport is injectable for tests and for
callers who prefer their own client. Validation runs BEFORE any network I/O:
an incomplete record is refused locally and never leaves the process.

    from ailedger_detection.emitter import RelayEmitter
    emitter = RelayEmitter("http://localhost:8788", api_key_file="~/.secrets/ailedger-node/apikey-jv-fleet.txt")
    emitter.emit({...seam decision event...})
"""

from __future__ import annotations

import json
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ailedger_detection.decision_event import to_ingest_body, validate_decision_event
from ailedger_detection.unwarrant import classify_unwarrant, to_unwarrant_ingest_body

__all__ = ["RelayEmitter", "RelayError"]

#: transport(url, headers, body) -> (status, response_bytes)
Transport = Callable[[str, dict[str, str], bytes], tuple[int, bytes]]


class RelayError(RuntimeError):
    """Non-2xx response from the relay."""


def _urllib_transport(url: str, headers: dict[str, str], body: bytes) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as err:  # non-2xx still carries a body
        return err.code, err.read()


class RelayEmitter:
    def __init__(
        self,
        relay_url: str,
        *,
        api_key: str | None = None,
        api_key_file: str | None = None,
        transport: Transport | None = None,
    ) -> None:
        if (api_key is None) == (api_key_file is None):
            raise ValueError("provide exactly one of api_key / api_key_file")
        if api_key_file is not None:
            api_key = Path(api_key_file).expanduser().read_text(encoding="utf-8").strip()
        assert api_key is not None
        self._url = relay_url.rstrip("/")
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        self._transport: Transport = transport or _urllib_transport

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        status, raw = self._transport(
            f"{self._url}{path}", dict(self._headers), json.dumps(body).encode("utf-8")
        )
        if status < 200 or status >= 300:
            raise RelayError(f"{path} -> {status}: {raw.decode('utf-8', 'replace')[:200]}")
        return json.loads(raw) if raw else {}

    def emit(self, seam_event: dict[str, Any]) -> dict[str, Any]:
        """Submit a seam decision event, recording its warrant verdict (OWT).

        Three outcomes:
          * **warranted** → POST /v2/detection-events (sealed as ode-2).
          * **unwarranted** (missing/empty/weak warrant) → POST
            /v2/unwarranted-events (sealed as ode-2u — the refusal becomes a
            gap-honest, counted record instead of a silent drop).
          * **malformed** (no decision_id/decision/ts) → SeamSchemaError,
            pre-network: a non-decision is not recordable.

        This replaces the old raise-and-drop behavior: an unwarranted decision
        is no longer discarded, it is recorded as unwarranted.
        """
        category = classify_unwarrant(seam_event)
        if category is not None:
            return self._post(
                "/v2/unwarranted-events", to_unwarrant_ingest_body(seam_event, category)
            )
        record = validate_decision_event(seam_event)
        return self._post("/v2/detection-events", to_ingest_body(record))

    def emit_inference_log(self, log: dict[str, Any]) -> dict[str, Any]:
        """Submit one inference-log record (must carry an ISO `timestamp`)."""
        if "timestamp" not in log:
            raise ValueError("inference log requires a timestamp")
        return self._post("/v2/inference-logs", log)
