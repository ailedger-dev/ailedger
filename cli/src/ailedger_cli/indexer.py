"""Read client for the evidence indexer (the new Hedera rails).

ADDITIVE — the legacy Supabase client (``api.py``) is unchanged and stays the
default for ``verify``/``export``. This client reads the indexer's derived,
public, metadata-only views (no privileged key, nothing to leak): the reads
cut-over target. The indexer is rebuildable from the public mirror, so trust
never rests here — verification stays the verifier CLI's job against the mirror.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

import httpx

DEFAULT_TIMEOUT = 30.0


class IndexerError(RuntimeError):
    """Raised when the indexer response is malformed."""


class IndexerClient:
    """Synchronous read client for the evidence indexer API."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._client = httpx.Client(
            timeout=timeout,
            transport=transport,
            headers={"Accept": "application/json"},
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> IndexerClient:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def _get(self, path: str) -> Any:
        res = self._client.get(f"{self._base}{path}")
        res.raise_for_status()
        return res.json()

    def tenant_events(self, tenant_ref: str, limit: int = 100) -> list[dict[str, Any]]:
        """A tenant's sealed decision events (most-recent-first, indexer order)."""
        body = self._get(f"/v1/tenants/{tenant_ref}/events?limit={int(limit)}")
        if not isinstance(body, dict) or not isinstance(body.get("events"), list):
            raise IndexerError("indexer /events did not return an {events: [...]} object")
        return list(body["events"])

    def event(self, event_id: str) -> dict[str, Any] | None:
        """One sealed event by id, or None if not (yet) sealed/indexed."""
        res = self._client.get(f"{self._base}/v1/events/{event_id}")
        if res.status_code == 404:
            return None
        res.raise_for_status()
        return res.json()

    def chain(self, tenant_ref: str) -> dict[str, Any]:
        """The tenant's chain status (records, head, continuity, duplicates)."""
        return self._get(f"/v1/tenants/{tenant_ref}/chain")

    def wait_for_sealed(
        self,
        event_id: str,
        *,
        timeout: float = 30.0,
        interval: float = 1.0,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], float] = time.monotonic,
    ) -> dict[str, Any] | None:
        """Poll /v1/events/:id until the event is sealed, or None on timeout.

        A not-yet-sealed event is an expected state, not an error — only HTTP
        errors raise. sleep/now are injectable for tests.
        """
        deadline = now() + timeout
        while True:
            event = self.event(event_id)
            if event is not None:
                return event
            if now() >= deadline:
                return None
            sleep(interval)
