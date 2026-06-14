"""Unwarrant classifier — the gap-honest verdict on a decision's warrant."""

from __future__ import annotations

import uuid
from typing import Any

import pytest

from ailedger_detection.decision_event import NO_LOOSER_ALTERNATIVE, SeamSchemaError
from ailedger_detection.unwarrant import (
    WEAK_WARRANT_THRESHOLD,
    UnwarrantCategory,
    classify_unwarrant,
    to_unwarrant_ingest_body,
)


def warranted(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "decision_id": "d-1",
        "source": "claude/lemur",
        "decision": "ship it",
        "warrant": {
            "justification": "tests are green and the diff is reviewed",
            "rejected_alternatives": ["wait for more review"],
        },
        "bucket": "architecture_decision",
        "ts": 1781305000,
    }
    base.update(overrides)
    return base


def test_warranted_decision_classifies_none() -> None:
    assert classify_unwarrant(warranted()) is None
    # the sentinel is a valid (non-empty) rejected-alternatives set
    assert (
        classify_unwarrant(
            warranted(warrant={"justification": "only lawful path", "rejected_alternatives": [NO_LOOSER_ALTERNATIVE]})
        )
        is None
    )


@pytest.mark.parametrize(
    "warrant, expected",
    [
        (None, UnwarrantCategory.MISSING_JUSTIFICATION),
        ({}, UnwarrantCategory.MISSING_JUSTIFICATION),
        ({"rejected_alternatives": ["x"]}, UnwarrantCategory.MISSING_JUSTIFICATION),
        ({"justification": "", "rejected_alternatives": ["x"]}, UnwarrantCategory.MISSING_JUSTIFICATION),
        ({"justification": "   ", "rejected_alternatives": ["x"]}, UnwarrantCategory.MISSING_JUSTIFICATION),
        ({"justification": "why"}, UnwarrantCategory.EMPTY_ALTERNATIVES),
        ({"justification": "why", "rejected_alternatives": []}, UnwarrantCategory.EMPTY_ALTERNATIVES),
        ({"justification": "why", "rejected_alternatives": ["ok", ""]}, UnwarrantCategory.EMPTY_ALTERNATIVES),
        ({"justification": "why", "rejected_alternatives": "not-a-list"}, UnwarrantCategory.EMPTY_ALTERNATIVES),
    ],
)
def test_missing_and_empty_categories(warrant: Any, expected: UnwarrantCategory) -> None:
    assert classify_unwarrant(warranted(warrant=warrant)) is expected


def test_weak_warrant_only_when_confidence_below_threshold() -> None:
    sound = {"justification": "why", "rejected_alternatives": ["alt"]}
    # below threshold -> weak
    assert (
        classify_unwarrant(warranted(warrant={**sound, "confidence": 0.4}))
        is UnwarrantCategory.WEAK_WARRANT
    )
    # at/above threshold -> warranted
    assert classify_unwarrant(warranted(warrant={**sound, "confidence": WEAK_WARRANT_THRESHOLD})) is None
    assert classify_unwarrant(warranted(warrant={**sound, "confidence": 0.9})) is None
    # absent confidence is not assessable -> NOT weak
    assert classify_unwarrant(warranted(warrant=sound)) is None
    # bool is not a confidence number
    assert classify_unwarrant(warranted(warrant={**sound, "confidence": True})) is None


def test_threshold_is_tunable_tighter() -> None:
    sound = {"justification": "why", "rejected_alternatives": ["alt"], "confidence": 0.7}
    assert classify_unwarrant(warranted(warrant=sound)) is None
    # a customer tightening to 0.8 now flags the 0.7 warrant
    assert (
        classify_unwarrant(warranted(warrant=sound), weak_warrant_threshold=0.8)
        is UnwarrantCategory.WEAK_WARRANT
    )


def test_category_values_are_frozen_wire_strings() -> None:
    assert UnwarrantCategory.MISSING_JUSTIFICATION.value == "missing-justification"
    assert UnwarrantCategory.EMPTY_ALTERNATIVES.value == "empty-alternatives"
    assert UnwarrantCategory.WEAK_WARRANT.value == "weak-warrant"


def test_ingest_body_maps_and_seals_attempt() -> None:
    ev = warranted(warrant={"rejected_alternatives": ["x"]})  # missing justification
    cat = classify_unwarrant(ev)
    assert cat is UnwarrantCategory.MISSING_JUSTIFICATION
    body = to_unwarrant_ingest_body(ev, cat)
    assert body["unwarrant_category"] == "missing-justification"
    assert body["decision_type"] == "architecture_decision"
    assert body["timestamp"] == "2026-06-12T22:56:40.000Z"
    # event_id is deterministic from decision_id (idempotent re-emission), and
    # matches the warranted path's namespace so re-classification is stable.
    assert body["event_id"] == str(
        uuid.uuid5(uuid.uuid5(uuid.NAMESPACE_URL, "https://ailedger.dev/schemas/decision-event.v1.json"), "d-1")
    )
    # the full attempt is carried for the relay to seal into the vault
    assert body["attempt"] is ev
    # bucket=None -> fallback decision_type
    assert to_unwarrant_ingest_body(warranted(bucket=None, warrant={}), UnwarrantCategory.MISSING_JUSTIFICATION)["decision_type"] == "agent_decision"


def test_unrecordable_malformed_attempts_raise() -> None:
    with pytest.raises(SeamSchemaError):
        to_unwarrant_ingest_body({"decision": "x", "ts": 1}, UnwarrantCategory.MISSING_JUSTIFICATION)  # no decision_id
    with pytest.raises(SeamSchemaError):
        to_unwarrant_ingest_body({"decision_id": "d", "decision": "x"}, UnwarrantCategory.MISSING_JUSTIFICATION)  # no ts
