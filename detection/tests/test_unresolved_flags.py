"""Unresolved-obligation detector (OWT category-4, asynchronous)."""

from __future__ import annotations

import pytest

from ailedger_detection.unresolved_flags import (
    unresolved_flag_accumulation,
    unresolved_obligation_bodies,
)


def ev(decision_id, subject, ts, required=None, taken=None):
    return {
        "decision_id": decision_id,
        "decision": "acted",
        "subject_id": subject,
        "ts": ts,
        "required_actions": required or [],
        "actions_taken": taken or [],
    }


def test_obligation_resolved_by_later_action_for_same_subject() -> None:
    events = [
        ev("d1", "s1", 100, required=["clinician-review"]),
        ev("d2", "s1", 200, taken=["clinician-review"]),  # resolves d1
    ]
    r = unresolved_flag_accumulation(events)
    assert r.total_obligations == 1
    assert r.unresolved == 0
    assert r.rate == 0.0
    assert r.flagged is False


def test_unresolved_when_never_taken() -> None:
    events = [
        ev("d1", "s1", 100, required=["clinician-review"]),
        ev("d2", "s1", 200, taken=["something-else"]),
        ev("d3", "s2", 150, required=["second-signoff"], taken=["second-signoff"]),  # same-event resolve
    ]
    r = unresolved_flag_accumulation(events)
    assert r.total_obligations == 2
    assert r.unresolved == 1
    assert r.rate == 0.5
    assert r.by_action == {"clinician-review": 1}
    assert r.obligations[0].decision_id == "d1"
    assert r.obligations[0].subject_id == "s1"


def test_taken_must_be_at_or_after_requirement() -> None:
    # a taken action BEFORE the requirement does not resolve it
    events = [
        ev("d0", "s1", 50, taken=["review"]),
        ev("d1", "s1", 100, required=["review"]),  # unresolved: only prior taken
    ]
    r = unresolved_flag_accumulation(events)
    assert r.unresolved == 1


def test_window_seconds_bounds_resolution() -> None:
    events = [
        ev("d1", "s1", 100, required=["review"]),
        ev("d2", "s1", 100 + 10_000, taken=["review"]),  # taken much later
    ]
    assert unresolved_flag_accumulation(events).unresolved == 0  # unbounded → resolved
    assert unresolved_flag_accumulation(events, window_seconds=3600).unresolved == 1  # too late


def test_object_actions_match_by_code() -> None:
    events = [
        ev("d1", "s1", 100, required=[{"code": "REV", "note": "x"}]),
        ev("d2", "s1", 200, taken=[{"code": "REV"}]),
    ]
    assert unresolved_flag_accumulation(events).unresolved == 0


def test_actions_are_subject_scoped() -> None:
    # s2 taking the action does NOT resolve s1's obligation
    events = [
        ev("d1", "s1", 100, required=["review"]),
        ev("d2", "s2", 200, taken=["review"]),
    ]
    assert unresolved_flag_accumulation(events).unresolved == 1


def test_flagged_when_rate_exceeds_threshold() -> None:
    events = [ev(f"d{i}", "s1", i, required=["x"]) for i in range(10)]  # 10 unresolved, 0 taken
    r = unresolved_flag_accumulation(events, threshold=0.1)
    assert r.rate == 1.0
    assert r.flagged is True


def test_to_unwarrant_bodies_maps_to_unresolved_obligation() -> None:
    events = [ev("d1", "s1", 100, required=["review"])]
    r = unresolved_flag_accumulation(events)
    bodies = unresolved_obligation_bodies(r, {"d1": events[0]})
    assert len(bodies) == 1
    assert bodies[0]["unwarrant_category"] == "unresolved-obligation"
    assert bodies[0]["unresolved_action"] == "review"
    assert bodies[0]["attempt"]["decision_id"] == "d1"


def test_rejects_bad_threshold() -> None:
    with pytest.raises(ValueError):
        unresolved_flag_accumulation([], threshold=0.0)
