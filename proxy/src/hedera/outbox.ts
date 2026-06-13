// Per-tenant outbox → HCS submit orchestration (pure module).
//
// Storage and submission are injected (OutboxStore / RecordSubmitter) so this
// logic is unit-testable with fakes, runs against Workers KV behind the relay,
// and against a local store in self-hosted Node mode. No @hashgraph/sdk or
// node:* imports here — the Node submitter lives in submit.ts.
//
// Semantics (locked in the plan):
//   * ONE drainer per tenant (Lodestar single-serialized-appender): enforced
//     by a TTL lease. Note: Workers KV is eventually consistent, so a KV
//     lease is best-effort — production Workers mode serializes via a
//     Durable Object or runs the drainer as a single Node process. The
//     safety net is architectural: Hedera consensus order is authoritative
//     and an app prev_hash mismatch is WARN, not FAIL (plan D11).
//   * Decision events seal individually, in queue order. A submit failure
//     stops the drain for that tenant (head-of-line blocking is CORRECT —
//     order is the product).
//   * Inference logs accumulate and seal as one RFC 6962 batch record when
//     the OLDEST pending log exceeds the batch interval (or on forceBatch).
//   * prev_hash threads SHA-256(previous record's encoded bytes) across BOTH
//     record kinds — one app-level chain per tenant topic.
//   * Delivery is at-least-once: the chain state is persisted after submit
//     and before queue deletion, so a crash in that window re-submits the
//     same record on retry. Consumers (indexer/verifier) dedupe by event_id/
//     batch_id; duplicates are benign, gaps are not.

import {
  buildBatchRecord,
  buildDecisionRecord,
  encodeLeaf,
  fromHex,
  merkleRootHex,
  GENESIS_PREV_HASH,
} from '@ailedger/sdk';
import type { DecisionCommitInputs } from '@ailedger/sdk';

export interface OutboxStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  /** All keys under prefix, lexicographically sorted (Workers KV list order). */
  list(prefix: string): Promise<string[]>;
}

export interface RecordSubmitter {
  submit(tenantRef: string, encoded: Uint8Array): Promise<{ sequenceNumber: number }>;
}

export interface QueuedDecision {
  kind: 'decision';
  eventId: string;
  decisionType: string;
  ts: string;
  humanInLoop: boolean;
  modelWeightsHash: string | null;
  commitInputs: DecisionCommitInputs;
  /** Per-event salt hex — also stored inside the sealed payload. */
  saltHex: string;
  payloadHash: string;
}

export interface QueuedLog {
  kind: 'log';
  ts: string;
  logRecord: Record<string, unknown>;
}

export type QueuedItem = QueuedDecision | QueuedLog;

export interface SealedDecision {
  kind: 'decision';
  tenantRef: string;
  eventId: string;
  sequenceNumber: number;
  recordHash: string;
}

export interface SealedBatch {
  kind: 'batch';
  tenantRef: string;
  batchId: string;
  sequenceNumber: number;
  recordHash: string;
  merkleRoot: string;
  leafCount: number;
  /** The sealed log records in leaf order — caller persists the manifest
   *  (inclusion proofs need the ordered leaves). */
  logs: Record<string, unknown>[];
}

export type SealedInfo = SealedDecision | SealedBatch;

export interface OutboxConfig {
  store: OutboxStore;
  submitter: RecordSubmitter;
  /** Seal a log batch once the oldest pending log is at least this old. */
  batchIntervalMs?: number;
  leaseTtlSeconds?: number;
  now?: () => number;
  /** Entropy for queue-key tiebreaks and batch ids (injectable for tests). */
  entropy?: () => string;
  onSealed?: (info: SealedInfo) => void | Promise<void>;
}

export interface DrainResult {
  tenantRef: string;
  sealedDecisions: number;
  sealedBatches: number;
  pendingLogsHeld: number;
  skipped?: 'lease-held';
  error?: string;
}

const DEFAULT_BATCH_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_LEASE_TTL_S = 60;

const queueKey = (tenant: string, ms: number, entropy: string) =>
  `outbox:${tenant}:${String(ms).padStart(14, '0')}-${entropy}`;
const chainStateKey = (tenant: string) => `chainstate:${tenant}`;
const leaseKey = (tenant: string) => `lease:${tenant}`;

interface ChainState {
  prevHash: string;
}

function defaultEntropy(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256hexOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Append one item to the tenant's queue; returns the queue key. */
export async function enqueue(
  cfg: OutboxConfig,
  tenantRef: string,
  item: QueuedItem,
): Promise<string> {
  const now = cfg.now ?? Date.now;
  const entropy = cfg.entropy ?? defaultEntropy;
  const key = queueKey(tenantRef, now(), entropy());
  await cfg.store.put(key, JSON.stringify(item));
  return key;
}

/** Millisecond timestamp embedded in a queue key. */
function keyMs(key: string): number {
  const stamp = key.split(':')[2]?.split('-')[0];
  return Number(stamp ?? 0);
}

async function loadChainState(store: OutboxStore, tenantRef: string): Promise<ChainState> {
  const raw = await store.get(chainStateKey(tenantRef));
  return raw ? (JSON.parse(raw) as ChainState) : { prevHash: GENESIS_PREV_HASH };
}

/** True if the tenant has local chain state (false ⇒ a drain would start at genesis). */
export async function hasChainState(store: OutboxStore, tenantRef: string): Promise<boolean> {
  return (await store.get(chainStateKey(tenantRef))) !== null;
}

/**
 * Seed the tenant's chain tail explicitly — used by drainers recovering from
 * state loss: read the topic's last message from a mirror, hash its bytes,
 * seed here. Prevents a fresh drainer from forking the app chain back to
 * genesis on a topic that already has records.
 */
export async function seedChainState(
  store: OutboxStore,
  tenantRef: string,
  prevHash: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(prevHash)) throw new Error('prevHash must be 64-hex');
  await store.put(chainStateKey(tenantRef), JSON.stringify({ prevHash } satisfies ChainState));
}

/**
 * Drain one tenant's queue: decisions individually in order, then a log
 * batch if due. Returns counts; on a submit failure the remaining queue is
 * left intact for the next drain.
 */
export async function drainTenant(
  cfg: OutboxConfig,
  tenantRef: string,
  opts: { forceBatch?: boolean } = {},
): Promise<DrainResult> {
  const { store, submitter } = cfg;
  const now = cfg.now ?? Date.now;
  const entropy = cfg.entropy ?? defaultEntropy;
  const batchIntervalMs = cfg.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS;
  const result: DrainResult = {
    tenantRef,
    sealedDecisions: 0,
    sealedBatches: 0,
    pendingLogsHeld: 0,
  };

  // Best-effort lease (see module header for the consistency caveat).
  const token = entropy();
  if ((await store.get(leaseKey(tenantRef))) !== null) {
    return { ...result, skipped: 'lease-held' };
  }
  await store.put(leaseKey(tenantRef), token, {
    ttlSeconds: cfg.leaseTtlSeconds ?? DEFAULT_LEASE_TTL_S,
  });

  try {
    const state = await loadChainState(store, tenantRef);
    const keys = await store.list(`outbox:${tenantRef}:`);
    const pendingLogs: { key: string; item: QueuedLog }[] = [];

    for (const key of keys) {
      const raw = await store.get(key);
      if (raw === null) continue; // already consumed
      const item = JSON.parse(raw) as QueuedItem;

      if (item.kind === 'log') {
        pendingLogs.push({ key, item });
        continue;
      }

      const { encoded } = await buildDecisionRecord({
        eventId: item.eventId,
        decisionType: item.decisionType,
        ts: item.ts,
        prevHash: state.prevHash,
        humanInLoop: item.humanInLoop,
        modelWeightsHash: item.modelWeightsHash,
        commitInputs: item.commitInputs,
        salt: fromHex(item.saltHex),
        payloadHash: item.payloadHash,
      });
      const { sequenceNumber } = await submitter.submit(tenantRef, encoded);
      const recordHash = await sha256hexOf(encoded);
      state.prevHash = recordHash;
      // State BEFORE delete: a crash here re-submits the same record next
      // drain (at-least-once; dedupe by event_id downstream).
      await store.put(chainStateKey(tenantRef), JSON.stringify(state));
      await store.delete(key);
      result.sealedDecisions++;
      await cfg.onSealed?.({
        kind: 'decision',
        tenantRef,
        eventId: item.eventId,
        sequenceNumber,
        recordHash,
      });
    }

    if (pendingLogs.length > 0) {
      const oldestMs = keyMs(pendingLogs[0].key);
      const due = opts.forceBatch === true || now() - oldestMs >= batchIntervalMs;
      if (due) {
        const logs = pendingLogs.map((p) => p.item.logRecord);
        const leaves = logs.map((log) => encodeLeaf(log));
        const merkleRoot = await merkleRootHex(leaves);
        const batchId = `${String(now()).padStart(14, '0')}-${entropy()}`;
        const { encoded } = buildBatchRecord({
          batchId,
          prevHash: state.prevHash,
          merkleRoot,
          leafCount: leaves.length,
          fromTs: pendingLogs[0].item.ts,
          toTs: pendingLogs[pendingLogs.length - 1].item.ts,
        });
        const { sequenceNumber } = await submitter.submit(tenantRef, encoded);
        const recordHash = await sha256hexOf(encoded);
        state.prevHash = recordHash;
        await store.put(chainStateKey(tenantRef), JSON.stringify(state));
        for (const p of pendingLogs) await store.delete(p.key);
        result.sealedBatches++;
        await cfg.onSealed?.({
          kind: 'batch',
          tenantRef,
          batchId,
          sequenceNumber,
          recordHash,
          merkleRoot,
          leafCount: leaves.length,
          logs,
        });
      } else {
        result.pendingLogsHeld = pendingLogs.length;
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    // Release only our own lease.
    if ((await store.get(leaseKey(tenantRef))) === token) {
      await store.delete(leaseKey(tenantRef));
    }
  }
  return result;
}
