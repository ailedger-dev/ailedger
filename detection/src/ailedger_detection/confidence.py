"""
Confidence-stratified outcome analysis (stub for v0.3.0).

Slices a population of Detection Events by confidence bucket and reports
outcome statistics per bucket. Use case: detecting whether the model's
high-confidence decisions concentrate adverse outcomes on a protected
class (a subtle bias signal not caught by raw disparate-impact ratio).

Implementation: returns NotImplementedError in v0.2.0. Pending design
decisions:
- Bucket boundaries (equi-width? quantile? customer-configurable?)
- Minimum bucket size for statistical inference
- Whether to report per-bucket disparate impact (composes with disparate_impact.py)
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any


def confidence_stratified_outcome_analysis(
    events: Iterable[dict[str, Any]],
    *,
    protected_class_key: str,
    positive_outcome_predicate: Callable[[dict[str, Any]], bool],
    bucket_boundaries: tuple[float, ...] = (0.5, 0.7, 0.85, 0.95),
) -> None:
    """Stub. Raises NotImplementedError. v0.3.0 target."""
    _ = events
    _ = protected_class_key
    _ = positive_outcome_predicate
    _ = bucket_boundaries
    raise NotImplementedError(
        "confidence_stratified_outcome_analysis is a v0.3.0 stub. "
        "Bucket-boundary design pending; see module docstring."
    )
