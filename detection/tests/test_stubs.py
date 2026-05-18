"""Tests for v0.2.0 stub primitives — confirm they raise NotImplementedError clearly."""

from __future__ import annotations

import pytest

from ailedger_detection import (
    confidence_stratified_outcome_analysis,
    subject_repeated_decision_patterns,
    unresolved_flag_accumulation,
)


def test_confidence_stratified_raises_with_pointer_to_v0_3_0() -> None:
    with pytest.raises(NotImplementedError, match="v0.3.0 stub"):
        confidence_stratified_outcome_analysis(
            [],
            protected_class_key="race",
            positive_outcome_predicate=lambda _: True,
        )


def test_unresolved_flag_accumulation_raises_with_pointer_to_v0_3_0() -> None:
    with pytest.raises(NotImplementedError, match="v0.3.0 stub"):
        unresolved_flag_accumulation([])


def test_subject_repeated_decision_patterns_raises_with_pointer_to_v0_3_0() -> None:
    with pytest.raises(NotImplementedError, match="v0.3.0 stub"):
        subject_repeated_decision_patterns([])
