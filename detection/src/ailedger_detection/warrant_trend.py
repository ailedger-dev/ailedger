"""Warrant-health trend detection — CUSUM changepoint over a rate series.

A point-in-time threshold (warrant_health.py) answers "is the rate over budget
right now?" It misses a rate that *creeps upward* — an operator drifting from
1% to 4% unwarranted over months, never tripping a 5% threshold on any single
window. The CUSUM (cumulative sum control chart; Page, Biometrika 1954) is the
classic detector for exactly this: it accumulates small upward deviations from
a target and signals when the accumulation crosses a decision interval, far
sooner than a fixed threshold would.

One-sided upper CUSUM over a sequence of per-window rates x_1..x_n:

    S_0 = 0
    S_t = max(0, S_{t-1} + (x_t - (target + k)))   # k = allowance/slack
    signal at the first t where S_t > h            # h = decision interval

Defaults are conservative and **tighten-only** (lower target/k/h to detect
smaller, earlier drifts; never loosen).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

__all__ = [
    "DEFAULT_CUSUM_ALLOWANCE",
    "DEFAULT_CUSUM_INTERVAL",
    "DEFAULT_CUSUM_TARGET",
    "WarrantTrendResult",
    "cusum_upper",
]

#: In-control (acceptable) unwarranted rate the CUSUM measures drift from.
DEFAULT_CUSUM_TARGET: float = 0.02
#: Allowance (reference value) — deviations smaller than this don't accumulate.
DEFAULT_CUSUM_ALLOWANCE: float = 0.01
#: Decision interval — the CUSUM signals when it exceeds this.
DEFAULT_CUSUM_INTERVAL: float = 0.05


@dataclass(frozen=True)
class WarrantTrendResult:
    """Result of a one-sided upper CUSUM over a rate series."""

    flagged: bool
    """True if the CUSUM crossed the decision interval at any point."""

    change_at: int | None
    """Index of the first window where the CUSUM exceeded h (the changepoint), or None."""

    peak: float
    """The maximum CUSUM value reached."""

    target: float
    allowance: float
    interval: float
    cusum: tuple[float, ...] = field(default_factory=tuple)
    """The full CUSUM series, for inspectability/plotting."""


def cusum_upper(
    rates: Sequence[float],
    *,
    target: float = DEFAULT_CUSUM_TARGET,
    allowance: float = DEFAULT_CUSUM_ALLOWANCE,
    interval: float = DEFAULT_CUSUM_INTERVAL,
) -> WarrantTrendResult:
    """One-sided upper CUSUM over a sequence of per-window unwarranted rates.

    Detects an upward drift from ``target`` — a rising rate that a fixed
    threshold would not catch until it was much larger. Returns the first
    changepoint index and the full series.
    """
    if not 0.0 <= target < 1.0:
        raise ValueError("target must be in [0, 1)")
    if allowance < 0 or interval <= 0:
        raise ValueError("allowance must be >= 0 and interval > 0")
    if any(not 0.0 <= r <= 1.0 for r in rates):
        raise ValueError("rates must each be in [0, 1]")

    s = 0.0
    series: list[float] = []
    change_at: int | None = None
    peak = 0.0
    for i, x in enumerate(rates):
        s = max(0.0, s + (x - (target + allowance)))
        series.append(s)
        peak = max(peak, s)
        if change_at is None and s > interval:
            change_at = i

    return WarrantTrendResult(
        flagged=change_at is not None,
        change_at=change_at,
        peak=peak,
        target=target,
        allowance=allowance,
        interval=interval,
        cusum=tuple(series),
    )
