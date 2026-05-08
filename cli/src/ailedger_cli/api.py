"""Thin Supabase REST client used by verify/export.

The proxy writes rows into ``ledger.inference_logs``. Supabase exposes that
schema over PostgREST at ``<base>/rest/v1/inference_logs`` once the schema is
exposed, or ``<base>/rest/v1/ledger.inference_logs`` otherwise. We keep the
table name configurable so either layout works.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Any

import httpx

DEFAULT_TABLE = "inference_logs"
DEFAULT_TIMEOUT = 30.0
PAGE_SIZE = 1000


@dataclass(frozen=True)
class FetchOptions:
    """Filters for :func:`fetch_rows`."""

    customer_id: str | None = None
    since: dt.date | dt.datetime | None = None
    until: dt.date | dt.datetime | None = None
    table: str = DEFAULT_TABLE


class LedgerClient:
    """Synchronous Supabase REST client.

    Parameters
    ----------
    base_url:
        Supabase project URL, e.g. ``https://xyz.supabase.co``. Trailing slash
        optional.
    api_key:
        Customer AILedger key. Sent as ``Authorization`` + ``apikey`` headers
        so RLS scopes the response to the caller's rows.
    timeout:
        Request timeout in seconds.
    transport:
        Optional ``httpx`` transport override (used by tests).
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._client = httpx.Client(
            timeout=timeout,
            transport=transport,
            headers={
                "Authorization": f"Bearer {api_key}",
                "apikey": api_key,
                "Accept": "application/json",
            },
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> LedgerClient:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def fetch_rows(self, options: FetchOptions) -> list[dict[str, Any]]:
        """Return all rows matching ``options``, paginated.

        Rows are returned in ascending ``created_at`` order so callers can
        feed them straight into hash-chain replay.
        """
        url = f"{self._base_url}/rest/v1/{options.table}"
        params: dict[str, str] = {
            "select": "*",
            "order": "created_at.asc",
        }
        if options.customer_id:
            params["customer_id"] = f"eq.{options.customer_id}"
        if options.since is not None:
            params["created_at"] = f"gte.{_iso(options.since)}"
        if options.until is not None:
            # PostgREST allows multiple filters on the same column via repeated params.
            # httpx doesn't natively merge; we use a list here.
            existing = params.pop("created_at", None)
            multi = []
            if existing:
                multi.append(("created_at", existing))
            multi.append(("created_at", f"lte.{_iso(options.until)}"))
            return self._paginate(url, params, extra=multi)
        return self._paginate(url, params)

    def _paginate(
        self,
        url: str,
        params: dict[str, str],
        *,
        extra: list[tuple[str, str]] | None = None,
    ) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        offset = 0
        while True:
            query: list[tuple[str, str]] = list(params.items())
            if extra:
                query.extend(extra)
            query.append(("limit", str(PAGE_SIZE)))
            query.append(("offset", str(offset)))
            response = self._client.get(url, params=query)
            response.raise_for_status()
            page = response.json()
            if not isinstance(page, list):
                raise LedgerApiError(
                    f"expected JSON array from {url}, got {type(page).__name__}"
                )
            results.extend(page)
            if len(page) < PAGE_SIZE:
                break
            offset += PAGE_SIZE
        return results


class LedgerApiError(RuntimeError):
    """Raised when the PostgREST response is malformed."""


def _iso(value: dt.date | dt.datetime) -> str:
    if isinstance(value, dt.datetime):
        # Supabase stores UTC; normalize naive datetimes to UTC.
        if value.tzinfo is None:
            value = value.replace(tzinfo=dt.UTC)
        return value.isoformat()
    return value.isoformat()
