// AILedger SDK — DetectionEventClient
//
// Minimum viable client surface for Detection Event emission per spec v1.0.
// Producer-facing API. SDK responsibilities per spec §9:
//   - Compute inputs_hash client-side (raw inputs never transmitted)
//   - Normalize confidence to 4-decimal precision
//   - Emit structured Detection Event
//   - For inferred events: emit extractor_* fields + anchor_event_id, with
//     extractor_params_hash computed client-side
//   - Never compute hash_chain_*; populated by DB trigger
//
// Transport layer is a stub here. v0.1.0 ships type contract + canonicalization
// + normalization. Actual HTTP transport to AILedger proxy lands when the
// SDK is wired into a deployment.

import { computeInputsHash } from './hash.js';
import { computeExtractorParamsHash } from './canonicalize.js';
import { normalizeConfidence, normalizeTimestamp } from './normalize.js';
import {
  AILedgerAuthError,
  AILedgerForbiddenError,
  AILedgerRateLimitError,
  AILedgerServerError,
  AILedgerTransportError,
  AILedgerValidationError,
} from './errors.js';
import type {
  DetectionEvent,
  InferredDetectionEvent,
  ExtractorMethod,
  ExtractorParams,
} from './types.js';

/** Response shape from POST /v2/detection-events */
interface IngestResponse {
  event: Record<string, unknown> | null;
  deduped?: boolean;
}

export interface DetectionEventClientConfig {
  /** AILedger proxy base URL (e.g. https://proxy.ailedger.dev) */
  baseUrl: string;
  /** Tenant API key (x-ailedger-key header) */
  apiKey: string;
  /** Required tenant UUID; matches the key */
  tenantId: string;
  /** System UUID for this client's deployment */
  systemId: string;
}

/**
 * Producer-facing API for emitting Detection Events.
 *
 * Construct once per (tenant, system) pair. Each emit call computes the
 * client-side fields per spec §9 and POSTs the structured event to the
 * AILedger proxy ingest endpoint.
 *
 * The DB trigger populates hash_chain_prev + hash_chain_self atomically
 * at INSERT time. The SDK does not see chain state directly; clients that
 * need to verify can fetch the row back and re-compute via the dispatcher
 * function.
 */
export class DetectionEventClient {
  private config: DetectionEventClientConfig;

  constructor(config: DetectionEventClientConfig) {
    this.config = config;
  }

  /**
   * Emit a canonical (production-time) Detection Event.
   *
   * SDK computes inputs_hash + normalizes confidence + normalizes timestamp.
   * Caller supplies the structured decision content (output, protected-class
   * context, flags, required_actions, actions_taken).
   *
   * @param input.rawInputs The raw decision inputs (object hashed via JCS, or
   *   bytes/string hashed via sha256jcs path). NEVER transmitted to AILedger.
   * @param input.rawInputsContentType Content-Type hint if rawInputs is bytes.
   *   Defaults to "application/json" for object inputs.
   */
  async emit(input: {
    eventId: string;
    timestamp?: Date | string;
    rawInputs: Record<string, unknown> | ArrayBuffer | string | null;
    rawInputsContentType?: string;
    modelVersion?: string;
    modelWeightsHash?: string;
    decisionType?: string;
    subjectId?: string;
    output?: Record<string, unknown>;
    confidence?: number;
    humanInLoop?: boolean;
    protectedClassContext?: Record<string, unknown>;
    protectedClassCollectionMethod?: 'direct' | 'inferred' | 'blind';
    flagsRaised?: string[];
    requiredActions?: string[];
    actionsTaken?: string[];
  }): Promise<DetectionEvent> {
    const inputsHash = await computeInputsHash(input.rawInputs, input.rawInputsContentType);
    const event: DetectionEvent = {
      event_id: input.eventId,
      timestamp: normalizeTimestamp(input.timestamp ?? new Date()),
      tenant_id: this.config.tenantId,
      system_id: this.config.systemId,
      model_version: input.modelVersion ?? null,
      model_weights_hash: input.modelWeightsHash ?? null,
      decision_type: input.decisionType ?? null,
      subject_id: input.subjectId ?? null,
      inputs_hash: inputsHash,
      output: input.output ?? null,
      confidence: normalizeConfidence(input.confidence ?? null),
      human_in_loop: input.humanInLoop ?? null,
      protected_class_context: input.protectedClassContext ?? null,
      protected_class_collection_method: input.protectedClassCollectionMethod ?? null,
      flags_raised: input.flagsRaised ?? [],
      required_actions: input.requiredActions ?? [],
      actions_taken: input.actionsTaken ?? [],
      chain_spec_version: 2,
    };
    const populated = await this.transport(event);
    if (populated) {
      // Merge server-populated fields (hash_chain_prev, hash_chain_self) back
      // into the returned event so callers see chain state.
      return { ...event, ...populated } as DetectionEvent;
    }
    return event;
  }

  /**
   * Emit an inferred Detection Event from one of the extraction-method rungs.
   *
   * SDK computes extractor_params_hash from the canonical-serialized params
   * per spec §7.2. Caller supplies the anchor event_id pointing to the
   * canonical Detection Event being extracted from, plus the extraction
   * results.
   */
  async emitInferred(input: {
    eventId: string;
    timestamp?: Date | string;
    anchorEventId: string;
    extractorMethod: ExtractorMethod;
    extractorModel: string;
    extractorParams: ExtractorParams;
    extractionStartedAt: Date | string;
    extractionComputeMs: number;
    output?: Record<string, unknown>;
    confidence?: number;
    flagsRaised?: string[];
    requiredActions?: string[];
    actionsTaken?: string[];
  }): Promise<InferredDetectionEvent> {
    const extractorParamsHash = await computeExtractorParamsHash(
      input.extractorMethod,
      input.extractorParams,
    );
    const inferred: InferredDetectionEvent = {
      event_id: input.eventId,
      timestamp: normalizeTimestamp(input.timestamp ?? new Date()),
      tenant_id: this.config.tenantId,
      system_id: this.config.systemId,
      anchor_event_id: input.anchorEventId,
      extractor_method: input.extractorMethod,
      extractor_model: input.extractorModel,
      extractor_params: input.extractorParams as unknown as Record<string, unknown>,
      extractor_params_hash: extractorParamsHash,
      extraction_started_at: normalizeTimestamp(input.extractionStartedAt),
      extraction_compute_ms: input.extractionComputeMs,
      output: input.output ?? null,
      confidence: normalizeConfidence(input.confidence ?? null),
      flags_raised: input.flagsRaised ?? [],
      required_actions: input.requiredActions ?? [],
      actions_taken: input.actionsTaken ?? [],
      chain_spec_version: 2,
    };
    const populated = await this.transport(inferred);
    if (populated) {
      return { ...inferred, ...populated } as InferredDetectionEvent;
    }
    return inferred;
  }

  /**
   * Transport: POST the Detection Event to {baseUrl}/v2/detection-events.
   *
   * Returns the populated row from the proxy response (with hash_chain_prev +
   * hash_chain_self computed by the DB trigger). Throws a typed error for
   * non-2xx responses so callers can handle auth / validation / rate-limit /
   * server failures distinctly.
   *
   * Retry policy: NOT implemented in v0.2.0. The caller is responsible for
   * retry on AILedgerServerError and AILedgerRateLimitError. v0.2.1 follow-up
   * adds opt-in exponential backoff + durable-buffer fallback.
   */
  private async transport(
    event: DetectionEvent | InferredDetectionEvent,
  ): Promise<Record<string, unknown> | null> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/v2/detection-events`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ailedger-key': this.config.apiKey,
        },
        body: JSON.stringify(event),
      });
    } catch (err) {
      throw new AILedgerTransportError(
        `Failed to reach AILedger proxy at ${url}`,
        err,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text();
    }

    if (response.status === 200 || response.status === 201) {
      const ingestBody = body as IngestResponse;
      return ingestBody.event;
    }

    if (response.status === 400 || response.status === 422) {
      throw new AILedgerValidationError(
        `Invalid Detection Event payload (HTTP ${response.status})`,
        response.status,
        body,
      );
    }

    if (response.status === 401) {
      throw new AILedgerAuthError('AILedger rejected the API key', body);
    }

    if (response.status === 403) {
      throw new AILedgerForbiddenError(
        'AILedger rejected the tenant ownership claim',
        body,
      );
    }

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : null;
      throw new AILedgerRateLimitError(
        'AILedger usage limit reached',
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
        body,
      );
    }

    if (response.status >= 500) {
      throw new AILedgerServerError(
        `AILedger proxy returned ${response.status}`,
        response.status,
        body,
      );
    }

    throw new AILedgerValidationError(
      `Unexpected response from AILedger proxy (HTTP ${response.status})`,
      response.status,
      body,
    );
  }
}
