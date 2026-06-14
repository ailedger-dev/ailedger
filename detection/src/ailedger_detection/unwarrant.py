"""Unwarrant classification — the gap-honest verdict on a decision's warrant.

Today the warrant gate REFUSES a decision lacking a sound warrant and the
caller drops it: an unwarranted decision leaves no trace, so an operator
whose agents constantly act without warrants looks identical to one whose
agents barely act. Open Warrant Transparency (OWT) turns that silent drop
into a recorded, counted, tamper-evident signal. This module is the
classifier at the heart of it — the open-standard reference implementation
of "is this decision warranted, and if not, why not."

A decision event has three possible verdicts:

* **Malformed** — no decision_id / decision / ts. Not a decision at all;
  there is nothing to record. The caller raises (SeamSchemaError).
* **Unwarranted** — structurally a decision, but its warrant is missing,
  empty, or weak. Recorded gap-honestly as an ``ode-2u`` record (the
  refusal becomes a first-class, countable fact on the tenant's chain).
* **Warranted** — a sound warrant. Recorded normally as ``ode-2``.

Synchronous categories (classified at the gate, here):
  1. ``missing-justification`` — no non-empty ``warrant.justification``.
  2. ``empty-alternatives``    — no ``warrant.rejected_alternatives`` (and no
     ``no-looser-alternative-at-standard`` sentinel).
  3. ``weak-warrant``          — a sound-shaped warrant whose declared
     ``warrant.confidence`` is below the runtime-injection threshold.

The asynchronous category — ``unresolved-obligation`` (a required action from
a prior flagged decision never taken in-window) — is computed over the sealed
stream, not at the gate; see ``unresolved_flags`` (OWT Phase D).

Threshold convention mirrors the detection primitives: ships with a default,
customers TIGHTEN (raise toward 1.0), never loosen.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from ailedger_detection.decision_event import (
    NO_LOOSER_ALTERNATIVE,
    SeamSchemaError,
    _EVENT_NS,
)

__all__ = [
    "WEAK_WARRANT_THRESHOLD",
    "UnwarrantCategory",
    "classify_unwarrant",
    "to_unwarrant_ingest_body",
]

#: Runtime-injection confidence floor. A warrant whose declared confidence is
#: below this is too thin to inject back into agents — a weak warrant.
#: Customers tighten (raise toward 1.0), never loosen. (confidence.py is a
#: stub today, so this is the canonical constant, not a reuse.)
WEAK_WARRANT_THRESHOLD: float = 0.5


class UnwarrantCategory(str, Enum):
    """Why a decision was unwarranted. Values are the frozen wire strings."""

    MISSING_JUSTIFICATION = "missing-justification"
    EMPTY_ALTERNATIVES = "empty-alternatives"
    WEAK_WARRANT = "weak-warrant"
    #: Asynchronous (OWT cat-4) — not returned by classify_unwarrant (which is
    #: synchronous); produced by the unresolved-obligation detector over the
    #: sealed stream. See ailedger_detection.unresolved_flags.
    UNRESOLVED_OBLIGATION = "unresolved-obligation"


def classify_unwarrant(
    obj: Any,
    *,
    weak_warrant_threshold: float = WEAK_WARRANT_THRESHOLD,
) -> UnwarrantCategory | None:
    """Return the unwarrant category for a decision event, or None if warranted.

    Pure warrant-quality verdict — it does NOT validate structural fields
    (decision_id/decision/ts); that is the caller's concern (a malformed input
    is not an "unwarrant", it is a non-decision). Tolerant of a missing or
    malformed ``warrant`` — that is precisely the missing-justification /
    empty-alternatives case.
    """
    warrant = obj.get("warrant") if isinstance(obj, dict) else None
    if not isinstance(warrant, dict):
        return UnwarrantCategory.MISSING_JUSTIFICATION

    justification = warrant.get("justification")
    if not isinstance(justification, str) or not justification.strip():
        return UnwarrantCategory.MISSING_JUSTIFICATION

    alts = warrant.get("rejected_alternatives")
    if (
        not isinstance(alts, list)
        or len(alts) == 0
        or not all(isinstance(a, str) and a.strip() for a in alts)
    ):
        return UnwarrantCategory.EMPTY_ALTERNATIVES

    # A complete-shaped warrant may still be too thin to inject. confidence is
    # optional metadata; only an explicit low value flags a weak warrant
    # (absent confidence is not assessable, so it is NOT a weak warrant).
    confidence = warrant.get("confidence")
    if (
        isinstance(confidence, (int, float))
        and not isinstance(confidence, bool)
        and confidence < weak_warrant_threshold
    ):
        return UnwarrantCategory.WEAK_WARRANT

    return None


def _require_structure(obj: Any) -> tuple[str, str, float]:
    """Minimal structural gate for a recordable decision: decision_id, decision, ts.

    An unwarranted decision is still a decision — it must be identifiable and
    time-stamped to be recorded. A record missing these is malformed, not
    unwarranted, and is rejected rather than counted.
    """
    if not isinstance(obj, dict):
        raise SeamSchemaError("decision event must be an object")
    for name in ("decision_id", "decision"):
        if not isinstance(obj.get(name), str) or not obj[name]:
            raise SeamSchemaError(f"{name} must be a non-empty string to record an unwarrant")
    ts = obj.get("ts")
    if isinstance(ts, bool) or not isinstance(ts, (int, float)):
        raise SeamSchemaError("ts must be epoch seconds (number) to record an unwarrant")
    return obj["decision_id"], obj["decision"], float(ts)


def to_unwarrant_ingest_body(obj: dict[str, Any], category: UnwarrantCategory) -> dict[str, Any]:
    """Map a classified-unwarranted decision onto the relay's
    ``/v2/unwarranted-events`` ingest body.

    The full attempted decision travels in ``attempt`` — the relay seals it
    in the vault (it may carry PII, exactly like a warranted decision's
    payload) and commits to it on-chain; the on-chain ``ode-2u`` keeps only
    the non-personal structural fields + the category + a salted commitment.
    """
    decision_id, _decision, ts = _require_structure(obj)
    ts_iso = (
        datetime.fromtimestamp(ts, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    bucket = obj.get("bucket")
    return {
        "event_id": str(uuid.uuid5(_EVENT_NS, decision_id)),
        "timestamp": ts_iso,
        "decision_type": bucket if isinstance(bucket, str) and bucket else "agent_decision",
        "unwarrant_category": category.value,
        # Sealed by the relay into the vault; never on-chain in cleartext.
        "attempt": obj,
    }
