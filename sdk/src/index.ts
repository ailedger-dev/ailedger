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
export { computeExtractorParamsHash } from './canonicalize.js';
export { normalizeConfidence, normalizeTimestamp } from './normalize.js';
