"""
ailedger-detection — Open-source statistical primitives for AILedger Detection
Event chains.

Apache 2.0. See LICENSE.

Primitives shipped in v0.1.0:
- disparate_impact_ratio (four-fifths-rule baseline)
- statistical_parity_difference
- model_drift_between_versions
- confidence_stratified_outcome_analysis (stub)
- unresolved_flag_accumulation (stub)
- subject_repeated_decision_patterns (stub)

These primitives operate on Detection Event records as produced by the AILedger
Decision Events schema (proxy/migrations/20260512_decision_events_schema.sql)
plus inferred-event extension (proxy/migrations/20260518_inferred_detection_events.sql).

The Detection layer is intentionally Apache 2.0 + open-source so customers,
regulators, and adversarial reviewers can audit exactly what is being checked.
Detection thresholds are anchored to standards (four-fifths rule = 0.8 per
EEOC Uniform Guidelines); customers tighten, never loosen, per Charter v1.1.

Authority: gt-lab/docs/param-canonicalization-spec-v1.md +
gt-lab/docs/compliance-architecture/ARCHITECTURE-detection-taxonomy.md.
"""

from ailedger_detection.canonical import canonical, canonical_bytes
from ailedger_detection.confidence import confidence_stratified_outcome_analysis
from ailedger_detection.decision_event import (
    NO_LOOSER_ALTERNATIVE,
    DecisionEventRecord,
    IncompleteRationaleError,
    SeamSchemaError,
    canonical_digest,
    to_ingest_body,
    validate_decision_event,
)
from ailedger_detection.emitter import RelayEmitter, RelayError
from ailedger_detection.unwarrant import (
    WEAK_WARRANT_THRESHOLD,
    UnwarrantCategory,
    classify_unwarrant,
    to_unwarrant_ingest_body,
)
from ailedger_detection.warrant_health import (
    DEFAULT_MIN_SAMPLE,
    DEFAULT_UNWARRANT_THRESHOLD,
    WarrantHealthResult,
    WarrantHealthVerdict,
    compute_warrant_health,
    wilson_interval,
)
from ailedger_detection.disparate_impact import (
    DisparateImpactResult,
    disparate_impact_ratio,
)
from ailedger_detection.drift import (
    ModelDriftResult,
    model_drift_between_versions,
)
from ailedger_detection.parity import (
    StatisticalParityResult,
    statistical_parity_difference,
)
from ailedger_detection.repeated_decisions import subject_repeated_decision_patterns
from ailedger_detection.types import (
    DetectionEvent,
    ExtractorMethod,
    InferredDetectionEvent,
    ProtectedClassCollectionMethod,
)
from ailedger_detection.unresolved_flags import unresolved_flag_accumulation

__version__ = "0.3.0"

__all__ = [
    # Canonicalization + substrate ingest seam (v0.3.0)
    "canonical",
    "canonical_bytes",
    "canonical_digest",
    "validate_decision_event",
    "to_ingest_body",
    "DecisionEventRecord",
    "SeamSchemaError",
    "IncompleteRationaleError",
    "NO_LOOSER_ALTERNATIVE",
    "RelayEmitter",
    "RelayError",
    # OWT — unwarrant classification (open-standard reference impl)
    "classify_unwarrant",
    "to_unwarrant_ingest_body",
    "UnwarrantCategory",
    "WEAK_WARRANT_THRESHOLD",
    # OWT — warrant-health verdict (Wilson gap-honest)
    "compute_warrant_health",
    "wilson_interval",
    "WarrantHealthResult",
    "WarrantHealthVerdict",
    "DEFAULT_UNWARRANT_THRESHOLD",
    "DEFAULT_MIN_SAMPLE",
    # Type contracts
    "DetectionEvent",
    "InferredDetectionEvent",
    "ExtractorMethod",
    "ProtectedClassCollectionMethod",
    # v0.1.0 production primitives
    "DisparateImpactResult",
    "disparate_impact_ratio",
    "StatisticalParityResult",
    "statistical_parity_difference",
    "ModelDriftResult",
    "model_drift_between_versions",
    # v0.2.0 stubs (will raise NotImplementedError; designed for v0.3.0)
    "confidence_stratified_outcome_analysis",
    "unresolved_flag_accumulation",
    "subject_repeated_decision_patterns",
    "__version__",
]
