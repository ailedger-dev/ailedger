"""Tests for model_drift_between_versions PSI primitive."""

from __future__ import annotations

import pytest

from ailedger_detection.drift import (
    PSI_ACTION_THRESHOLD,
    PSI_NO_DRIFT_THRESHOLD,
    model_drift_between_versions,
)


def _event(decision_type: str) -> dict:
    return {"decision_type": decision_type}


class TestModelDriftBetweenVersions:
    def test_thresholds_match_fdic_occ(self) -> None:
        # FDIC SR 11-7 / OCC 2011-12 thresholds.
        assert PSI_NO_DRIFT_THRESHOLD == 0.10
        assert PSI_ACTION_THRESHOLD == 0.25

    def test_identical_distributions_yield_no_drift(self) -> None:
        ref = [_event("hire")] * 50 + [_event("no_hire")] * 50
        cur = [_event("hire")] * 50 + [_event("no_hire")] * 50
        result = model_drift_between_versions(ref, cur)
        assert pytest.approx(result.psi, abs=1e-3) == 0.0
        assert result.severity == "no-drift"
        assert result.flagged is False

    def test_modest_shift_is_moderate(self) -> None:
        # Reference: 50/50. Current: 70/30. Modest shift → moderate-drift band.
        # 50/50 → 60/40 yields PSI ~0.04 (no-drift). 70/30 yields PSI ~0.17.
        ref = [_event("hire")] * 50 + [_event("no_hire")] * 50
        cur = [_event("hire")] * 70 + [_event("no_hire")] * 30
        result = model_drift_between_versions(ref, cur)
        assert PSI_NO_DRIFT_THRESHOLD < result.psi < PSI_ACTION_THRESHOLD
        assert result.severity == "moderate-drift"
        assert result.flagged is False

    def test_major_shift_is_significant_and_flagged(self) -> None:
        # Reference: 90/10. Current: 30/70. Major shift → significant-drift.
        ref = [_event("hire")] * 90 + [_event("no_hire")] * 10
        cur = [_event("hire")] * 30 + [_event("no_hire")] * 70
        result = model_drift_between_versions(ref, cur)
        assert result.psi >= PSI_ACTION_THRESHOLD
        assert result.severity == "significant-drift"
        assert result.flagged is True

    def test_custom_bucket_extractor(self) -> None:
        # Drift over confidence-bucket rather than decision_type.
        ref = [{"confidence": 0.9} for _ in range(50)] + [{"confidence": 0.5} for _ in range(50)]
        cur = [{"confidence": 0.9} for _ in range(10)] + [{"confidence": 0.5} for _ in range(90)]
        result = model_drift_between_versions(
            ref,
            cur,
            bucket_extractor=lambda e: "high" if e["confidence"] >= 0.8 else "low",
        )
        # High bucket shifts from 50% to 10%; large drift.
        assert result.psi > PSI_ACTION_THRESHOLD
        assert result.flagged is True

    def test_empty_reference_raises(self) -> None:
        with pytest.raises(ValueError, match="reference_events cohort is empty"):
            model_drift_between_versions([], [_event("hire")])

    def test_empty_current_raises(self) -> None:
        with pytest.raises(ValueError, match="current_events cohort is empty"):
            model_drift_between_versions([_event("hire")], [])

    def test_invalid_thresholds_raise(self) -> None:
        ref = [_event("hire")] * 10
        cur = [_event("hire")] * 10
        with pytest.raises(ValueError, match="Thresholds must satisfy"):
            model_drift_between_versions(
                ref,
                cur,
                no_drift_threshold=0.30,
                action_threshold=0.20,
            )

    def test_new_bucket_in_current_contributes_to_psi(self) -> None:
        # Reference has 'hire' / 'no_hire'. Current introduces 'review_required'.
        ref = [_event("hire")] * 50 + [_event("no_hire")] * 50
        cur = [_event("hire")] * 30 + [_event("no_hire")] * 30 + [_event("review_required")] * 40
        result = model_drift_between_versions(ref, cur)
        assert "review_required" in result.bucket_contributions
        assert result.psi > 0.0

    def test_bucket_contributions_sum_to_psi(self) -> None:
        ref = [_event("hire")] * 70 + [_event("no_hire")] * 30
        cur = [_event("hire")] * 40 + [_event("no_hire")] * 60
        result = model_drift_between_versions(ref, cur)
        assert pytest.approx(sum(result.bucket_contributions.values()), abs=1e-6) == result.psi
