// Hedera topic provisioning — SDK-touching operator operations.
//
// Key topology (locked decision, plan §2): every topic gets
//   submitKey — ONE key, one holder (operator KMS now, customer KMS on the
//               BYO tier). Never a threshold: m-of-n on submitKey would
//               require multi-sig per message and break the Lodestar
//               single-serialized-appender invariant.
//   adminKey  — 2-of-3 ThresholdKey (operator / customer / escrow), used
//               only for rotation ceremonies (docs/key-rotation-runbook.md).
//
// Every create asserts the guards afterwards via TopicInfo: a topic without
// a submitKey is world-writable spam space and must never enter service.

import {
  Client,
  KeyList,
  PrivateKey,
  PublicKey,
  TopicCreateTransaction,
  TopicId,
  TopicInfoQuery,
  TopicMessageSubmitTransaction,
} from '@hashgraph/sdk';

export interface AdminKeySet {
  /** Exactly three public keys: operator, customer (or placeholder), escrow (or placeholder). */
  publicKeys: PublicKey[];
  threshold: number;
}

export function makeAdminKeyList(set: AdminKeySet): KeyList {
  if (set.publicKeys.length !== 3 || set.threshold !== 2) {
    throw new Error('admin key topology is fixed at 2-of-3 (operator/customer/escrow)');
  }
  return new KeyList(set.publicKeys, set.threshold);
}

/** SHA-256 hex fingerprint of a public key's raw bytes (for announcements). */
export async function publicKeyFingerprint(key: PublicKey): Promise<string> {
  const raw = key.toBytesRaw();
  const digest = await crypto.subtle.digest('SHA-256', raw.slice().buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface CreateGuardedTopicParams {
  memo: string;
  submitPublicKey: PublicKey;
  admin: AdminKeySet;
  /** Private keys satisfying the admin threshold — required to sign the create. */
  adminSigners: PrivateKey[];
}

/** Create a topic with the fixed key topology and verify its guards on-network. */
export async function createGuardedTopic(
  client: Client,
  params: CreateGuardedTopicParams,
): Promise<TopicId> {
  if (params.adminSigners.length < params.admin.threshold) {
    throw new Error(
      `topic create needs ${params.admin.threshold} admin signatures, got ${params.adminSigners.length}`,
    );
  }
  const tx = new TopicCreateTransaction()
    .setTopicMemo(params.memo)
    .setSubmitKey(params.submitPublicKey)
    .setAdminKey(makeAdminKeyList(params.admin))
    .freezeWith(client);
  for (const signer of params.adminSigners) await tx.sign(signer);
  const receipt = await (await tx.execute(client)).getReceipt(client);
  const topicId = receipt.topicId;
  if (topicId == null) throw new Error('topic create returned no topicId');
  await assertTopicGuards(client, topicId, params.memo);
  return topicId;
}

/** Post-create invariant check: memo matches, submitKey and adminKey present. */
export async function assertTopicGuards(
  client: Client,
  topicId: TopicId,
  expectedMemo: string,
): Promise<void> {
  const info = await new TopicInfoQuery().setTopicId(topicId).execute(client);
  if (info.topicMemo !== expectedMemo) {
    throw new Error(
      `topic ${topicId.toString()} memo mismatch: ${JSON.stringify(info.topicMemo)} != ${JSON.stringify(expectedMemo)}`,
    );
  }
  if (info.submitKey == null) {
    throw new Error(
      `topic ${topicId.toString()} has NO submitKey — world-writable; refusing to enter service`,
    );
  }
  if (info.adminKey == null) {
    throw new Error(`topic ${topicId.toString()} has NO adminKey — rotation ceremony impossible`);
  }
}

/** Submit one message signed with the topic's submitKey; returns the sequence number. */
export async function submitGuardedMessage(
  client: Client,
  topicId: TopicId,
  submitKey: PrivateKey,
  message: Uint8Array,
): Promise<number> {
  const tx = new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(message)
    .freezeWith(client);
  await tx.sign(submitKey);
  const receipt = await (await tx.execute(client)).getReceipt(client);
  const seq = receipt.topicSequenceNumber;
  if (seq == null) throw new Error('submit returned no sequence number');
  return seq.toNumber();
}
