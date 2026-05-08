"""Tests for the Supabase REST client using httpx MockTransport."""

from __future__ import annotations

import datetime as dt
from urllib.parse import parse_qs

import httpx

from ailedger_cli.api import PAGE_SIZE, FetchOptions, LedgerClient


def _mock(handler):
    return httpx.MockTransport(handler)


def test_fetch_rows_sends_auth_headers_and_filters():
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("Authorization")
        captured["apikey"] = request.headers.get("apikey")
        return httpx.Response(200, json=[])

    with LedgerClient(
        "https://x.supabase.co/",
        "ail_sk_test",
        transport=_mock(handler),
    ) as client:
        rows = client.fetch_rows(
            FetchOptions(customer_id="cust-1", since=dt.date(2026, 1, 1))
        )

    assert rows == []
    assert captured["auth"] == "Bearer ail_sk_test"
    assert captured["apikey"] == "ail_sk_test"

    url = str(captured["url"])
    assert "rest/v1/inference_logs" in url
    qs = parse_qs(url.split("?", 1)[1])
    assert qs["customer_id"] == ["eq.cust-1"]
    assert qs["created_at"] == ["gte.2026-01-01"]
    assert qs["order"] == ["created_at.asc"]


def test_fetch_rows_paginates():
    first_page = [{"id": f"r{i}"} for i in range(PAGE_SIZE)]
    second_page = [{"id": "r-last"}]
    pages = [first_page, second_page]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=pages.pop(0))

    with LedgerClient(
        "https://x.supabase.co",
        "ail_sk_test",
        transport=_mock(handler),
    ) as client:
        rows = client.fetch_rows(FetchOptions())

    assert len(rows) == PAGE_SIZE + 1
    assert rows[-1]["id"] == "r-last"


def test_fetch_rows_combines_since_and_until():
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json=[])

    with LedgerClient(
        "https://x.supabase.co",
        "ail_sk_test",
        transport=_mock(handler),
    ) as client:
        client.fetch_rows(
            FetchOptions(
                since=dt.date(2026, 1, 1),
                until=dt.date(2026, 3, 31),
            )
        )

    url = seen[0]
    # both gte and lte filters on created_at must be present
    assert "created_at=gte.2026-01-01" in url
    assert "created_at=lte.2026-03-31" in url


def test_fetch_rows_raises_on_http_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    with LedgerClient(
        "https://x.supabase.co",
        "ail_sk_test",
        transport=_mock(handler),
    ) as client:
        try:
            client.fetch_rows(FetchOptions())
        except httpx.HTTPStatusError as exc:
            assert exc.response.status_code == 500
        else:  # pragma: no cover
            raise AssertionError("expected HTTPStatusError")
