// AILedger SDK — ode-2 public evidence record (the on-chain tier).
//
// Every decision event splits into two halves:
//   PUBLIC  — this record: ≤1024 canonical bytes on the tenant's HCS topic.
//             Cleartext structural fields + per-event SALTED commitments.
//   PRIVATE — the full decision event (subject_id, protected_class_context,
//             output, …) envelope-encrypted in a customer-controllable vault,
//             bound to this record by payload_hash = SHA-256(ciphertext blob).
//
// Privacy invariants (ADR-016 / plan §decisions, locked 2026-06-12):
//   * subject_id NEVER appears on-chain in any form (a stable HMAC pseudonym
//     is linkable personal data under GDPR).
//   * Commitments are hiding: SHA-256(salt ‖ field-name ‖ ':' ‖ JCS(value))
//     with a fresh per-event 32-byte salt stored ONLY inside the encrypted
//     payload. Bare hashes of low-entropy structured values are dictionary-
//     attackable; the salt kills that and cross-event correlation. The field
//     name in the preimage is domain separation: equal values in different
//     fields must not produce visibly equal commitments.
//   * Erasure = destroy the payload DEK + salt; every on-chain trace of the
//     event becomes informationless, and the ciphertext itself is physically
//     deletable from the vault.
//
// The `profile` field is reserved: 'lean' ships now; 'digest' (existence/
// order/time only) lands later as an opt-in per-tenant confidentiality
// profile — additive, not a migration.

import canonicalize from 'canonicalize';
import { encodeLeaf } from './merkle.js';

export const ODE_DECISION_VERSION = 'ode-2' as const;
export const ODE_BATCH_VERSION = 'ode-2b' as const;
export const ODE_CHECKPOINT_VERSION = 'chk-1' as const;
/**
 * Leaf contract for a checkpoint: one leaf per tenant topic head,
 * leaf bytes = UTF-8(JCS({ running_hash, sequence_number, topic_id })). The
 * running_hash is Hedera's own SHA-384 network running hash at that topic's
 * head — the strongest possible commitment to a tenant Logbook's state, taken
 * straight from consensus, not the advisory app prev_hash.
 */
export const CHECKPOINT_LEAF_SPEC = 'rfc6962-sha256/jcs-tenant-head-v1' as const;
/** Hard cap on the canonical byte length of one on-chain record (one HCS message). */
export const MAX_RECORD_BYTES = 1024;
export const EVENT_SALT_BYTES = 32;
export const GENESIS_PREV_HASH = '0'.repeat(64);

const HEX64 = /^[0-9a-f]{64}$/;

/** The lean ode-2 decision record — exactly what goes on-chain. */
export interface OdeDecisionRecord {
  v: typeof ODE_DECISION_VERSION;
  profile: 'lean';
  event_id: string;
  decision_type: string;
  ts: string;
  prev_hash: string;
  human_in_loop: boolean;
  /** Already a hash upstream (model reproducibility) — safe in cleartext. */
  model_weights_hash: string | null;
  inputs_commit: string;
  output_commit: string;
  /** protected_class_context + collection method — committed, never cleartext. */
  context_commit: string;
  /** {flags_raised, required_actions, actions_taken} as one committed group. */
  actions_commit: string;
  /**
   * Commitment over the supporting inference-log id list. Forward references
   * to batch roots are impossible (batches seal later), so the chain carries
   * a commitment to the trace and the indexer materializes decision↔batch
   * linkage after sealing. Null when the decision has no recorded trace.
   */
  trace_commit: string | null;
  /** SHA-256 of the encrypted private-payload blob (ciphertext addressing). */
  payload_hash: string;
}

/** The ode-2b inference-log batch record — one per tenant per interval. */
export interface OdeBatchRecord {
  v: typeof ODE_BATCH_VERSION;
  batch_id: string;
  prev_hash: string;
  /** RFC 6962 SHA-256 Merkle root over the batch's leaves. */
  merkle_root: string;
  leaf_count: number;
  range: { from_ts: string; to_ts: string };
  /** Leaf preimage contract: leaf bytes = UTF-8(JCS(log record)). */
  leaf_spec: 'rfc6962-sha256/jcs-v1';
}

/**
 * The chk-1 cross-topic checkpoint record — one per operator per interval on
 * the public `checkpoints` topic. Anchors a single RFC 6962 Merkle root over
 * every tenant topic's head (its network running hash at a sequence number),
 * so one constant-size record witnesses the whole estate's state at a point in
 * consensus time. The ordered head list (the leaves) lives in an off-chain
 * checkpoint manifest, exactly like a batch's leaves — the verifier recomputes
 * the root from the manifest and FAILs on mismatch.
 */
export interface OdeCheckpointRecord {
  v: typeof ODE_CHECKPOINT_VERSION;
  prev_hash: string;
  ts: string;
  /** Window this checkpoint summarizes (advisory; consensus ts is authoritative). */
  period: { from_ts: string; to_ts: string };
  /** RFC 6962 SHA-256 Merkle root over the per-tenant head leaves. */
  tenant_root: string;
  tenant_count: number;
  leaf_spec: typeof CHECKPOINT_LEAF_SPEC;
}

/** The sensitive halves of a decision event, committed (not stored) on-chain. */
export interface DecisionCommitInputs {
  inputs: unknown;
  output: unknown;
  context: unknown;
  actions: unknown;
  /** Supporting inference-log ids (or null when untraced). */
  trace: unknown | null;
}

export interface BuildDecisionRecordParams {
  eventId: string;
  decisionType: string;
  ts: string;
  prevHash: string;
  humanInLoop: boolean;
  modelWeightsHash: string | null;
  commitInputs: DecisionCommitInputs;
  /** Per-event salt; generate with generateEventSalt(). Lives only in the payload. */
  salt: Uint8Array;
  /** SHA-256 hex of the sealed payload blob (see evidence/envelope.ts). */
  payloadHash: string;
}

/** Fresh per-event salt. Stored inside the encrypted payload, never on-chain. */
export function generateEventSalt(): Uint8Array {
  const salt = new Uint8Array(EVENT_SALT_BYTES);
  crypto.getRandomValues(salt);
  return salt;
}

/**
 * Hiding commitment: SHA-256( salt ‖ UTF-8(fieldName) ‖ 0x3A ‖ UTF-8(JCS(value)) ),
 * hex-lowercase. The fieldName segment is domain separation.
 */
export async function commitField(
  salt: Uint8Array,
  fieldName: string,
  value: unknown,
): Promise<string> {
  if (salt.byteLength !== EVENT_SALT_BYTES) {
    throw new Error(`event salt must be ${EVENT_SALT_BYTES} bytes, got ${salt.byteLength}`);
  }
  const jcs = canonicalize(value as Parameters<typeof canonicalize>[0]);
  if (jcs === undefined) {
    throw new Error(`field ${fieldName} is not JCS-serializable`);
  }
  const enc = new TextEncoder();
  const name = enc.encode(fieldName);
  const body = enc.encode(jcs);
  const preimage = new Uint8Array(salt.byteLength + name.byteLength + 1 + body.byteLength);
  preimage.set(salt, 0);
  preimage.set(name, salt.byteLength);
  preimage[salt.byteLength + name.byteLength] = 0x3a;
  preimage.set(body, salt.byteLength + name.byteLength + 1);
  const digest = await crypto.subtle.digest('SHA-256', preimage);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Recompute-and-compare for auditors holding the payload (salt + values). */
export async function verifyFieldCommitment(
  salt: Uint8Array,
  fieldName: string,
  value: unknown,
  expectedCommit: string,
): Promise<boolean> {
  return (await commitField(salt, fieldName, value)) === expectedCommit.toLowerCase();
}

/** Canonical on-chain encoding of a record (the exact HCS message bytes). */
export function encodeRecord(
  record: OdeDecisionRecord | OdeBatchRecord | OdeCheckpointRecord,
): Uint8Array {
  const jcs = canonicalize(record as Parameters<typeof canonicalize>[0]);
  if (jcs === undefined) throw new Error('record is not JCS-serializable');
  return new TextEncoder().encode(jcs);
}

function assertHex64(label: string, value: string): void {
  if (!HEX64.test(value)) throw new Error(`${label} must be 64 lowercase hex chars`);
}

/**
 * Build the lean on-chain record for one decision event.
 *
 * Throws if the canonical encoding exceeds MAX_RECORD_BYTES — oversize public
 * records are rejected, never chunked (one event = one HCS message = one
 * sequence number; the Logbook stays a clean linear chain).
 */
export async function buildDecisionRecord(
  params: BuildDecisionRecordParams,
): Promise<{ record: OdeDecisionRecord; encoded: Uint8Array }> {
  assertHex64('prevHash', params.prevHash);
  assertHex64('payloadHash', params.payloadHash);
  if (params.modelWeightsHash !== null) assertHex64('modelWeightsHash', params.modelWeightsHash);

  const { commitInputs: c, salt } = params;
  const record: OdeDecisionRecord = {
    v: ODE_DECISION_VERSION,
    profile: 'lean',
    event_id: params.eventId,
    decision_type: params.decisionType,
    ts: params.ts,
    prev_hash: params.prevHash,
    human_in_loop: params.humanInLoop,
    model_weights_hash: params.modelWeightsHash,
    inputs_commit: await commitField(salt, 'inputs', c.inputs),
    output_commit: await commitField(salt, 'output', c.output),
    context_commit: await commitField(salt, 'context', c.context),
    actions_commit: await commitField(salt, 'actions', c.actions),
    trace_commit: c.trace === null ? null : await commitField(salt, 'trace', c.trace),
    payload_hash: params.payloadHash,
  };

  const encoded = encodeRecord(record);
  if (encoded.byteLength > MAX_RECORD_BYTES) {
    throw new Error(
      `encoded record is ${encoded.byteLength} bytes > ${MAX_RECORD_BYTES} hard cap ` +
        '(oversize records are rejected, never chunked)',
    );
  }
  return { record, encoded };
}

export interface BuildBatchRecordParams {
  batchId: string;
  prevHash: string;
  merkleRoot: string;
  leafCount: number;
  fromTs: string;
  toTs: string;
}

/** Build the ode-2b batch record anchoring one inference-log Merkle root. */
export function buildBatchRecord(params: BuildBatchRecordParams): {
  record: OdeBatchRecord;
  encoded: Uint8Array;
} {
  assertHex64('prevHash', params.prevHash);
  assertHex64('merkleRoot', params.merkleRoot);
  if (!Number.isInteger(params.leafCount) || params.leafCount < 1) {
    throw new Error('leafCount must be a positive integer');
  }
  const record: OdeBatchRecord = {
    v: ODE_BATCH_VERSION,
    batch_id: params.batchId,
    prev_hash: params.prevHash,
    merkle_root: params.merkleRoot,
    leaf_count: params.leafCount,
    range: { from_ts: params.fromTs, to_ts: params.toTs },
    leaf_spec: 'rfc6962-sha256/jcs-v1',
  };
  const encoded = encodeRecord(record);
  if (encoded.byteLength > MAX_RECORD_BYTES) {
    throw new Error(`encoded batch record is ${encoded.byteLength} bytes > ${MAX_RECORD_BYTES}`);
  }
  return { record, encoded };
}

/** One tenant topic's head: the strongest commitment to its current state. */
export interface TenantHead {
  topicId: string;
  sequenceNumber: number;
  /** Lowercase hex of the topic head's Hedera SHA-384 network running hash. */
  runningHashHex: string;
}

const TOPIC_ID_RE = /^\d+\.\d+\.\d+$/;
const HEX_RE = /^[0-9a-f]+$/;

/**
 * Canonical checkpoint leaf bytes for one tenant head (CHECKPOINT_LEAF_SPEC).
 * JCS sorts the keys, so the field order here is irrelevant — what matters is
 * that the Python verifier builds the byte-identical object. Kept in the SDK so
 * publisher (proxy), reader (indexer), and tests share one contract.
 */
export function checkpointLeaf(head: TenantHead): Uint8Array {
  if (!TOPIC_ID_RE.test(head.topicId)) throw new Error(`invalid topic id: ${head.topicId}`);
  if (!Number.isInteger(head.sequenceNumber) || head.sequenceNumber < 1) {
    throw new Error(`sequence_number must be a positive integer: ${head.sequenceNumber}`);
  }
  const runningHash = head.runningHashHex.toLowerCase();
  if (!HEX_RE.test(runningHash)) throw new Error('running_hash must be hex');
  return encodeLeaf({
    topic_id: head.topicId,
    sequence_number: head.sequenceNumber,
    running_hash: runningHash,
  });
}

export interface BuildCheckpointRecordParams {
  prevHash: string;
  ts: string;
  fromTs: string;
  toTs: string;
  /** RFC 6962 root over checkpointLeaf(head) for every tenant head. */
  tenantRoot: string;
  tenantCount: number;
}

/** Build the chk-1 cross-topic checkpoint record. */
export function buildCheckpointRecord(params: BuildCheckpointRecordParams): {
  record: OdeCheckpointRecord;
  encoded: Uint8Array;
} {
  assertHex64('prevHash', params.prevHash);
  assertHex64('tenantRoot', params.tenantRoot);
  if (!Number.isInteger(params.tenantCount) || params.tenantCount < 1) {
    throw new Error('tenantCount must be a positive integer (do not checkpoint an empty estate)');
  }
  const record: OdeCheckpointRecord = {
    v: ODE_CHECKPOINT_VERSION,
    prev_hash: params.prevHash,
    ts: params.ts,
    period: { from_ts: params.fromTs, to_ts: params.toTs },
    tenant_root: params.tenantRoot,
    tenant_count: params.tenantCount,
    leaf_spec: CHECKPOINT_LEAF_SPEC,
  };
  const encoded = encodeRecord(record);
  if (encoded.byteLength > MAX_RECORD_BYTES) {
    throw new Error(`encoded checkpoint record is ${encoded.byteLength} bytes > ${MAX_RECORD_BYTES}`);
  }
  return { record, encoded };
}
