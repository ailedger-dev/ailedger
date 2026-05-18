"""Tests for statistical parity difference primitive."""

from __future__ import annotations

import pytest

from ailedger_detection.parity import (
    DEFAULT_SPD_THRESHOLD,
    statistical_parity_difference,
)


def _event(race: str, hire: bool) -> dict:
    return {
        "protected_class_context": {"race": race},
        "output": {"decision": "hire" if hire else "no"},
    }


def _hire_predicate(event: dict) -> bool:
    return event["output"]["decision"] == "hire"


class TestStatisticalParityDifference:
    def test_default_threshold_is_ten_percentage_points(self) -> None:
        assert DEFAULT_SPD_THRESHOLD == 0.10

    def test_perfect_parity_yields_spd_zero(self) -> None:
        events = [
            _event("A", True),
            _event("A", False),
            _event("B", True),
            _event("B", False),
        ]
        result = statistical_parity_difference(
            events,
            protected_class_key="race",
            positive_outcome_predicate=_hire_predicate,
        )
        assert result.spd == 0.0
        assert result.flagged is False

    def test_large_gap_is_flagged(self) -> None:
        # A: 9/10 = 0.90. B: 2/10 = 0.20. SPD = 0.70 > 0.10 → flagged.
        events = [_event("A", True) for _ in range(9)] + [_event("A", False)]
        events += [_event("B", True) for _ in range(2)] + [_event("B", False) for _ in range(8)]
        result = statistical_parity_difference(
            events,
            protected_class_key="race",
            positive_outcome_predicate=_hire_predicate,
        )
        assert pytest.approx(result.spd, abs=1e-6) == 0.70
        assert result.flagged is True
        assert result.high_group == "A"
        assert result.low_group == "B"

    def test_borderline_at_threshold(self) -> None:
        # A: 10/10 = 1.0. B: 9/10 = 0.9. SPD = 0.10. NOT > 0.10 so NOT flagged.
        events = [_event("A", True) for _ in range(10)]
        events += [_event("B", True) for _ in range(9)] + [_event("B", False)]
        result = statistical_parity_difference(
            events,
            protected_class_key="race",
            positive_outcome_predicate=_hire_predicate,
        )
        assert pytest.approx(result.spd, abs=1e-6) == 0.10
        assert result.flagged is False  # strict > semantics

    def test_custom_threshold_tighter(self) -> None:
        events = [_event("A", True) for _ in range(10)]
        events += [_event("B", True) for _ in range(9)] + [_event("B", False)]
        result = statistical_parity_difference(
            events,
            protected_class_key="race",
            positive_outcome_predicate=_hire_predicate,
            threshold=0.05,
        )
        assert result.flagged is True

    def test_invalid_threshold_raises(self) -> None:
        events = [_event("A", True), _event("B", False)]
        with pytest.raises(ValueError, match="threshold must be in"):
            statistical_parity_difference(
                events,
                protected_class_key="race",
                positive_outcome_predicate=_hire_predicate,
                threshold=-0.1,
            )
        with pytest.raises(ValueError, match="threshold must be in"):
            statistical_parity_difference(
                events,
                protected_class_key="race",
                positive_outcome_predicate=_hire_predicate,
                threshold=1.5,
            )

    def test_complements_disparate_impact_when_low_rate_near_zero(self) -> None:
        # When the lowest rate is near zero, disparate impact ratio becomes
        # unstable. SPD is stable in this regime.
        events = [_event("A", True) for _ in range(100)]
        events += [_event("B", False) for _ in range(100)]
        result = statistical_parity_difference(
            events,
            protected_class_key="race",
            positive_outcome_predicate=_hire_predicate,
        )
        assert result.spd == 1.0
        assert result.flagged is True

    def test_single_group_raises(self) -> None:
        events = [_event("A", True), _event("A", False)]
        with pytest.raises(ValueError, match="At least two distinct"):
            statistical_parity_difference(
                events,
                protected_class_key="race",
                positive_outcome_predicate=_hire_predicate,
            )
