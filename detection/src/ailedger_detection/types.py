"""
Python type contracts mirroring the AILedger Detection Event schema.

These mirror @ailedger/sdk's TypeScript DetectionEvent and InferredDetectionEvent
(see sdk/src/types.ts). TypedDict is structural, so existing primitives that
take `dict[str, Any]` continue to work; this module gives them a typed shape
for static analysis and IDE assistance.

Authority: proxy/migrations/20260512_decision_events_schema.sql plus
proxy/migrations/20260518_inferred_detection_events.sql.
"""

from __future__ import annotations

from typing import Literal, NotRequired, TypedDict

# Method ladder per param canonicalization spec v1.0 §6
ExtractorMethod = Literal[
    "detection.parse",
    "detection.restructure",
    "detection.replay",
    "detection.perturb",
]

# Protected-class collection method per Annex III taxonomy
ProtectedClassCollectionMethod = Literal["direct", "inferred", "blind"]


class DetectionEvent(TypedDict):
    """
    Canonical (production-time) Detection Event row.

    Structural shape only; TypedDict is permissive. Primitives that take
    `dict[str, Any]` continue to work because dicts that match this shape
    pass the TypedDict structural check.
    """

    event_id: str
    timestamp: str
    tenant_id: str
    system_id: str

    model_version: NotRequired[str | None]
    model_weights_hash: NotRequired[str | None]
    decision_type: NotRequired[str | None]
    subject_id: NotRequired[str | None]
    inputs_hash: NotRequired[str | None]
    output: NotRequired[dict | None]
    confidence: NotRequired[float | None]
    human_in_loop: NotRequired[bool | None]
    protected_class_context: NotRequired[dict | None]
    protected_class_collection_method: NotRequired[ProtectedClassCollectionMethod | None]
    flags_raised: NotRequired[list[str]]
    required_actions: NotRequired[list[str]]
    actions_taken: NotRequired[list[str]]
    chain_spec_version: NotRequired[int]

    # Server-populated (DB trigger fields, present on rows fetched back)
    hash_chain_prev: NotRequired[str]
    hash_chain_self: NotRequired[str]


class InferredDetectionEvent(DetectionEvent):
    """
    Detection Event produced by one of the extraction-method rungs.

    Same row shape as DetectionEvent with the four extractor_* fields plus
    anchor_event_id plus extraction timestamps. Per spec §5, lives in the
    same ledger.decision_events table; distinguished by extractor_method
    field being non-null.
    """

    extractor_model: str
    extractor_method: ExtractorMethod
    extractor_params: dict
    extractor_params_hash: str
    anchor_event_id: str
    extraction_started_at: str
    extraction_compute_ms: int
