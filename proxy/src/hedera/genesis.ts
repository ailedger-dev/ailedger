// Genesis attestation — message #1 on a fresh topic, witnessing the history
// that preceded it. Pure module: the predecessor's head is read from the mirror
// by the operator script (genesis.mts) and passed in, so this is unit-testable
// with no network or keys.
//
// The companion to the checkpoint anchor: a checkpoint witnesses the live
// estate on a cadence; a genesis witnesses, once and forever, what a topic
// continues from. For an hcs-continuity witness the predecessor is itself a
// public topic, so every field here is re-derivable by any verifier from public
// data — no trust in the operator's compute.

import {
  buildGenesisRecord,
  type HcsContinuityWitness,
  type OdeGenesisRecord,
} from '@ailedger/sdk';

export interface PredecessorHead {
  topicId: string;
  finalSeq: number;
  /** Hex of the predecessor head's Hedera SHA-384 network running hash. */
  finalRunningHashHex: string;
  /** SHA-256 of the predecessor's final message bytes (its app-chain head). */
  finalAppHead: string;
  recordCount: number;
}

async function sha256hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Derive a predecessor head from its FINAL message alone. HCS sequence numbers
 * are 1-based and contiguous, so the final sequence number is the record count;
 * the app-chain head is SHA-256 of the final message bytes (the prev_hash the
 * next record would have carried).
 */
export async function predecessorHeadFromFinalMessage(
  topicId: string,
  finalMessage: { sequenceNumber: number; runningHashHex: string; bytes: Uint8Array },
): Promise<PredecessorHead> {
  return {
    topicId,
    finalSeq: finalMessage.sequenceNumber,
    finalRunningHashHex: finalMessage.runningHashHex.toLowerCase(),
    finalAppHead: await sha256hex(finalMessage.bytes),
    recordCount: finalMessage.sequenceNumber,
  };
}

export function hcsContinuityWitness(head: PredecessorHead): HcsContinuityWitness {
  return {
    kind: 'hcs-continuity',
    predecessor_topic_id: head.topicId,
    final_seq: head.finalSeq,
    final_running_hash: head.finalRunningHashHex.toLowerCase(),
    final_app_head: head.finalAppHead,
    record_count: head.recordCount,
  };
}

/** Build the gen-1 record that witnesses an HCS predecessor topic. */
export function buildHcsContinuityGenesis(params: { ts: string; head: PredecessorHead }): {
  record: OdeGenesisRecord;
  encoded: Uint8Array;
} {
  return buildGenesisRecord({ ts: params.ts, witness: hcsContinuityWitness(params.head) });
}
