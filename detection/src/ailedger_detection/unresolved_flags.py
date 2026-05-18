"""
Unresolved-flag accumulation (stub for v0.3.0).

Detects flags raised on Detection Events that lack a corresponding entry in
actions_taken. The diff between required_actions and actions_taken is the
unresolved compliance gap surfaced in spec §1.

Use case: a Decision Event flags "low-confidence" and requires
"clinician-review-required" but actions_taken stays empty across multiple
subsequent decisions on similarly-situated subjects. The accumulating gap
is what regulators audit.

Implementation: returns NotImplementedError in v0.2.0. Pending decisions:
- Time window for "accumulation" (per-subject, per-tenant, per-day?)
- Threshold for "accumulating" (count? rate? ratio of unresolved/total?)
- Whether to track flag-specific accumulation or aggregate
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any


def unresolved_flag_accumulation(events: Iterable[dict[str, Any]]) -> None:
    """Stub. Raises NotImplementedError. v0.3.0 target."""
    _ = events
    raise NotImplementedError(
        "unresolved_flag_accumulation is a v0.3.0 stub. "
        "Window + threshold design pending; see module docstring."
    )
