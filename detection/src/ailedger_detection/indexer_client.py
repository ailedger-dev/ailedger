"""Indexer read client for the detection layer — stdlib-only (Apache-2.0).

ADDITIVE and dependency-free: the detection library ships no HTTP client, so
this uses ``urllib`` from the stdlib. It lets a detection pipeline ENUMERATE a
tenant's sealed events from the public evidence indexer and confirm sealing —
the reads cut-over for detection consumers that previously enumerated from
Supabase.

Scope note (important): the indexer serves DERIVED METADATA only — event_id,
decision_type, ts, seq, payload_hash, record_hash. The sensitive fields the
statistical primitives need (protected-class context, outcomes, flags) are NOT
here — they live committed on-chain and encrypted in the vault. So this client
is for enumeration + sealing confirmation; the primitives still run on the
decrypted payloads a consumer pulls from the vault, not on indexer rows.

The HTTP opener is injectable so this is unit-testable with no network.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

# An opener maps a URL to response body bytes, raising urllib.error.HTTPError on
# any non-2xx status (exactly like urllib.request.urlopen).
Opener = Callable[[str], bytes]


def _urllib_opener(timeout: float) -> Opener:
    def _open(url: str) -> bytes:
        with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310 (trusted base url)
            return resp.read()

    return _open


class IndexerError(RuntimeError):
    """Raised when the indexer response is malformed."""


class IndexerClient:
    """stdlib read client for the evidence indexer API."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 30.0,
        opener: Opener | None = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._open = opener or _urllib_opener(timeout)

    def _get_json(self, path: str) -> Any:
        return json.loads(self._open(f"{self._base}{path}").decode("utf-8"))

    def tenant_events(self, tenant_ref: str, limit: int = 1000) -> list[dict[str, Any]]:
        """A tenant's sealed decision events (metadata only — see module note)."""
        body = self._get_json(f"/v1/tenants/{tenant_ref}/events?limit={int(limit)}")
        events = body.get("events") if isinstance(body, dict) else None
        if not isinstance(events, list):
            raise IndexerError("indexer /events did not return an {events: [...]} object")
        return events

    def event(self, event_id: str) -> dict[str, Any] | None:
        """One sealed event by id, or None if not (yet) sealed/indexed."""
        try:
            return self._get_json(f"/v1/events/{event_id}")
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            raise

    def wait_for_sealed(
        self,
        event_id: str,
        *,
        timeout: float = 30.0,
        interval: float = 1.0,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], float] = time.monotonic,
    ) -> dict[str, Any] | None:
        """Poll until the event is sealed, or None on timeout (not an error)."""
        deadline = now() + timeout
        while True:
            event = self.event(event_id)
            if event is not None:
                return event
            if now() >= deadline:
                return None
            sleep(interval)
