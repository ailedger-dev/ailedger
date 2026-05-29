# ailedger-detection

Open-source statistical primitives for AILedger Detection Event chains.

**Version:** 0.2.0
**License:** Apache 2.0 (per posture v2; customer + regulator + adversarial-reviewer auditable)
**Python:** 3.10+
**Author:** Jake Joyner / Joyner Ventures LLC
**Charter:** https://ailedger.dev/charter

---

## What this is

The Apache-2.0 Detection layer of AILedger. The open-source artifact that customers, regulators, and adversarial reviewers can read, audit, and run independently against any Detection Event chain.

Per the AILedger Charter anti-theater commitments:
- Detection thresholds are anchored to published standards (EEOC four-fifths rule = 0.8; Federal Reserve SR 11-7 / OCC 2011-12 PSI ladder)
- Customers TIGHTEN thresholds (toward stricter detection), never loosen
- Per-customer detection disablement is REFUSED at the schema level
- "Compliance mode" that bypasses detection is REFUSED at the schema level

This package is the substrate that makes those commitments verifiable.

## What v0.2.0 ships

Three production statistical primitives:

- `disparate_impact_ratio` — four-fifths-rule baseline (EEOC Uniform Guidelines 29 CFR 1607). Returns minimum cross-group positive-outcome ratio + flag.
- `statistical_parity_difference` — absolute difference between group positive-outcome rates. Complementary to disparate impact ratio (stable when one group has very low rates).
- `model_drift_between_versions` — Population Stability Index (PSI) across decision type distribution between two cohorts. Fed/OCC threshold ladder.

Typed contracts:

- `DetectionEvent` and `InferredDetectionEvent` TypedDicts mirroring `ledger.decision_events` schema + the 2026-05-18 inferred-event extension (matches `@ailedger/sdk` TypeScript types)
- `ExtractorMethod` Literal type for the 4-rung method ladder
- `ProtectedClassCollectionMethod` Literal type (`direct` / `inferred` / `blind`)

TypedDict is structural, so existing callers passing untyped `dict` continue to work; the types add static-analysis + IDE assistance without runtime cost.

Three additional primitives stubbed for v0.3.0:

- `confidence_stratified_outcome_analysis` — outcome distribution sliced by confidence bucket
- `unresolved_flag_accumulation` — pattern detection on flags raised but never resolved
- `subject_repeated_decision_patterns` — repeated-decision detection at subject level

Each stub raises `NotImplementedError` with a pointer to the open design questions in its module docstring.

## Test coverage

v0.2.0 ships:

- `tests/test_disparate_impact.py` — 8 tests covering baseline / threshold / borderline / custom-tighter / single-group / no-positive-outcomes / invalid-threshold / inspectable-stats
- `tests/test_parity.py` — 7 tests covering parity / large gap / borderline / custom-threshold / invalid-threshold / disparate-impact complement / single-group
- `tests/test_drift.py` — 9 tests covering Fed/OCC threshold ladder / no-drift / moderate / significant / custom-extractor / empty cohorts / invalid thresholds / new-bucket / sum-to-psi
- `tests/test_stubs.py` — 3 tests confirming stubs raise NotImplementedError with v0.3.0 pointer

Total: 27 tests. Run with `pytest`.

## Why these specific primitives

Per `gt-lab/docs/compliance-architecture/ARCHITECTURE-detection-taxonomy.md` and the strategic pivot validation, the v0.1.0 set covers the three failure modes most likely to surface in adversarial review:

1. **Disparate impact** is the load-bearing primitive for Federal Rule 707 admissibility in employment + credit + insurance discrimination cases. The four-fifths rule is the standard a plaintiff's expert will run.
2. **Statistical parity** is the complementary view favored by EU AI Act Article 26 (deployer obligations) and academic fairness literature.
3. **Model drift** is the load-bearing primitive for FDIC-regulated AI model governance and for rare-disease research integrity (was the model that produced these decisions the same as the model under review?).

## Install

```
pip install ailedger-detection
```

## Usage

```python
from ailedger_detection import (
    disparate_impact_ratio,
    statistical_parity_difference,
    model_drift_between_versions,
)

# events: an iterable of Detection Event records (dicts) from the
# AILedger ledger.decision_events table.
# Each record is expected to carry protected_class_context (JSONB).

result = disparate_impact_ratio(
    events,
    protected_class_key="race",
    positive_outcome_predicate=lambda e: e["output"]["decision"] == "hire",
)

print(f"Ratio: {result.ratio:.3f}")
print(f"Flagged: {result.flagged}")
print(f"High group: {result.high_group} ({result.high_rate:.3f})")
print(f"Low group: {result.low_group} ({result.low_rate:.3f})")
```

## Charter posture

This package's threshold defaults follow the AILedger Charter:

| Primitive | Default threshold | Source | Customer can tighten? | Customer can loosen? |
|---|---|---|---|---|
| `disparate_impact_ratio` | 0.80 | EEOC Uniform Guidelines (29 CFR 1607) | Yes (raise toward 1.0) | **No** |
| `statistical_parity_difference` | 0.10 | AILedger default | Yes (lower toward 0) | **No** |
| `model_drift_between_versions` | PSI ≥ 0.25 = action | Federal Reserve SR 11-7 / OCC 2011-12 | Yes (lower action threshold) | **No** |

A consumer call site that passes a looser threshold receives a `ValueError`. The refusal is structural, not policy.

## Spec linkage

- Detection Event schema: `proxy/migrations/20260512_decision_events_schema.sql`
- Param canonicalization spec: `gt-lab/docs/param-canonicalization-spec-v1.md`
- Detection taxonomy: `gt-lab/docs/compliance-architecture/ARCHITECTURE-detection-taxonomy.md`
- Charter: [ailedger-dev/charter/CHARTER.md](https://github.com/ailedger-dev/charter/blob/main/CHARTER.md)

## Testing

```
cd detection
pip install -e ".[test]"
pytest
```

## What this is NOT

- Not a turn-key AI compliance product. The primitives are the substrate; consumers apply them against their own Detection Event streams with their own decision-domain-specific predicates.
- Not the integrity layer. The hash chain lives in `proxy/migrations/`; this package does not verify chain integrity, only statistics over the events.
- Not the only package. The producer-side SDK is at `sdk/` (`@ailedger/sdk` v0.1.0 TypeScript).

## Repo posture (separate repo planned)

Per AILedger posture v2 (`gt-lab/memory/project_ailedger_posture_v2_2026_05_12.md`), the Detection layer ships as a SEPARATE public repo from day one. v0.1.0 lives in the ailedger monorepo for development convenience; extraction to `github.com/jakejjoyner/ailedger-detection` (or canonical equivalent) is bead `hq-77p` work and gates the public-differentiation claim.

The Apache 2.0 license is unchanged when the package extracts to its own repo. Issue tracking and contributions migrate at extraction time.

## Authority

- Spec: `gt-lab/docs/param-canonicalization-spec-v1.md`
- Posture: `gt-lab/memory/project_ailedger_posture_v2_2026_05_12.md`
- Charter: [ailedger-dev/charter/CHARTER.md](https://github.com/ailedger-dev/charter/blob/main/CHARTER.md)
- Competitive matrix: `gt-lab/docs/ailedger-competitive-matrix-v2.md`
