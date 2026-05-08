"""Hash-chain verification logic.

Gated behind the ``AILEDGER_CHAIN_ENABLED`` environment variable. Once the
``chain_prev_hash`` column ships in ``ledger.inference_logs`` (v1.1), the env
var will be flipped on by default and this module becomes the authoritative
local verifier.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from typing import Any

CHAIN_FLAG_ENV = "AILEDGER_CHAIN_ENABLED"
CHAIN_STUB_MESSAGE = (
    "chain verification coming with v1.1 — no chain_prev_hash column yet. "
    f"Set {CHAIN_FLAG_ENV}=1 once your deployment ships it."
)


def chain_enabled(env: dict[str, str] | None = None) -> bool:
    """Return ``True`` when the chain feature flag is truthy."""
    env = env if env is not None else dict(os.environ)
    value = env.get(CHAIN_FLAG_ENV, "").strip().lower()
    return value in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Break:
    """A single chain discontinuity."""

    row_id: str
    index: int
    expected_prev: str
    actual_prev: str


@dataclass(frozen=True)
class VerifyReport:
    row_count: int
    chain_head: str | None
    breaks: tuple[Break, ...]

    @property
    def ok(self) -> bool:
        return not self.breaks

    def summary(self) -> str:
        if self.row_count == 0:
            return "no rows to verify"
        status = "OK" if self.ok else f"BROKEN ({len(self.breaks)} discontinuities)"
        head = self.chain_head[:16] + "…" if self.chain_head else "-"
        return f"{status} — {self.row_count} rows · head {head}"


# Fields hashed per row. Keep in sync with the DB trigger once it lands.
_HASH_FIELDS: tuple[str, ...] = (
    "id",
    "customer_id",
    "system_id",
    "provider",
    "model",
    "input_hash",
    "output_hash",
    "status_code",
    "latency_ms",
    "started_at",
    "completed_at",
    "prev_hash",
)


def row_content_hash(row: dict[str, Any]) -> str:
    """Compute the SHA-256 of a canonicalized row.

    The canonical form is ``field=value`` pairs joined by ``\\n``, in the
    fixed order above. Missing fields serialize as empty strings so the hash
    is stable even when PostgREST omits NULLs.
    """
    parts = [f"{field}={_coerce(row.get(field))}" for field in _HASH_FIELDS]
    body = "\n".join(parts).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def verify_chain(rows: list[dict[str, Any]]) -> VerifyReport:
    """Walk ``rows`` and return a :class:`VerifyReport`.

    ``rows`` must be ordered by ``created_at`` ascending. The first row must
    have ``prev_hash == ""`` (or missing, which we normalize to ``""``).
    """
    breaks: list[Break] = []
    expected_prev = ""
    chain_head: str | None = None
    for index, row in enumerate(rows):
        actual_prev = _coerce(row.get("prev_hash"))
        if actual_prev != expected_prev:
            breaks.append(
                Break(
                    row_id=str(row.get("id", f"<index {index}>")),
                    index=index,
                    expected_prev=expected_prev,
                    actual_prev=actual_prev,
                )
            )
        chain_head = row_content_hash(row)
        expected_prev = chain_head
    return VerifyReport(
        row_count=len(rows),
        chain_head=chain_head,
        breaks=tuple(breaks),
    )


def _coerce(value: Any) -> str:
    """Canonicalize a value for hashing. ``None`` → ``""``."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)
