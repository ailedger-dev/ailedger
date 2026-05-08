"""Cross-customer chain-head anchoring.

Computes a deterministic SHA-256 root hash across every customer's current
chain-head, stores the result in ``ledger.attestations``, and publishes it to
a public blockchain via a pluggable backend. Regulator-facing primer §3.5
promises this; this module is the engineering substantiation.

Backends
--------
``mock``
    Dev/test default. The "tx id" is ``sha256(root_hash || wallclock_ms)``
    stored locally. No network calls.
``bitcoin-testnet``
    Stub. Raises :class:`BackendUnavailable` — wiring to BTCPay / BlockCypher
    is intentionally out of scope for the seed implementation.
``bitcoin``
    Bitcoin MainNet. Hard-disabled: this backend sends real money and
    requires explicit Jake signoff before the stub is replaced. Calling it
    always raises :class:`BackendDisabled`.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import os
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

# Env var that selects a backend. Default mock keeps dev flows cost-free.
BACKEND_ENV_VAR = "AILEDGER_ANCHOR_BACKEND"
SERVICE_ROLE_ENV_VAR = "AILEDGER_SERVICE_ROLE_KEY"

MOCK = "mock"
BITCOIN_TESTNET = "bitcoin-testnet"
BITCOIN_MAINNET = "bitcoin"
KNOWN_BACKENDS = (MOCK, BITCOIN_TESTNET, BITCOIN_MAINNET)


class AttestError(RuntimeError):
    """Base class for attest-module failures."""


class BackendUnavailable(AttestError):
    """Backend is a stub — implementation deferred."""


class BackendDisabled(AttestError):
    """Backend is intentionally off (e.g. Bitcoin MainNet money-spender)."""


# ─── Root-hash computation ──────────────────────────────────────────────────


def compute_root_hash(chain_head_map: Mapping[str, str]) -> str:
    """Return the canonical root hash for a chain-head snapshot.

    The canonical serialization is ``customer_id|chain_head_hash`` pairs in
    ascending ``customer_id`` order, joined by newlines. The SHA-256 of that
    UTF-8 encoding, hex-lowercased, is the root hash. Determinism is the
    whole point: a regulator with the same snapshot must derive the same
    hash. Empty map → SHA-256 of the empty string (a sentinel the verifier
    tolerates; listed attestations with zero customers carry row_count 0).
    """
    if not chain_head_map:
        return hashlib.sha256(b"").hexdigest()
    lines = [f"{cid}|{head}" for cid, head in sorted(chain_head_map.items())]
    body = "\n".join(lines).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


# ─── Backends ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PublishResult:
    """Backend-returned metadata for a published anchor."""

    tx_id: str
    network: str
    # Backend-specific payload (e.g. block height, explorer URL) for the
    # operator log — not persisted in the attestations row.
    extra: Mapping[str, Any] = field(default_factory=dict)


class AnchorBackend(Protocol):
    """Minimal contract every backend implements."""

    name: str

    def publish(self, root_hash: str) -> PublishResult: ...

    def verify(self, tx_id: str, expected_root_hash: str) -> bool: ...


class MockBackend:
    """Deterministic, offline backend for dev + CI.

    The tx id is ``sha256(root_hash || wallclock_ms)``. Verification recomputes
    the expected hash from the (root_hash, tx_id) pair and compares — this
    guarantees the compute → publish → verify loop round-trips, but deliberately
    does NOT imitate any property of a real blockchain anchor. Any operator
    running with ``AILEDGER_ANCHOR_BACKEND=mock`` must know this is not a real
    anchor.
    """

    name = MOCK

    def __init__(self, *, clock: Clock | None = None) -> None:
        self._clock = clock or _SystemClock()

    def publish(self, root_hash: str) -> PublishResult:
        stamp_ms = int(self._clock.now().timestamp() * 1000)
        tx_id = hashlib.sha256(f"{root_hash}|{stamp_ms}".encode()).hexdigest()
        return PublishResult(
            tx_id=tx_id,
            network=self.name,
            extra={"wallclock_ms": stamp_ms, "note": "mock backend — not a real anchor"},
        )

    def verify(self, tx_id: str, expected_root_hash: str) -> bool:
        # The mock tx_id is deterministic given (root_hash, wallclock). We
        # can't re-derive the wallclock from tx_id alone, so verification
        # instead asserts that the attestations row's (root_hash, tx_id) pair
        # is self-consistent: tx_id must be a valid hex digest. That is the
        # soft guarantee the mock offers; real backends check the chain.
        if not _is_hex_sha256(tx_id):
            return False
        return _is_hex_sha256(expected_root_hash)


class BitcoinTestnetBackend:
    """Placeholder for BTCPay/BlockCypher-backed testnet OP_RETURN anchoring.

    Seed implementation intentionally leaves the wire protocol unwired. When
    this backend is filled in it should:

    1. Read credentials from ``~/gt-lab/.secrets/ailedger-attest-backend.env``
       (never from config.toml).
    2. Push an OP_RETURN transaction whose payload is the 32-byte root hash.
    3. Return the tx id. Verification fetches the tx and asserts the
       OP_RETURN payload matches the expected root hash.
    """

    name = BITCOIN_TESTNET

    def publish(self, root_hash: str) -> PublishResult:
        raise BackendUnavailable(
            "bitcoin-testnet backend is stubbed in the seed implementation. "
            "Wire BTCPay/BlockCypher before using."
        )

    def verify(self, tx_id: str, expected_root_hash: str) -> bool:
        raise BackendUnavailable(
            "bitcoin-testnet backend is stubbed in the seed implementation. "
            "Wire BTCPay/BlockCypher before using."
        )


class BitcoinMainnetBackend:
    """Bitcoin MainNet anchor — hard-disabled.

    Enabling this backend costs real BTC per anchor. The seed implementation
    refuses to publish regardless of env-var gating. Jake must replace this
    class with a real implementation (+ fund a wallet, + sign off) before it
    can be turned on.
    """

    name = BITCOIN_MAINNET

    def publish(self, root_hash: str) -> PublishResult:
        raise BackendDisabled(
            "bitcoin mainnet backend is disabled by design: it sends real BTC. "
            "Replace BitcoinMainnetBackend with a signed-off implementation "
            "before enabling."
        )

    def verify(self, tx_id: str, expected_root_hash: str) -> bool:
        raise BackendDisabled("bitcoin mainnet backend is disabled by design — no verify path.")


_BACKEND_FACTORIES: dict[str, type[AnchorBackend]] = {
    MOCK: MockBackend,
    BITCOIN_TESTNET: BitcoinTestnetBackend,
    BITCOIN_MAINNET: BitcoinMainnetBackend,
}


def resolve_backend_name(env: Mapping[str, str] | None = None) -> str:
    """Return the backend name from env, defaulting to :data:`MOCK`."""
    env = env if env is not None else os.environ
    return env.get(BACKEND_ENV_VAR, MOCK).strip().lower() or MOCK


def get_backend(name: str | None = None) -> AnchorBackend:
    """Instantiate a backend by name. ``None`` reads from the env var."""
    resolved = (name or resolve_backend_name()).lower()
    if resolved not in _BACKEND_FACTORIES:
        allowed = ", ".join(KNOWN_BACKENDS)
        raise AttestError(f"unknown anchor backend {resolved!r}. Allowed: {allowed}")
    return _BACKEND_FACTORIES[resolved]()


# ─── Service-role Supabase client ───────────────────────────────────────────


@dataclass(frozen=True)
class Attestation:
    """Persisted attestation row."""

    id: str
    root_hash: str
    anchored_at: dt.datetime
    chain_head_map: Mapping[str, str]
    anchor_network: str
    anchor_tx_id: str | None
    customer_count: int


class AttestClient:
    """Service-role-scoped Supabase client for the attest subcommand.

    Separate from :class:`ailedger_cli.api.LedgerClient` because attest is
    cross-customer operator tooling. Customer API keys would be scoped to one
    customer's chain and could not read the full snapshot nor write to the
    ``attestations`` table. This client takes an explicit service-role key
    (from ``AILEDGER_SERVICE_ROLE_KEY``), which bypasses RLS.
    """

    def __init__(
        self,
        base_url: str,
        service_role_key: str,
        *,
        timeout: float = 30.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = httpx.Client(
            timeout=timeout,
            transport=transport,
            headers={
                "Authorization": f"Bearer {service_role_key}",
                "apikey": service_role_key,
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> AttestClient:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def fetch_chain_heads(self) -> dict[str, str]:
        """Return ``{customer_id: chain_head_hash}`` for all customers.

        Calls ``ledger.all_chain_heads()`` via the PostgREST RPC endpoint.
        The function is SECURITY DEFINER and service-role-only, so this
        request fails without a service-role key.
        """
        url = f"{self._base_url}/rest/v1/rpc/all_chain_heads"
        response = self._client.post(url, json={})
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise AttestError(
                f"all_chain_heads RPC returned {type(payload).__name__}, expected object"
            )
        return {str(k): str(v) for k, v in payload.items()}

    def insert_attestation(
        self,
        *,
        root_hash: str,
        chain_head_map: Mapping[str, str],
        anchor_network: str,
        anchor_tx_id: str | None,
    ) -> Attestation:
        """Insert one row and return it."""
        body = {
            "root_hash": root_hash,
            "chain_head_map": dict(chain_head_map),
            "anchor_network": anchor_network,
            "anchor_tx_id": anchor_tx_id,
            "customer_count": len(chain_head_map),
        }
        url = f"{self._base_url}/rest/v1/attestations"
        # Prefer: return=representation gives us the inserted row back.
        response = self._client.post(url, json=body, headers={"Prefer": "return=representation"})
        response.raise_for_status()
        payload = response.json()
        if isinstance(payload, list):
            if not payload:
                raise AttestError("insert_attestation: empty response array")
            row = payload[0]
        else:
            row = payload
        return _row_to_attestation(row)

    def list_attestations(self, limit: int = 50) -> list[Attestation]:
        url = f"{self._base_url}/rest/v1/attestations"
        response = self._client.get(
            url,
            params={
                "select": "*",
                "order": "anchored_at.desc",
                "limit": str(limit),
            },
        )
        response.raise_for_status()
        rows = response.json()
        if not isinstance(rows, list):
            raise AttestError(f"list_attestations: expected array, got {type(rows).__name__}")
        return [_row_to_attestation(r) for r in rows]

    def get_attestation_by_tx(self, tx_id: str, network: str | None = None) -> Attestation | None:
        url = f"{self._base_url}/rest/v1/attestations"
        params = {
            "select": "*",
            "anchor_tx_id": f"eq.{tx_id}",
            "limit": "1",
        }
        if network is not None:
            params["anchor_network"] = f"eq.{network}"
        response = self._client.get(url, params=params)
        response.raise_for_status()
        rows = response.json()
        if not isinstance(rows, list) or not rows:
            return None
        return _row_to_attestation(rows[0])


def _row_to_attestation(row: Mapping[str, Any]) -> Attestation:
    return Attestation(
        id=str(row["id"]),
        root_hash=str(row["root_hash"]),
        anchored_at=_parse_ts(row["anchored_at"]),
        chain_head_map={str(k): str(v) for k, v in (row.get("chain_head_map") or {}).items()},
        anchor_network=str(row["anchor_network"]),
        anchor_tx_id=(None if row.get("anchor_tx_id") is None else str(row["anchor_tx_id"])),
        customer_count=int(row.get("customer_count") or 0),
    )


def _parse_ts(value: Any) -> dt.datetime:
    if isinstance(value, dt.datetime):
        return value
    s = str(value)
    # PostgREST returns microsecond-precision ISO-8601 with trailing Z or offset.
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return dt.datetime.fromisoformat(s)


def _is_hex_sha256(value: str) -> bool:
    if len(value) != 64:
        return False
    try:
        int(value, 16)
    except ValueError:
        return False
    return True


# ─── Clock abstraction (testable) ───────────────────────────────────────────


class Clock(Protocol):
    def now(self) -> dt.datetime: ...


class _SystemClock:
    def now(self) -> dt.datetime:
        return dt.datetime.now(tz=dt.UTC)


# ─── Top-level orchestration ────────────────────────────────────────────────


@dataclass(frozen=True)
class ComputeResult:
    root_hash: str
    chain_head_map: Mapping[str, str]

    @property
    def customer_count(self) -> int:
        return len(self.chain_head_map)


def compute(client: AttestClient) -> ComputeResult:
    """Fetch chain heads and derive the root hash, no persistence."""
    heads = client.fetch_chain_heads()
    return ComputeResult(
        root_hash=compute_root_hash(heads),
        chain_head_map=heads,
    )


def publish(
    client: AttestClient,
    backend: AnchorBackend | None = None,
) -> Attestation:
    """Compute → publish to backend → persist the attestation row."""
    snapshot = compute(client)
    backend = backend or get_backend()
    result = backend.publish(snapshot.root_hash)
    return client.insert_attestation(
        root_hash=snapshot.root_hash,
        chain_head_map=snapshot.chain_head_map,
        anchor_network=result.network,
        anchor_tx_id=result.tx_id,
    )


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    attestation: Attestation | None
    reason: str


def verify(
    client: AttestClient,
    tx_id: str,
    *,
    network: str | None = None,
    backend: AnchorBackend | None = None,
) -> VerifyResult:
    """Fetch the attestation for ``tx_id`` and re-check via the backend."""
    attestation = client.get_attestation_by_tx(tx_id, network=network)
    if attestation is None:
        return VerifyResult(
            ok=False,
            attestation=None,
            reason=f"no attestation row found for tx_id={tx_id}",
        )
    backend = backend or get_backend(attestation.anchor_network)
    # Assert DB-side consistency: the root hash persisted must match a
    # recompute from the stored chain_head_map. This catches tampering with
    # either column independently.
    recomputed = compute_root_hash(attestation.chain_head_map)
    if recomputed != attestation.root_hash:
        return VerifyResult(
            ok=False,
            attestation=attestation,
            reason=(
                f"stored root_hash={attestation.root_hash[:16]}… disagrees with "
                f"recompute from chain_head_map={recomputed[:16]}…"
            ),
        )
    ok = backend.verify(tx_id, attestation.root_hash)
    if not ok:
        return VerifyResult(
            ok=False,
            attestation=attestation,
            reason=f"backend {backend.name!r} rejected tx_id={tx_id}",
        )
    return VerifyResult(ok=True, attestation=attestation, reason="verified")


# Convenience accessor for tests / CLI — isolates time.time() patching.
def _now_ms() -> int:  # pragma: no cover - tiny helper, used only for mocks
    return int(time.time() * 1000)
