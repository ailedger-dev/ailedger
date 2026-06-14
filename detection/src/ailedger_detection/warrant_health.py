"""Warrant health — the per-operator unwarranted-rate verdict (OWT).

Aggregates a window of decisions into one signal: what fraction were
unwarranted, and is that within budget? The rate is a *warrant budget* in the
Google-SRE-error-budget sense — a tighten-only threshold of acceptable
unwarranted decisions; exceeding it escalates (FLAG).

The hard part is small samples. A naive "rate > threshold" flags an operator
who had 1 unwarranted decision out of 3 (rate 0.33) the same as one with
3,300 out of 10,000 — but the first is noise. So the verdict is rendered
through a **Wilson score interval** (Wilson 1927), which is well-behaved at
small n, and is **gap-honest**:

* **FLAG** — the interval's *lower* bound exceeds the threshold: even
  pessimistically the operator is over budget. Escalate.
* **PASS** — the interval's *upper* bound is at/below the threshold: even
  optimistically they are within budget.
* **GAP**  — the interval straddles the threshold, or the sample is below the
  floor: there is not enough evidence to render either verdict. Declared
  non-evaluable rather than guessed — never a small-sample false flag.

The threshold and minimum sample ship with defaults; customers TIGHTEN (lower
the threshold / raise the sample floor), never loosen.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import Enum

__all__ = [
    "DEFAULT_MIN_SAMPLE",
    "DEFAULT_UNWARRANT_THRESHOLD",
    "WILSON_Z_95",
    "WarrantHealthResult",
    "WarrantHealthVerdict",
    "compute_warrant_health",
    "wilson_interval",
]

#: Default unwarranted-rate budget. No regulatory figure exists for this; it is
#: a conservative policy default. Customers tighten (lower), never loosen.
DEFAULT_UNWARRANT_THRESHOLD: float = 0.05

#: Minimum window size below which a verdict is GAP (too little evidence to
#: judge an operator). Customers tighten (raise), never loosen.
DEFAULT_MIN_SAMPLE: int = 30

#: z for a 95% two-sided Wilson interval.
WILSON_Z_95: float = 1.959963984540054


class WarrantHealthVerdict(str, Enum):
    """The gap-honest verdict. Values are the frozen wire strings."""

    PASS = "PASS"
    FLAG = "FLAG"
    GAP = "GAP"


def wilson_interval(k: int, n: int, *, z: float = WILSON_Z_95) -> tuple[float, float]:
    """Wilson score confidence interval for a binomial proportion k/n.

    Returns (lower, upper), each clamped to [0, 1]. For n == 0 the interval is
    the whole unit interval (no information).
    """
    if k < 0 or n < 0 or k > n:
        raise ValueError(f"need 0 <= k <= n, got k={k}, n={n}")
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    z2 = z * z
    denom = 1.0 + z2 / n
    center = (p + z2 / (2 * n)) / denom
    margin = (z * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom
    return (max(0.0, center - margin), min(1.0, center + margin))


@dataclass(frozen=True)
class WarrantHealthResult:
    """Result of a warrant-health calculation over a window of decisions."""

    total: int
    """Window size = warranted + unwarranted (the denominator)."""

    unwarranted: int
    """Count of unwarranted decisions in the window."""

    rate: float
    """unwarranted / total (0.0 when total == 0). The point estimate."""

    by_category: dict[str, int]
    """Per-category unwarranted counts, for full inspectability."""

    threshold: float
    """Unwarranted-rate budget. FLAG when confidently exceeded."""

    sample_size: int
    """== total. Named for parity with the other detection results."""

    wilson_lower: float
    """Lower bound of the 95% Wilson interval on the rate."""

    wilson_upper: float
    """Upper bound of the 95% Wilson interval on the rate."""

    verdict: WarrantHealthVerdict
    """PASS (confidently within budget) / FLAG (confidently over) / GAP."""

    flagged: bool
    """True iff verdict == FLAG (confidently over budget)."""

    min_sample: int = field(default=DEFAULT_MIN_SAMPLE)
    """The sample floor below which the verdict is GAP."""


def compute_warrant_health(
    warranted: int,
    unwarranted_by_category: Mapping[str, int],
    *,
    threshold: float = DEFAULT_UNWARRANT_THRESHOLD,
    min_sample: int = DEFAULT_MIN_SAMPLE,
    z: float = WILSON_Z_95,
) -> WarrantHealthResult:
    """Render the gap-honest warrant-health verdict from counts.

    Takes counts (not records) because both the indexer and the verifier work
    from already-counted sealed records; this keeps the statistic pure.
    """
    if warranted < 0 or any(v < 0 for v in unwarranted_by_category.values()):
        raise ValueError("counts must be non-negative")
    if not 0.0 < threshold < 1.0:
        raise ValueError("threshold must be in (0, 1)")

    by_category = {k: int(v) for k, v in unwarranted_by_category.items() if v}
    unwarranted = sum(by_category.values())
    total = warranted + unwarranted
    rate = unwarranted / total if total else 0.0
    lower, upper = wilson_interval(unwarranted, total, z=z)

    if total < min_sample:
        verdict = WarrantHealthVerdict.GAP
    elif lower > threshold:
        verdict = WarrantHealthVerdict.FLAG
    elif upper <= threshold:
        verdict = WarrantHealthVerdict.PASS
    else:
        verdict = WarrantHealthVerdict.GAP

    return WarrantHealthResult(
        total=total,
        unwarranted=unwarranted,
        rate=rate,
        by_category=by_category,
        threshold=threshold,
        sample_size=total,
        wilson_lower=lower,
        wilson_upper=upper,
        verdict=verdict,
        flagged=verdict is WarrantHealthVerdict.FLAG,
        min_sample=min_sample,
    )
