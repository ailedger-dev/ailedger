"""
Subject-level repeated-decision pattern detection (stub for v0.3.0).

Detects patterns where the same subject (HMAC-pseudonymized subject_id)
appears across multiple Detection Events with consistently-adverse outcomes
or consistently-low confidence. Distinguishes systemic bias on a population
from individually-correct decisions on the same person.

Use case: an applicant rejected three times across a six-month window by
the same employer's AI screening system. Each decision may have been
individually defensible; the pattern is the bias signal.

Implementation: returns NotImplementedError in v0.2.0. Pending decisions:
- Subject identity model (HMAC same-id across decisions vs cross-reference?)
- Pattern definition (count of adverse? consecutive adverse? ratio?)
- Time window (per-tenant policy)
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any


def subject_repeated_decision_patterns(events: Iterable[dict[str, Any]]) -> None:
    """Stub. Raises NotImplementedError. v0.3.0 target."""
    _ = events
    raise NotImplementedError(
        "subject_repeated_decision_patterns is a v0.3.0 stub. "
        "Identity + pattern definition pending; see module docstring."
    )
