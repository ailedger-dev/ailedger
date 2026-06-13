"""Frozen seam-schema validation, canonical digests, and the ingest mapping.

Contract under test = schemas/decision-event.v1.json: 4 required fields,
additionalProperties true (version tolerance), the frozen sentinel value,
rationale refusal.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from ailedger_detection.canonical import canonical
from ailedger_detection.decision_event import (
    NO_LOOSER_ALTERNATIVE,
    IncompleteRationaleError,
    SeamSchemaError,
    canonical_digest,
    to_ingest_body,
    validate_decision_event,
)

_SCHEMA = json.loads(
    (
        Path(__file__).resolve().parents[1]
        / "src"
        / "ailedger_detection"
        / "schemas"
        / "decision-event.v1.json"
    ).read_text(encoding="utf-8")
)


def seam_event(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "decision_id": "hedera-indexer-store-choice",
        "source": "claude/lemur",
        "decision": "node:sqlite for the self-host indexer store",
        "warrant": {
            "justification": "zero native dependencies beats a native build for anyone-can-run-this",
            "rejected_alternatives": ["duckdb (native module build)", "postgres-only (SaaS coupling)"],
        },
        "group": None,
        "positive": True,
        "bucket": "architecture_decision",
        "ts": 1781305000,
    }
    base.update(overrides)
    return base


def test_module_matches_frozen_schema_contract() -> None:
    # The schema file is the contract; the validator must mirror it.
    assert set(_SCHEMA["required"]) == {"decision_id", "decision", "warrant", "ts"}
    assert _SCHEMA["additionalProperties"] is True
    assert NO_LOOSER_ALTERNATIVE in str(
        _SCHEMA["properties"]["warrant"]["properties"]["rejected_alternatives"]["description"]
    )


def test_valid_event_round_trips() -> None:
    record = validate_decision_event(seam_event())
    assert record.decision_id == "hedera-indexer-store-choice"
    assert record.rejected_alternatives[0].startswith("duckdb")
    # Deterministic event id: idempotent re-emission.
    assert record.event_id == validate_decision_event(seam_event()).event_id
    assert validate_decision_event(seam_event(decision_id="other")).event_id != record.event_id


def test_minimal_event_only_required_fields() -> None:
    minimal = {
        "decision_id": "d1",
        "decision": "ship it",
        "warrant": {"justification": "tests green", "rejected_alternatives": [NO_LOOSER_ALTERNATIVE]},
        "ts": 1781305000.5,
    }
    record = validate_decision_event(minimal)
    assert record.source is None
    assert record.positive is None
    assert record.bucket is None
    assert record.extra == {}
    assert to_ingest_body(record)["decision_type"] == "agent_decision"


def test_sentinel_value_is_the_frozen_wire_string() -> None:
    assert NO_LOOSER_ALTERNATIVE == "no-looser-alternative-at-standard"


def test_unknown_fields_are_accepted_and_preserved() -> None:
    # additionalProperties: true — a producer refactor adding fields must not
    # break ingest, and the extras land in the recorded inputs.
    ev = seam_event(lattice_ref="lattice://alpha/x", confidence_note="high")
    record = validate_decision_event(ev)
    assert record.extra == {"lattice_ref": "lattice://alpha/x", "confidence_note": "high"}
    body = to_ingest_body(record)
    assert body["inputs"]["extra"]["lattice_ref"] == "lattice://alpha/x"


@pytest.mark.parametrize(
    "mutation",
    [
        {"warrant": {"justification": "", "rejected_alternatives": ["x"]}},
        {"warrant": {"justification": "   ", "rejected_alternatives": ["x"]}},
        {"warrant": {"justification": "why", "rejected_alternatives": []}},
        {"warrant": {"justification": "why", "rejected_alternatives": ["ok", ""]}},
        {"warrant": {"justification": "why"}},
        {"warrant": "not an object"},
    ],
)
def test_incomplete_rationale_is_refused(mutation: dict[str, Any]) -> None:
    with pytest.raises(IncompleteRationaleError):
        validate_decision_event(seam_event(**mutation))


def test_missing_required_and_bad_types_are_rejected() -> None:
    incomplete = seam_event()
    del incomplete["decision_id"]
    with pytest.raises(SeamSchemaError, match="missing"):
        validate_decision_event(incomplete)
    with pytest.raises(SeamSchemaError, match="ts"):
        validate_decision_event(seam_event(ts=True))
    with pytest.raises(SeamSchemaError, match="positive"):
        validate_decision_event(seam_event(positive="yes"))
    with pytest.raises(SeamSchemaError, match="group"):
        validate_decision_event(seam_event(group=42))


def test_canonical_digest_is_jcs_sha256_and_covers_extras() -> None:
    ev = seam_event()
    assert canonical_digest(ev) == hashlib.sha256(canonical(ev).encode()).hexdigest()
    # Field order on the wire must not matter — JCS sorts.
    reordered = dict(reversed(list(ev.items())))
    assert canonical_digest(reordered) == canonical_digest(ev)
    # Extra fields change the digest (they're part of the hashed object).
    assert canonical_digest(seam_event(extra_field=1)) != canonical_digest(ev)
    with pytest.raises(IncompleteRationaleError):
        canonical_digest(seam_event(warrant={"justification": "", "rejected_alternatives": ["x"]}))


def test_jcs_supersedes_json_dumps_for_float_ts() -> None:
    # The concrete divergence that forced the canonicalization settlement:
    # json.dumps writes a trailing '.0' on integral floats; JCS does not.
    ev = seam_event(ts=1781305000.0)
    dumped = json.dumps(ev, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    assert "1781305000.0" in dumped
    assert '"ts":1781305000}' in canonical(ev) or '"ts":1781305000,' in canonical(ev)
    assert (
        canonical_digest(ev)
        != hashlib.sha256(dumped.encode()).hexdigest()
    )


def test_ingest_body_mapping() -> None:
    body = to_ingest_body(validate_decision_event(seam_event()))
    assert body["decision_type"] == "architecture_decision"
    assert body["timestamp"] == "2026-06-12T22:56:40.000Z"
    assert body["output"] == {
        "decision": "node:sqlite for the self-host indexer store",
        "positive": True,
    }
    assert body["inputs"]["justification"].startswith("zero native")
    assert body["protected_class_collection_method"] == "blind"  # group is None
    labeled = to_ingest_body(validate_decision_event(seam_event(group="40-55")))
    assert labeled["protected_class_collection_method"] == "direct"
    assert labeled["protected_class_context"] == {"group": "40-55"}
