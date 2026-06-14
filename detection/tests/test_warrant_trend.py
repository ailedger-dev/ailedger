"""CUSUM trend detection over an unwarranted-rate series."""

from __future__ import annotations

import pytest

from ailedger_detection.warrant_trend import cusum_upper


def test_stable_low_rate_does_not_flag() -> None:
    r = cusum_upper([0.01, 0.015, 0.02, 0.01, 0.018] * 4)
    assert r.flagged is False
    assert r.change_at is None
    assert r.peak <= r.interval


def test_creeping_drift_flags_before_a_fixed_threshold_would() -> None:
    # rate creeps 0.01 → 0.045, never crossing a 5% point-in-time threshold,
    # but the sustained upward drift accumulates and CUSUM signals it.
    rates = [0.01, 0.015, 0.02, 0.025, 0.03, 0.035, 0.04, 0.045, 0.045, 0.045]
    r = cusum_upper(rates)
    assert r.flagged is True
    assert r.change_at is not None
    assert max(rates) < 0.05  # a 5% fixed threshold never trips on any window


def test_single_spike_then_recovery_resets() -> None:
    # one bad window, then back to baseline — CUSUM decays, no sustained signal
    rates = [0.01, 0.01, 0.09, 0.01, 0.01, 0.01]
    r = cusum_upper(rates, interval=0.1)
    assert r.flagged is False  # the spike alone doesn't sustain past the interval


def test_change_at_is_the_first_crossing() -> None:
    rates = [0.0] * 5 + [0.5] * 5  # abrupt jump at index 5
    r = cusum_upper(rates, target=0.02, allowance=0.01, interval=0.1)
    assert r.flagged is True
    assert r.change_at == 5  # signals on the first high window


def test_tighter_params_detect_smaller_drift() -> None:
    rates = [0.02, 0.025, 0.03, 0.03, 0.03]
    assert cusum_upper(rates).flagged is False
    # tightening the target + interval catches the smaller drift
    assert cusum_upper(rates, target=0.01, allowance=0.005, interval=0.02).flagged is True


def test_rejects_bad_inputs() -> None:
    with pytest.raises(ValueError):
        cusum_upper([0.5, 1.5])  # rate out of range
    with pytest.raises(ValueError):
        cusum_upper([0.1], interval=0.0)
    with pytest.raises(ValueError):
        cusum_upper([0.1], target=1.0)


def test_empty_series() -> None:
    r = cusum_upper([])
    assert r.flagged is False
    assert r.cusum == ()
