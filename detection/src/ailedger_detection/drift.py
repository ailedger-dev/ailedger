"""
Model drift — outcome-distribution drift across model versions.

When a deployed AI system updates its underlying model (new version, new
weights, fine-tune cycle), the distribution of decisions over its decision
type taxonomy may shift. Drift detection compares two cohorts of Detection
Events (e.g. cohort A from model v1.0, cohort B from model v1.1) and reports
a population-stability-index (PSI) score over the decision_type distribution.

PSI is the canonical drift metric used in financial-services model governance
(per Federal Reserve SR 11-7 / OCC 2011-12 guidance). Thresholds:
- PSI < 0.10 → no significant drift
- 0.10 ≤ PSI < 0.25 → moderate drift; investigate
- PSI ≥ 0.25 → significant drift; action required

AILedger ships the Fed/OCC threshold ladder as default. Customers tighten
(lower the action threshold), never loosen.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any

# Federal Reserve SR 11-7 / OCC 2011-12 PSI threshold ladder.
PSI_NO_DRIFT_THRESHOLD: float = 0.10
PSI_ACTION_THRESHOLD: float = 0.25

# Small smoothing constant for zero-bucket cases (prevents log(0) = -inf).
PSI_SMOOTHING_EPSILON: float = 1e-6


@dataclass(frozen=True)
class ModelDriftResult:
    """Result of a model-drift PSI calculation between two cohorts."""

    psi: float
    """Population Stability Index. ≥ 0; higher = more drift."""

    severity: str
    """One of 'no-drift', 'moderate-drift', 'significant-drift'."""

    flagged: bool
    """True if severity is 'significant-drift' (PSI ≥ action threshold)."""

    reference_count: int
    """Total events in the reference cohort (e.g. model v1.0)."""

    current_count: int
    """Total events in the current cohort (e.g. model v1.1)."""

    bucket_contributions: dict[str, float]
    """Per-decision-type contribution to PSI. Sums to psi."""

    no_drift_threshold: float
    action_threshold: float


def model_drift_between_versions(
    reference_events: Iterable[dict[str, Any]],
    current_events: Iterable[dict[str, Any]],
    *,
    bucket_extractor: Callable[[dict[str, Any]], str] | None = None,
    no_drift_threshold: float = PSI_NO_DRIFT_THRESHOLD,
    action_threshold: float = PSI_ACTION_THRESHOLD,
) -> ModelDriftResult:
    """
    Compute PSI between two cohorts of Detection Events.

    Args:
        reference_events: Baseline cohort (e.g. events from prior model version).
        current_events: Current cohort (e.g. events from new model version).
        bucket_extractor: Function that returns the bucket key for an event.
            Defaults to extracting `decision_type` field. Pass a custom
            extractor to compute drift over a different dimension (e.g.
            confidence buckets, output structure types).
        no_drift_threshold: PSI below this = 'no-drift'. Default 0.10.
        action_threshold: PSI at or above this = 'significant-drift'. Default 0.25.

    Returns:
        ModelDriftResult with PSI, severity, and per-bucket contributions.

    Raises:
        ValueError: If either cohort is empty.
        ValueError: If thresholds are invalid (not 0 < no_drift < action).
    """
    if not (0 < no_drift_threshold < action_threshold):
        raise ValueError(
            f"Thresholds must satisfy 0 < no_drift ({no_drift_threshold}) "
            f"< action ({action_threshold})"
        )

    extractor = bucket_extractor or (lambda e: str(e.get("decision_type", "unknown")))

    ref_counts: dict[str, int] = {}
    cur_counts: dict[str, int] = {}

    for event in reference_events:
        bucket = extractor(event)
        ref_counts[bucket] = ref_counts.get(bucket, 0) + 1

    for event in current_events:
        bucket = extractor(event)
        cur_counts[bucket] = cur_counts.get(bucket, 0) + 1

    ref_total = sum(ref_counts.values())
    cur_total = sum(cur_counts.values())

    if ref_total == 0:
        raise ValueError("reference_events cohort is empty")
    if cur_total == 0:
        raise ValueError("current_events cohort is empty")

    all_buckets = set(ref_counts) | set(cur_counts)
    bucket_contributions: dict[str, float] = {}
    psi = 0.0

    for bucket in all_buckets:
        ref_pct = ref_counts.get(bucket, 0) / ref_total
        cur_pct = cur_counts.get(bucket, 0) / cur_total
        # Smooth zero buckets to prevent log(0).
        ref_smooth = max(ref_pct, PSI_SMOOTHING_EPSILON)
        cur_smooth = max(cur_pct, PSI_SMOOTHING_EPSILON)
        contribution = (cur_smooth - ref_smooth) * math.log(cur_smooth / ref_smooth)
        bucket_contributions[bucket] = contribution
        psi += contribution

    if psi < no_drift_threshold:
        severity = "no-drift"
        flagged = False
    elif psi < action_threshold:
        severity = "moderate-drift"
        flagged = False
    else:
        severity = "significant-drift"
        flagged = True

    return ModelDriftResult(
        psi=psi,
        severity=severity,
        flagged=flagged,
        reference_count=ref_total,
        current_count=cur_total,
        bucket_contributions=bucket_contributions,
        no_drift_threshold=no_drift_threshold,
        action_threshold=action_threshold,
    )
