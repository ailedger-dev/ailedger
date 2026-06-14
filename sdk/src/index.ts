// AILedger SDK — public API surface
//
// Implements the producer-side boundary per param canonicalization spec v1.0
// (Jake-ratified 2026-05-18 at gt-lab/docs/param-canonicalization-spec-v1.md).
//
// v0.1.0 skeleton — type contracts + canonicalization + normalization +
// client surface. Transport layer is a stub. Production wire-up lands in
// v0.2.0 once integration test scaffolding is in place.

export { DetectionEventClient } from './client.js';
export type { DetectionEventClientConfig } from './client.js';

export {
  AILedgerError,
  AILedgerAuthError,
  AILedgerForbiddenError,
  AILedgerRateLimitError,
  AILedgerServerError,
  AILedgerTransportError,
  AILedgerValidationError,
} from './errors.js';

export type {
  DetectionEvent,
  InferredDetectionEvent,
  ExtractorMethod,
  ExtractorParams,
  ProtectedClassCollectionMethod,
  ChainSpecVersion,
  DetectionParseParams,
  DetectionRestructureParams,
  DetectionReplayParams,
  DetectionPerturbParams,
} from './types.js';

export { computeInputsHash, sha256hex, sha256jcs, isJsonContentType } from './hash.js';

// Evidence core — the shared emitter primitives for the Hedera rails
// (ode-2 on-chain records, RFC 6962 batching, payload envelope). Consumed by
// the relay, the verifier, and the aDNA adapter. See docs/adr/016.
export {
  buildBatchRecord,
  buildDecisionRecord,
  buildUnwarrantRecord,
  commitField,
  encodeRecord,
  generateEventSalt,
  verifyFieldCommitment,
  GENESIS_PREV_HASH,
  MAX_RECORD_BYTES,
  ODE_BATCH_VERSION,
  ODE_DECISION_VERSION,
  ODE_UNWARRANT_VERSION,
} from './evidence/record.js';
export type {
  BuildBatchRecordParams,
  BuildDecisionRecordParams,
  BuildUnwarrantRecordParams,
  DecisionCommitInputs,
  OdeBatchRecord,
  OdeDecisionRecord,
  OdeUnwarrantRecord,
  UnwarrantCategory,
} from './evidence/record.js';
export {
  encodeLeaf,
  fromHex,
  inclusionProof,
  leafHash,
  merkleRoot,
  merkleRootHex,
  toHex,
  verifyInclusion,
} from './evidence/merkle.js';
export {
  generateDek,
  openPayload,
  payloadHashOf,
  sealPayload,
  DEK_BYTES,
  ENVELOPE_VERSION,
} from './evidence/envelope.js';
export type { SealedPayload } from './evidence/envelope.js';
export { computeExtractorParamsHash } from './canonicalize.js';
export { normalizeConfidence, normalizeTimestamp } from './normalize.js';

// Extractors — 4-rung method ladder (v0.2.0: parse full impl + rungs 2-4
// scaffolds, all caller-supplied LLMClient)
export {
  parseExtractor,
  parseExplicitChoice,
  parseConfidence,
  makeRestructureExtractor,
  makeReplayExtractor,
  makePerturbExtractor,
} from './extractors/index.js';
export type {
  LLMClient,
  DecisionTrace,
  ExtractionResult,
  ExtractionStatus,
  Extractor,
} from './extractors/index.js';
