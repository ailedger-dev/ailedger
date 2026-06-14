"""Unresolved-obligation detection — the asynchronous unwarrant (OWT cat-4).

Categories 1–3 (missing-justification / empty-alternatives / weak-warrant) are
decided at the gate, synchronously. The fourth — **unresolved-obligation** — is
different: a decision was warranted when made, but it *raised a required action*
that was never taken. The diff between ``required_actions`` and
``actions_taken`` is the unresolved compliance gap (spec §1). It can only be
found by looking across a subject's decision history, so it is computed
asynchronously over the (decrypted) sealed stream, not at the gate.

Resolution model (v1): an obligation is a ``required_action`` on a decision; it
is **resolved** if that same action identifier appears in the ``actions_taken``
of the same or any later decision for the same subject — optionally only within
``window_seconds`` of the requiring decision. Otherwise it is **unresolved**.

Action identity is normalized to a string: a string action is itself; an object
action uses the first present of ``code`` / ``action`` / ``type``.

Findings can be recorded as ``ode-2u`` records with category
``unresolved-obligation`` (see :func:`unresolved_obligation_bodies`), so they
flow into the same warrant-health rate and reconciliation as the synchronous
categories. Threshold is tighten-only.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from ailedger_detection.unwarrant import UnwarrantCategory, to_unwarrant_ingest_body

__all__ = [
    "DEFAULT_UNRESOLVED_THRESHOLD",
    "UnresolvedFlagResult",
    "UnresolvedObligation",
    "unresolved_flag_accumulation",
    "unresolved_obligation_bodies",
]

#: Default unresolved-obligation-rate budget (unresolved / total obligations).
#: Customers tighten, never loosen.
DEFAULT_UNRESOLVED_THRESHOLD: float = 0.1


def _action_id(action: Any) -> str | None:
    if isinstance(action, str):
        return action or None
    if isinstance(action, Mapping):
        for key in ("code", "action", "type"):
            v = action.get(key)
            if isinstance(v, str) and v:
                return v
    return None


@dataclass(frozen=True)
class UnresolvedObligation:
    """One required action on a decision that was never taken for the subject."""

    decision_id: str
    subject_id: str | None
    action: str
    ts: float


@dataclass(frozen=True)
class UnresolvedFlagResult:
    """Result of an unresolved-obligation accumulation over a window of events."""

    total_obligations: int
    """Count of required_actions across all events (the denominator)."""

    unresolved: int
    """Count of obligations never matched by a later actions_taken."""

    rate: float
    """unresolved / total_obligations (0.0 when there are no obligations)."""

    threshold: float
    """Unresolved-rate budget. flagged when exceeded."""

    flagged: bool
    """True if rate > threshold."""

    by_action: dict[str, int]
    """Per-action-identifier unresolved counts, for inspectability."""

    obligations: tuple[UnresolvedObligation, ...] = field(default_factory=tuple)
    """The unresolved obligations themselves (for recording as ode-2u)."""


def unresolved_flag_accumulation(
    events: Iterable[Mapping[str, Any]],
    *,
    threshold: float = DEFAULT_UNRESOLVED_THRESHOLD,
    window_seconds: float | None = None,
) -> UnresolvedFlagResult:
    """Find required actions that were never taken for their subject.

    ``events`` are decrypted decision payloads carrying ``decision_id``,
    ``subject_id`` (optional), ``ts``, ``required_actions`` and
    ``actions_taken``. Order-independent: the function pools each subject's
    taken actions (with timestamps) and checks every obligation against that
    pool.
    """
    if not 0.0 < threshold < 1.0:
        raise ValueError("threshold must be in (0, 1)")

    events = list(events)
    # subject → list of (action_id, ts) taken
    taken_by_subject: dict[str | None, list[tuple[str, float]]] = {}
    for ev in events:
        subject = ev.get("subject_id")
        ts = float(ev.get("ts", 0.0))
        for a in ev.get("actions_taken") or []:
            aid = _action_id(a)
            if aid is not None:
                taken_by_subject.setdefault(subject, []).append((aid, ts))

    total = 0
    unresolved: list[UnresolvedObligation] = []
    by_action: dict[str, int] = {}
    for ev in events:
        subject = ev.get("subject_id")
        req_ts = float(ev.get("ts", 0.0))
        taken = taken_by_subject.get(subject, [])
        for r in ev.get("required_actions") or []:
            rid = _action_id(r)
            if rid is None:
                continue
            total += 1
            resolved = any(
                aid == rid
                and t_taken >= req_ts
                and (window_seconds is None or t_taken - req_ts <= window_seconds)
                for aid, t_taken in taken
            )
            if not resolved:
                unresolved.append(
                    UnresolvedObligation(
                        decision_id=str(ev.get("decision_id", "")),
                        subject_id=subject if isinstance(subject, str) else None,
                        action=rid,
                        ts=req_ts,
                    )
                )
                by_action[rid] = by_action.get(rid, 0) + 1

    rate = len(unresolved) / total if total else 0.0
    return UnresolvedFlagResult(
        total_obligations=total,
        unresolved=len(unresolved),
        rate=rate,
        threshold=threshold,
        flagged=rate > threshold,
        by_action=by_action,
        obligations=tuple(unresolved),
    )


def unresolved_obligation_bodies(
    result: UnresolvedFlagResult,
    events_by_decision_id: Mapping[str, Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Map unresolved obligations onto ``/v2/unwarranted-events`` ingest bodies
    (category ``unresolved-obligation``), so they are recorded as ode-2u and
    counted in the warrant-health rate like the synchronous categories.

    The original decision event (looked up by id) becomes the sealed attempt.
    """
    bodies: list[dict[str, Any]] = []
    for ob in result.obligations:
        ev = events_by_decision_id.get(ob.decision_id)
        if ev is None:
            continue
        body = to_unwarrant_ingest_body(dict(ev), UnwarrantCategory.UNRESOLVED_OBLIGATION)
        body["unresolved_action"] = ob.action
        bodies.append(body)
    return bodies
