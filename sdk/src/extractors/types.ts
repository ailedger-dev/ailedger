// Extractor module — types
//
// The 4-rung extraction method ladder per param canonicalization spec v1.0
// (gt-lab/docs/param-canonicalization-spec-v1.md) and the HANDOFF docs
// (gt-lab/docs/compliance-architecture/HANDOFF-decision-event-layer.md).
//
// Producer-side: SDK callers EMIT canonical Detection Events at production
// time using DetectionEventClient.emit().
//
// Audit-side: this module EXTRACTS inferred Detection Events from existing
// canonical events. Each rung produces a separate chain entry with
// extractor_* fields set; never amends the canonical event (per spec §5
// canonical/inferred separation).

import type {
  DetectionEvent,
  InferredDetectionEvent,
  ExtractorMethod,
  DetectionParseParams,
  DetectionRestructureParams,
  DetectionReplayParams,
  DetectionPerturbParams,
} from '../types.js';

/** Result envelope for an extraction call. The extractor returns a structured
 * InferredDetectionEvent that the caller posts via
 * DetectionEventClient.emitInferred(). */
export interface ExtractionResult {
  /** Canonical event the extraction is anchored to */
  anchorEventId: string;
  /** Which rung produced this result */
  extractorMethod: ExtractorMethod;
  /** Model + version that did the extraction (e.g. "claude-haiku-4-5-20251001") */
  extractorModel: string;
  /** Extractor params (canonical-serialized hash computed downstream by the SDK) */
  extractorParams: DetectionParseParams | DetectionRestructureParams | DetectionReplayParams | DetectionPerturbParams;
  /** Structured output payload to attach to the inferred event */
  output: Record<string, unknown>;
  /** Extraction confidence; SDK normalizes to 4-decimal precision before emit */
  confidence: number | null;
  /** Wall-clock when the extraction job started */
  startedAt: Date;
  /** Wall-clock when the extraction job completed (for compute_ms calculation) */
  completedAt: Date;
}

/** A trace slice the extractor reads from a canonical Detection Event.
 * Producers vary in what they attach to `output`; the extractor needs a
 * common shape for the things it can parse. */
export interface DecisionTrace {
  /** Required: chain-of-thought or structured-output text. Empty string if not
   * captured at production time (a downstream extractor may then have nothing
   * to parse and should return ExtractionStatus.NoTraceAvailable). */
  rawText: string;
  /** Optional structured tool-call sequence (e.g. function-calling events) */
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown>; result?: unknown }>;
  /** Optional model-version + weights hash for reference (passes through to
   * extractor metadata) */
  modelVersion?: string;
  modelWeightsHash?: string;
}

/** Extraction status returned alongside the result (for stub-detection at
 * call sites; lets callers skip noop extractions). */
export type ExtractionStatus = 'ok' | 'no-trace-available' | 'rejected-by-rules';

/** Extractor contract: anchored to a canonical Detection Event, takes a trace
 * + params, produces a result + status. */
export interface Extractor<P> {
  method: ExtractorMethod;
  extract(
    canonical: DetectionEvent,
    trace: DecisionTrace,
    params: P,
  ): Promise<{ result: ExtractionResult; status: ExtractionStatus } | { result: null; status: Exclude<ExtractionStatus, 'ok'> }>;
}

export type { InferredDetectionEvent };
