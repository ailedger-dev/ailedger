"""Warrant-health verdict — Wilson GAP guard, gap-honest PASS/FLAG/GAP."""

from __future__ import annotations

import math

import pytest

from ailedger_detection.warrant_health import (
    DEFAULT_MIN_SAMPLE,
    WarrantHealthVerdict,
    compute_warrant_health,
    wilson_interval,
)


def test_wilson_interval_basic_properties() -> None:
    # n == 0 → no information
    assert wilson_interval(0, 0) == (0.0, 1.0)
    # bounds are ordered and within [0,1], and bracket the point estimate
    for k, n in [(0, 10), (1, 10), (5, 10), (10, 10), (3, 1000)]:
        lo, hi = wilson_interval(k, n)
        assert 0.0 <= lo <= hi <= 1.0
        # bounds bracket the point estimate up to float precision (exact at p=1
        # the upper rounds to 1 - 1e-16)
        assert lo - 1e-12 <= k / n <= hi + 1e-12
    # known value: Wilson 50/100 ≈ [0.404, 0.596]
    lo, hi = wilson_interval(50, 100)
    assert math.isclose(lo, 0.4038, abs_tol=1e-3)
    assert math.isclose(hi, 0.5962, abs_tol=1e-3)
    with pytest.raises(ValueError):
        wilson_interval(5, 3)


def test_gap_when_below_sample_floor() -> None:
    # 1 unwarranted of 4 — rate 0.25 looks high, but n is far below the floor.
    r = compute_warrant_health(3, {"missing-justification": 1})
    assert r.total == 4
    assert r.rate == 0.25
    assert r.verdict is WarrantHealthVerdict.GAP  # not a small-sample false flag
    assert r.flagged is False


def test_pass_when_upper_bound_within_budget() -> None:
    # 0 unwarranted of 1000 at a 5% budget → confidently within budget.
    r = compute_warrant_health(1000, {})
    assert r.rate == 0.0
    assert r.wilson_upper <= r.threshold
    assert r.verdict is WarrantHealthVerdict.PASS
    assert r.flagged is False


def test_flag_when_lower_bound_exceeds_budget() -> None:
    # 200 unwarranted of 1000 (20%) at a 5% budget → confidently over.
    r = compute_warrant_health(800, {"missing-justification": 150, "weak-warrant": 50})
    assert r.total == 1000
    assert r.unwarranted == 200
    assert r.by_category == {"missing-justification": 150, "weak-warrant": 50}
    assert r.wilson_lower > r.threshold
    assert r.verdict is WarrantHealthVerdict.FLAG
    assert r.flagged is True


def test_gap_when_interval_straddles_threshold() -> None:
    # rate exactly at the threshold with a moderate sample → interval straddles.
    r = compute_warrant_health(95, {"weak-warrant": 5}, min_sample=10)  # 5/100 = 0.05
    assert r.rate == pytest.approx(0.05)
    assert r.wilson_lower < r.threshold < r.wilson_upper
    assert r.verdict is WarrantHealthVerdict.GAP


def test_tighten_only_threshold_and_sample() -> None:
    # 80 of 1000 = 8%. At the 5% default → FLAG. A customer could not LOOSEN to
    # 10% in production (policy), but the function honors a passed threshold so
    # tightening to 2% is expressible; here we show 8% flags at default.
    assert compute_warrant_health(920, {"weak-warrant": 80}).verdict is WarrantHealthVerdict.FLAG
    # raising the sample floor turns a smallish flag into a GAP (more evidence required)
    r = compute_warrant_health(40, {"weak-warrant": 20}, min_sample=100)
    assert r.verdict is WarrantHealthVerdict.GAP


def test_result_shape_and_defaults() -> None:
    r = compute_warrant_health(10, {"missing-justification": 2})
    assert r.sample_size == r.total == 12
    assert r.min_sample == DEFAULT_MIN_SAMPLE
    # zero-count categories are dropped from by_category
    assert compute_warrant_health(10, {"weak-warrant": 0}).by_category == {}


def test_rejects_bad_inputs() -> None:
    with pytest.raises(ValueError):
        compute_warrant_health(-1, {})
    with pytest.raises(ValueError):
        compute_warrant_health(10, {"x": -1})
    with pytest.raises(ValueError):
        compute_warrant_health(10, {}, threshold=0.0)
    with pytest.raises(ValueError):
        compute_warrant_health(10, {}, threshold=1.0)
