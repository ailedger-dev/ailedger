"""Agent decision-event ingest contract — the substrate seam.

Agent substrates (multi-agent frameworks, orchestration runtimes) emit one
record per decision; AILedger memorializes it. This module implements the
FROZEN v1 boundary object (schemas/decision-event.v1.json,
$id https://ailedger.dev/schemas/decision-event.v1.json): schema validation,
the canonical digest both sides of the seam cross-check, and the mapping onto
the AILedger /v2/detection-events ingest body.

Contract semantics (frozen — do not change):

* Required: ``decision_id``, ``decision``, ``warrant``, ``ts``. Optional:
  ``source``, ``group``, ``positive``, ``bucket``. UNKNOWN fields are allowed
  and preserved (``additionalProperties: true``) — the seam is deliberately
  version-tolerant so a producer-side refactor adding fields never breaks
  ingest; extra fields flow into the recorded inputs, never silently dropped.
* A record arriving without its rationale — a non-empty ``justification``
  plus at least one ``rejected_alternatives`` entry (or the explicit
  ``no-looser-alternative-at-standard`` sentinel) — is REFUSED at ingest.
  EU AI Act Article 12 record-keeping is about decision records being
  complete enough to audit; an unexplained decision is an incomplete record,
  so it never enters the evidence stream.
* Digests use RFC 8785 (JCS) via ailedger_detection.canonical — the settled
  cross-language form, pinned byte-for-byte against the TypeScript
  `canonicalize` package by the shared golden corpus. This SUPERSEDES the
  earlier ``json.dumps(sort_keys=True)`` placeholder: the two differ on
  non-ASCII key order (code points vs UTF-16 code units) and on float
  formatting (``json.dumps(1781305000.0)`` -> ``"1781305000.0"`` but JCS ->
  ``"1781305000"``) — a real digest fork for any float timestamp. Producers
  must use JCS.
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from ailedger_detection.canonical import canonical

__all__ = [
    "NO_LOOSER_ALTERNATIVE",
    "DecisionEventRecord",
    "IncompleteRationaleError",
    "SeamSchemaError",
    "canonical_digest",
    "to_ingest_body",
    "validate_decision_event",
]

#: Explicit sentinel for "no alternative existed" — an honest empty set,
#: distinct from an unexplained omission. Value is FROZEN (wire contract).
NO_LOOSER_ALTERNATIVE = "no-looser-alternative-at-standard"

#: Deterministic event-id namespace: uuid5(ns, decision_id) makes re-emission
#: idempotent end-to-end (the indexer dedupes by event_id).
_EVENT_NS = uuid.uuid5(uuid.NAMESPACE_URL, "https://ailedger.dev/schemas/decision-event.v1.json")

_REQUIRED = ("decision_id", "decision", "warrant", "ts")
_KNOWN = {"decision_id", "source", "decision", "warrant", "group", "positive", "bucket", "ts"}


class SeamSchemaError(ValueError):
    """The record does not conform to the frozen seam schema."""


class IncompleteRationaleError(SeamSchemaError):
    """The record lacks its rationale — refused, never recorded."""


@dataclass(frozen=True)
class DecisionEventRecord:
    decision_id: str
    decision: str
    justification: str
    rejected_alternatives: tuple[str, ...]
    ts: float
    source: str | None = None
    group: str | None = None
    positive: bool | None = None
    bucket: str | None = None
    #: additionalProperties — preserved verbatim, recorded with the event.
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def event_id(self) -> str:
        """Deterministic UUID — same decision_id always maps to the same event."""
        return str(uuid.uuid5(_EVENT_NS, self.decision_id))


def validate_decision_event(obj: Any) -> DecisionEventRecord:
    """Validate a raw seam record against the frozen v1 contract.

    Raises SeamSchemaError on structural violations and
    IncompleteRationaleError when the rationale is missing or empty. Unknown
    top-level fields are ACCEPTED and preserved (version tolerance).
    """
    if not isinstance(obj, dict):
        raise SeamSchemaError("decision event must be an object")
    missing = [name for name in _REQUIRED if name not in obj]
    if missing:
        raise SeamSchemaError(f"missing required fields: {missing}")

    for name in ("decision_id", "decision"):
        if not isinstance(obj[name], str) or not obj[name]:
            raise SeamSchemaError(f"{name} must be a non-empty string")

    rationale = obj["warrant"]
    if not isinstance(rationale, dict):
        raise IncompleteRationaleError("warrant must be an object")
    justification = rationale.get("justification")
    if not isinstance(justification, str) or not justification.strip():
        raise IncompleteRationaleError("warrant.justification must be a non-empty string")
    alts = rationale.get("rejected_alternatives")
    if (
        not isinstance(alts, list)
        or len(alts) == 0
        or not all(isinstance(a, str) and a for a in alts)
    ):
        raise IncompleteRationaleError(
            "warrant.rejected_alternatives must be a non-empty list of strings "
            f"(use the {NO_LOOSER_ALTERNATIVE!r} sentinel when none existed)"
        )

    if isinstance(obj["ts"], bool) or not isinstance(obj["ts"], (int, float)):
        raise SeamSchemaError("ts must be epoch seconds (number)")

    source = obj.get("source")
    if source is not None and not isinstance(source, str):
        raise SeamSchemaError("source must be a string")
    group = obj.get("group")
    if group is not None and not isinstance(group, str):
        raise SeamSchemaError("group must be a string or null")
    positive = obj.get("positive")
    if positive is not None and not isinstance(positive, bool):
        raise SeamSchemaError("positive must be a boolean")
    bucket = obj.get("bucket")
    if bucket is not None and not isinstance(bucket, str):
        raise SeamSchemaError("bucket must be a string or null")

    extra = {k: v for k, v in obj.items() if k not in _KNOWN}
    return DecisionEventRecord(
        decision_id=obj["decision_id"],
        decision=obj["decision"],
        justification=justification,
        rejected_alternatives=tuple(alts),
        ts=float(obj["ts"]),
        source=source,
        group=group,
        positive=positive,
        bucket=bucket,
        extra=extra,
    )


def canonical_digest(obj: dict[str, Any]) -> str:
    """SHA-256 hex of the JCS form — the value both sides of the seam compare.

    Validates first (digests of malformed records are meaningless), then
    hashes the FULL object including any extra fields, so producer and
    ingester digest identical bytes.
    """
    validate_decision_event(obj)
    return hashlib.sha256(canonical(obj).encode("utf-8")).hexdigest()


def to_ingest_body(record: DecisionEventRecord) -> dict[str, Any]:
    """Map a seam record onto the AILedger /v2/detection-events ingest body."""
    ts_iso = (
        datetime.fromtimestamp(record.ts, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    inputs: dict[str, Any] = {
        "source": record.source,
        "justification": record.justification,
        "rejected_alternatives": list(record.rejected_alternatives),
    }
    if record.extra:
        inputs["extra"] = record.extra
    return {
        "event_id": record.event_id,
        "timestamp": ts_iso,
        "decision_type": record.bucket or "agent_decision",
        "human_in_loop": False,
        "inputs": inputs,
        "output": {"decision": record.decision, "positive": record.positive},
        "protected_class_context": {"group": record.group},
        "protected_class_collection_method": "direct" if record.group is not None else "blind",
    }
