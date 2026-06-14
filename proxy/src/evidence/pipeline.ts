// Evidence ingest pipeline — the public/private split, executed at ingest.
//
// For each decision event:
//   1. fresh per-event salt + DEK
//   2. PRIVATE payload (subject_id, inputs, output, context, actions, trace,
//      event_salt) sealed under the DEK → blob, payload_hash
//   3. DEK wrapped by the tenant KEK (AAD = payload_hash) → vault
//   4. ode-2 outbox item enqueued (record itself is built at DRAIN time,
//      where the single sequencer assigns prev_hash)
//
// Inference logs skip the vault (they carry hashes, not payloads) and queue
// for RFC 6962 batching.
//
// Portable module: webcrypto only, deps injected. Validation mirrors the
// legacy /v2/detection-events contract (UUID event_id, ISO-8601 timestamp,
// taxonomy decision_type) without importing legacy code.

import { generateDek, generateEventSalt, sealPayload, toHex } from '@ailedger/sdk';
import type { OutboxConfig, QueuedDecision, QueuedUnwarrant } from '../hedera/outbox.ts';
import { enqueue } from '../hedera/outbox.ts';
import { wrapDek, type KekProvider } from '../vault/kek.ts';
import type { VaultStore } from '../vault/types.ts';

export interface PipelineDeps {
  outbox: OutboxConfig;
  vault: VaultStore;
  keks: KekProvider;
}

export interface DecisionEventBody {
  event_id?: string;
  timestamp: string;
  decision_type: string;
  /** Pseudonymized upstream (HMAC). Phase 4 moves the HMAC fully client-side. */
  subject_id?: string;
  human_in_loop?: boolean;
  model_weights_hash?: string | null;
  inputs?: unknown;
  output: unknown;
  protected_class_context?: unknown;
  protected_class_collection_method?: string;
  flags_raised?: unknown[];
  required_actions?: unknown[];
  actions_taken?: unknown[];
  /** Supporting inference-log/call ids. */
  trace?: string[];
}

export interface InferenceLogBody {
  timestamp: string;
  [key: string]: unknown;
}

export class ValidationError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const HEX64 = /^[0-9a-f]{64}$/;

export function validateDecisionEvent(body: unknown): DecisionEventBody {
  if (typeof body !== 'object' || body === null) throw new ValidationError('body must be an object');
  const b = body as Record<string, unknown>;
  if (b.event_id !== undefined && !UUID_RE.test(String(b.event_id))) {
    throw new ValidationError('event_id must be a UUID');
  }
  if (!ISO_RE.test(String(b.timestamp))) {
    throw new ValidationError('timestamp must be ISO-8601');
  }
  if (typeof b.decision_type !== 'string' || b.decision_type.length === 0) {
    throw new ValidationError('decision_type is required');
  }
  if (b.output === undefined) throw new ValidationError('output is required');
  if (
    b.model_weights_hash !== undefined &&
    b.model_weights_hash !== null &&
    !HEX64.test(String(b.model_weights_hash))
  ) {
    throw new ValidationError('model_weights_hash must be 64-char hex or null');
  }
  return b as unknown as DecisionEventBody;
}

export interface IngestResult {
  eventId: string;
  payloadHash: string;
  status: 'queued';
}

export async function ingestDecisionEvent(
  deps: PipelineDeps,
  tenantRef: string,
  rawBody: unknown,
): Promise<IngestResult> {
  const body = validateDecisionEvent(rawBody);
  const eventId = body.event_id ?? crypto.randomUUID();
  const salt = generateEventSalt();
  const dek = generateDek();

  const commitInputs = {
    inputs: body.inputs ?? null,
    output: body.output,
    context: {
      protected_class_context: body.protected_class_context ?? null,
      collection_method: body.protected_class_collection_method ?? null,
    },
    actions: {
      flags_raised: body.flags_raised ?? [],
      required_actions: body.required_actions ?? [],
      actions_taken: body.actions_taken ?? [],
    },
    trace: body.trace ?? null,
  };

  // PRIVATE payload: everything sensitive + the salt that makes the on-chain
  // commitments verifiable (and erasable).
  const { blob, payloadHash } = await sealPayload(
    dek,
    {
      subject_id: body.subject_id ?? null,
      ...commitInputs,
      event_salt: toHex(salt),
    },
    eventId,
  );
  const kek = await deps.keks.getKek(tenantRef);
  const wrappedDek = await wrapDek(kek, dek, payloadHash);
  await deps.vault.put(tenantRef, payloadHash, { blob, wrappedDek });

  const item: QueuedDecision = {
    kind: 'decision',
    eventId,
    decisionType: body.decision_type,
    ts: body.timestamp,
    humanInLoop: body.human_in_loop ?? false,
    modelWeightsHash: body.model_weights_hash ?? null,
    commitInputs,
    saltHex: toHex(salt),
    payloadHash,
  };
  await enqueue(deps.outbox, tenantRef, item);
  return { eventId, payloadHash, status: 'queued' };
}

export interface UnwarrantBody {
  event_id?: string;
  timestamp: string;
  decision_type: string;
  unwarrant_category:
    | 'missing-justification'
    | 'empty-alternatives'
    | 'weak-warrant'
    | 'unresolved-obligation';
  /** The full attempted decision — sealed in the vault, committed on-chain. */
  attempt: unknown;
}

const UNWARRANT_CATEGORIES = new Set([
  'missing-justification',
  'empty-alternatives',
  'weak-warrant',
  'unresolved-obligation',
]);

export function validateUnwarrant(body: unknown): UnwarrantBody {
  if (typeof body !== 'object' || body === null) throw new ValidationError('body must be an object');
  const b = body as Record<string, unknown>;
  if (b.event_id !== undefined && !UUID_RE.test(String(b.event_id))) {
    throw new ValidationError('event_id must be a UUID');
  }
  if (!ISO_RE.test(String(b.timestamp))) throw new ValidationError('timestamp must be ISO-8601');
  if (typeof b.decision_type !== 'string' || !b.decision_type) {
    throw new ValidationError('decision_type is required');
  }
  if (!UNWARRANT_CATEGORIES.has(String(b.unwarrant_category))) {
    throw new ValidationError('unwarrant_category must be a known OWT category');
  }
  if (b.attempt === undefined) throw new ValidationError('attempt is required');
  return b as unknown as UnwarrantBody;
}

/**
 * Ingest an unwarranted decision (OWT): seal the attempt in the vault exactly
 * like a decision payload, enqueue an `ode-2u` for the tenant's own chain. The
 * refusal is recorded gap-honestly instead of dropped.
 */
export async function ingestUnwarrant(
  deps: PipelineDeps,
  tenantRef: string,
  rawBody: unknown,
): Promise<IngestResult> {
  const body = validateUnwarrant(rawBody);
  const eventId = body.event_id ?? crypto.randomUUID();
  const salt = generateEventSalt();
  const dek = generateDek();

  const { blob, payloadHash } = await sealPayload(
    dek,
    { attempt: body.attempt, unwarrant_category: body.unwarrant_category, event_salt: toHex(salt) },
    eventId,
  );
  const kek = await deps.keks.getKek(tenantRef);
  const wrappedDek = await wrapDek(kek, dek, payloadHash);
  await deps.vault.put(tenantRef, payloadHash, { blob, wrappedDek });

  const item: QueuedUnwarrant = {
    kind: 'unwarrant',
    eventId,
    decisionType: body.decision_type,
    ts: body.timestamp,
    unwarrantCategory: body.unwarrant_category,
    attempt: body.attempt,
    saltHex: toHex(salt),
    payloadHash,
  };
  await enqueue(deps.outbox, tenantRef, item);
  return { eventId, payloadHash, status: 'queued' };
}

export async function ingestInferenceLog(
  deps: PipelineDeps,
  tenantRef: string,
  rawBody: unknown,
): Promise<{ status: 'queued' }> {
  if (typeof rawBody !== 'object' || rawBody === null) {
    throw new ValidationError('body must be an object');
  }
  const body = rawBody as InferenceLogBody;
  if (!ISO_RE.test(String(body.timestamp))) {
    throw new ValidationError('timestamp must be ISO-8601');
  }
  await enqueue(deps.outbox, tenantRef, {
    kind: 'log',
    ts: body.timestamp,
    logRecord: body as Record<string, unknown>,
  });
  return { status: 'queued' };
}
