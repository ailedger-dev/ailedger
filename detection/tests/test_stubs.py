"""Tests for v0.2.0 stub primitives — confirm they raise NotImplementedError clearly."""

from __future__ import annotations

import pytest

from ailedger_detection import (
    confidence_stratified_outcome_analysis,
    subject_repeated_decision_patterns,
)


def test_confidence_stratified_raises_with_pointer_to_v0_3_0() -> None:
    with pytest.raises(NotImplementedError, match="v0.3.0 stub"):
        confidence_stratified_outcome_analysis(
            [],
            protected_class_key="race",
            positive_outcome_predicate=lambda _: True,
        )


# unresolved_flag_accumulation is implemented (OWT cat-4); see
# test_unresolved_flags.py. (Was a stub in v0.2.0.)


def test_subject_repeated_decision_patterns_raises_with_pointer_to_v0_3_0() -> None:
    with pytest.raises(NotImplementedError, match="v0.3.0 stub"):
        subject_repeated_decision_patterns([])
