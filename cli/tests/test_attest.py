"""Unit + integration tests for the attest subcommand."""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Mapping

import httpx
import pytest
from click.testing import CliRunner

from ailedger_cli.attest import (
    BITCOIN_TESTNET,
    MOCK,
    SERVICE_ROLE_ENV_VAR,
    AttestClient,
    AttestError,
    BackendDisabled,
    BackendUnavailable,
    BitcoinMainnetBackend,
    BitcoinTestnetBackend,
    MockBackend,
    compute,
    compute_root_hash,
    get_backend,
    publish,
    resolve_backend_name,
    verify,
)
from ailedger_cli.main import cli

# ─── Root-hash determinism ──────────────────────────────────────────────────


def test_root_hash_empty_map_is_empty_sha256():
    assert compute_root_hash({}) == hashlib.sha256(b"").hexdigest()


def test_root_hash_deterministic_order_independent():
    a = {"cust-a": "a" * 64, "cust-b": "b" * 64, "cust-c": "c" * 64}
    # Same data inserted in a different order → same hash.
    b = {"cust-c": "c" * 64, "cust-a": "a" * 64, "cust-b": "b" * 64}
    assert compute_root_hash(a) == compute_root_hash(b)


def test_root_hash_changes_when_any_head_changes():
    base = {"cust-a": "a" * 64, "cust-b": "b" * 64}
    tweaked = {"cust-a": "a" * 64, "cust-b": ("b" * 63) + "c"}
    assert compute_root_hash(base) != compute_root_hash(tweaked)


def test_root_hash_changes_when_customer_id_changes():
    base = {"cust-a": "a" * 64}
    renamed = {"cust-z": "a" * 64}
    assert compute_root_hash(base) != compute_root_hash(renamed)


def test_root_hash_known_fixture():
    """Lock in the canonical serialization so regulators can re-derive offline."""
    heads = {"cust-a": "a" * 64, "cust-b": "b" * 64}
    body = f"cust-a|{'a' * 64}\ncust-b|{'b' * 64}".encode()
    assert compute_root_hash(heads) == hashlib.sha256(body).hexdigest()


# ─── Backend resolution + enforcement ───────────────────────────────────────


def test_resolve_backend_defaults_to_mock(monkeypatch):
    monkeypatch.delenv("AILEDGER_ANCHOR_BACKEND", raising=False)
    assert resolve_backend_name() == MOCK


def test_resolve_backend_from_env(monkeypatch):
    monkeypatch.setenv("AILEDGER_ANCHOR_BACKEND", "bitcoin-testnet")
    assert resolve_backend_name() == BITCOIN_TESTNET


def test_get_backend_unknown_name_raises():
    with pytest.raises(AttestError, match="unknown anchor backend"):
        get_backend("dogecoin")


def test_mock_backend_publish_returns_sha256():
    backend = MockBackend()
    result = backend.publish("a" * 64)
    assert len(result.tx_id) == 64
    assert int(result.tx_id, 16) >= 0  # valid hex
    assert result.network == MOCK


def test_mock_backend_verify_round_trip():
    backend = MockBackend()
    root = "a" * 64
    pub = backend.publish(root)
    assert backend.verify(pub.tx_id, root) is True


def test_mock_backend_verify_rejects_non_hex():
    backend = MockBackend()
    assert backend.verify("not-hex", "a" * 64) is False


def test_bitcoin_testnet_publish_is_stub():
    with pytest.raises(BackendUnavailable):
        BitcoinTestnetBackend().publish("a" * 64)


def test_bitcoin_testnet_verify_is_stub():
    with pytest.raises(BackendUnavailable):
        BitcoinTestnetBackend().verify("abc", "a" * 64)


def test_bitcoin_mainnet_publish_is_disabled():
    # Money-spender. Never run without Jake signoff.
    with pytest.raises(BackendDisabled):
        BitcoinMainnetBackend().publish("a" * 64)


def test_bitcoin_mainnet_verify_is_disabled():
    with pytest.raises(BackendDisabled):
        BitcoinMainnetBackend().verify("abc", "a" * 64)


# ─── AttestClient (with a mocked httpx transport) ───────────────────────────


class FakeSupabase:
    """In-memory stand-in for the PostgREST endpoints the CLI hits."""

    def __init__(self, chain_heads: Mapping[str, str]):
        self.chain_heads = dict(chain_heads)
        self.rows: list[dict] = []

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/rest/v1/rpc/all_chain_heads") and request.method == "POST":
            return httpx.Response(200, json=self.chain_heads)

        if path.endswith("/rest/v1/attestations"):
            if request.method == "POST":
                body = json.loads(request.content.decode("utf-8"))
                row = {
                    "id": str(uuid.uuid4()),
                    "root_hash": body["root_hash"],
                    "chain_head_map": body["chain_head_map"],
                    "anchor_network": body["anchor_network"],
                    "anchor_tx_id": body.get("anchor_tx_id"),
                    "customer_count": body["customer_count"],
                    "anchored_at": "2026-04-21T12:00:00.000000+00:00",
                    "created_at": "2026-04-21T12:00:00.000000+00:00",
                }
                self.rows.append(row)
                return httpx.Response(201, json=[row])
            if request.method == "GET":
                qs = dict(request.url.params.multi_items())
                rows = self.rows
                tx_filter = qs.get("anchor_tx_id")
                if tx_filter:
                    _, _, wanted = tx_filter.partition(".")
                    rows = [r for r in rows if r.get("anchor_tx_id") == wanted]
                net_filter = qs.get("anchor_network")
                if net_filter:
                    _, _, wanted = net_filter.partition(".")
                    rows = [r for r in rows if r.get("anchor_network") == wanted]
                order = qs.get("order")
                if order and order.startswith("anchored_at"):
                    reverse = order.endswith("desc")
                    rows = sorted(rows, key=lambda r: r["anchored_at"], reverse=reverse)
                limit = int(qs.get("limit", len(rows)))
                return httpx.Response(200, json=rows[:limit])

        return httpx.Response(404, json={"error": f"unexpected {request.method} {path}"})


@pytest.fixture
def fake_supabase():
    return FakeSupabase(
        chain_heads={
            "cust-a": "a" * 64,
            "cust-b": "b" * 64,
            "cust-c": "c" * 64,
        }
    )


@pytest.fixture
def attest_client(fake_supabase) -> AttestClient:
    return AttestClient(
        "https://x.supabase.co",
        "srv-role-key",
        transport=fake_supabase.transport(),
    )


def test_compute_end_to_end(attest_client, fake_supabase):
    with attest_client:
        result = compute(attest_client)
    assert result.customer_count == 3
    assert result.root_hash == compute_root_hash(fake_supabase.chain_heads)


def test_publish_persists_row(attest_client, fake_supabase):
    with attest_client:
        attestation = publish(attest_client, backend=MockBackend())
    assert attestation.anchor_network == MOCK
    assert attestation.customer_count == 3
    assert attestation.anchor_tx_id and len(attestation.anchor_tx_id) == 64
    # Row round-trips through the fake Supabase.
    assert len(fake_supabase.rows) == 1


def test_publish_then_verify_round_trips(attest_client, fake_supabase):
    with attest_client:
        attestation = publish(attest_client, backend=MockBackend())
        result = verify(attest_client, attestation.anchor_tx_id)
    assert result.ok, result.reason
    assert result.attestation is not None
    assert result.attestation.root_hash == attestation.root_hash


def test_verify_detects_tampered_root_hash(attest_client, fake_supabase):
    with attest_client:
        attestation = publish(attest_client, backend=MockBackend())
        # Tamper: rewrite the stored row's root_hash so it disagrees with the map.
        fake_supabase.rows[0]["root_hash"] = "0" * 64
        result = verify(attest_client, attestation.anchor_tx_id)
    assert not result.ok
    assert "disagrees with recompute" in result.reason


def test_verify_missing_tx_returns_failure(attest_client):
    with attest_client:
        result = verify(attest_client, "deadbeef" * 8)
    assert not result.ok
    assert "no attestation row found" in result.reason


def test_list_attestations_orders_descending(attest_client, fake_supabase):
    with attest_client:
        publish(attest_client, backend=MockBackend())
        # Tweak timestamps to make ordering observable.
        fake_supabase.rows.append(
            {
                **fake_supabase.rows[0],
                "id": str(uuid.uuid4()),
                "anchored_at": "2026-05-21T12:00:00.000000+00:00",
                "anchor_tx_id": "newer",
            }
        )
        rows = attest_client.list_attestations(limit=5)
    assert rows[0].anchor_tx_id == "newer"


# ─── CLI surface ────────────────────────────────────────────────────────────


def test_attest_help_lists_subcommands():
    result = CliRunner().invoke(cli, ["attest", "--help"])
    assert result.exit_code == 0
    for word in ("compute", "publish", "verify", "list"):
        assert word in result.output


def test_attest_compute_requires_service_role_key(tmp_config, monkeypatch):
    monkeypatch.delenv(SERVICE_ROLE_ENV_VAR, raising=False)
    CliRunner().invoke(cli, ["config", "--set", "base-url=https://x.supabase.co"])
    result = CliRunner().invoke(cli, ["attest", "compute"])
    assert result.exit_code != 0
    assert SERVICE_ROLE_ENV_VAR in result.output


def test_attest_compute_requires_base_url(tmp_config, monkeypatch):
    monkeypatch.setenv(SERVICE_ROLE_ENV_VAR, "srv-role-key")
    result = CliRunner().invoke(cli, ["attest", "compute"])
    assert result.exit_code != 0
    assert "base-url not configured" in result.output


def test_attest_compute_via_cli(tmp_config, monkeypatch, fake_supabase):
    monkeypatch.setenv(SERVICE_ROLE_ENV_VAR, "srv-role-key")
    CliRunner().invoke(cli, ["config", "--set", "base-url=https://x.supabase.co"])

    transport = fake_supabase.transport()

    def _client_factory(base_url, key, **kwargs):
        return AttestClient(base_url, key, transport=transport)

    monkeypatch.setattr("ailedger_cli.main.AttestClient", _client_factory)

    result = CliRunner().invoke(cli, ["attest", "compute"])
    assert result.exit_code == 0, result.output
    assert "customer_count 3" in result.output
    expected = compute_root_hash(fake_supabase.chain_heads)
    assert expected in result.output


def test_attest_publish_via_cli(tmp_config, monkeypatch, fake_supabase):
    monkeypatch.setenv(SERVICE_ROLE_ENV_VAR, "srv-role-key")
    monkeypatch.setenv("AILEDGER_ANCHOR_BACKEND", "mock")
    CliRunner().invoke(cli, ["config", "--set", "base-url=https://x.supabase.co"])

    transport = fake_supabase.transport()

    def _client_factory(base_url, key, **kwargs):
        return AttestClient(base_url, key, transport=transport)

    monkeypatch.setattr("ailedger_cli.main.AttestClient", _client_factory)
    result = CliRunner().invoke(cli, ["attest", "publish"])
    assert result.exit_code == 0, result.output
    assert "network        mock" in result.output
    assert "customer_count 3" in result.output


def test_attest_publish_refuses_mainnet(tmp_config, monkeypatch, fake_supabase):
    monkeypatch.setenv(SERVICE_ROLE_ENV_VAR, "srv-role-key")
    CliRunner().invoke(cli, ["config", "--set", "base-url=https://x.supabase.co"])

    transport = fake_supabase.transport()

    def _client_factory(base_url, key, **kwargs):
        return AttestClient(base_url, key, transport=transport)

    monkeypatch.setattr("ailedger_cli.main.AttestClient", _client_factory)
    result = CliRunner().invoke(cli, ["attest", "publish", "--backend", "bitcoin"])
    assert result.exit_code != 0
    assert "disabled" in result.output.lower()
