// Cross-topic checkpoint — one RFC 6962 Merkle root over every tenant topic's
// head, anchored to the public `checkpoints` topic (chk-1). Pure module: the
// tenant heads are read from the mirror by the operator script (checkpoint.mts)
// and passed in, so this logic is unit-testable with no network or keys.
//
// Why a root-over-heads and not a list: the checkpoint is scale-invariant — one
// constant-size record witnesses the whole estate at a point in consensus time,
// and the ordered head list lives in an off-chain manifest the verifier
// recomputes from (exactly like an inference-log batch). Each head commits to a
// tenant Logbook by its Hedera SHA-384 network running hash, not the advisory
// app prev_hash — the strongest commitment available, taken from consensus.

import {
  buildCheckpointRecord,
  checkpointLeaf,
  merkleRootHex,
  type OdeCheckpointRecord,
  type TenantHead,
} from '@ailedger/sdk';

export type { TenantHead };

export interface CheckpointManifest {
  /** Discriminator for the verifier's manifests loop (vs 'batch'). */
  kind: 'checkpoint';
  tenant_root: string;
  period: { from_ts: string; to_ts: string };
  /** Heads in the exact (canonical) order their leaves were fed to the tree. */
  heads: { topic_id: string; sequence_number: number; running_hash: string }[];
}

/**
 * Canonical estate order: ascending Hedera topic id by numeric (shard, realm,
 * num) — NOT lexicographic, so 0.0.30 sorts before 0.0.200. Publisher and
 * verifier MUST agree on this; the Python verifier mirrors it.
 */
export function sortTenantHeads(heads: TenantHead[]): TenantHead[] {
  return [...heads].sort((a, b) => {
    const pa = a.topicId.split('.').map(Number);
    const pb = b.topicId.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return 0;
  });
}

/** RFC 6962 root over the per-tenant head leaves, in canonical estate order. */
export async function computeTenantRoot(heads: TenantHead[]): Promise<string> {
  if (heads.length === 0) {
    throw new Error('no tenant heads — refusing to checkpoint an empty estate');
  }
  return merkleRootHex(sortTenantHeads(heads).map((h) => checkpointLeaf(h)));
}

export interface BuildCheckpointParams {
  prevHash: string;
  ts: string;
  fromTs: string;
  toTs: string;
  heads: TenantHead[];
}

/** Build the chk-1 record + the off-chain manifest the verifier recomputes from. */
export async function buildCheckpoint(params: BuildCheckpointParams): Promise<{
  record: OdeCheckpointRecord;
  encoded: Uint8Array;
  manifest: CheckpointManifest;
}> {
  const ordered = sortTenantHeads(params.heads);
  const tenantRoot = await computeTenantRoot(ordered);
  const { record, encoded } = buildCheckpointRecord({
    prevHash: params.prevHash,
    ts: params.ts,
    fromTs: params.fromTs,
    toTs: params.toTs,
    tenantRoot,
    tenantCount: ordered.length,
  });
  const manifest: CheckpointManifest = {
    kind: 'checkpoint',
    tenant_root: tenantRoot,
    period: { from_ts: params.fromTs, to_ts: params.toTs },
    heads: ordered.map((h) => ({
      topic_id: h.topicId,
      sequence_number: h.sequenceNumber,
      running_hash: h.runningHashHex.toLowerCase(),
    })),
  };
  return { record, encoded, manifest };
}
