// Ingest — registry discovery + per-topic backfill with app-chain checking.
//
// Bootstrap requires exactly ONE input: the registry.tenants topic id. Every
// tenant topic is discovered from on-chain announcements; every record is
// verified against the app prev_hash chain as it lands. Per plan D11,
// consensus order is authoritative: a prev_hash mismatch is recorded as a
// broken link (WARN surface), never a reason to drop data.

import { restMirror, type MirrorSource } from './mirror.ts';
import { asTenantAnnouncement, parseMirrorMessage, sha256hexOf, decodeBase64 } from './parse.ts';
import { IndexerStore } from './store.ts';
import { GENESIS_PREV_HASH } from '@ailedger/sdk';

export interface IngestSummary {
  topicId: string;
  newRecords: number;
  decisions: number;
  unwarrants: number;
  batches: number;
  announcements: number;
  brokenLinks: number;
}

/** Backfill the registry topic: discover tenants. */
export async function ingestRegistry(
  store: IndexerStore,
  mirror: MirrorSource,
  registryTopicId: string,
): Promise<IngestSummary> {
  const summary = base(registryTopicId);
  const messages = await mirror.fetchMessages(registryTopicId, store.lastSeq(registryTopicId));
  for (const msg of messages) {
    const rec = await parseMirrorMessage(msg);
    // Registry topics are control-plane, not app-chained: no link check.
    store.insertRecord(registryTopicId, rec, msg.message, null, null);
    summary.newRecords++;
    const announcement = asTenantAnnouncement(rec);
    if (announcement) {
      store.upsertTenant(announcement);
      summary.announcements++;
    }
  }
  return summary;
}

/** Backfill one tenant topic with app-chain link verification. */
export async function ingestTenantTopic(
  store: IndexerStore,
  mirror: MirrorSource,
  tenantRef: string,
  topicId: string,
): Promise<IngestSummary> {
  const summary = base(topicId);
  const lastSeq = store.lastSeq(topicId);
  // Resume the chain check from the stored tail, or genesis for a fresh topic.
  let prevHash = GENESIS_PREV_HASH;
  if (lastSeq > 0) {
    const status = store.chainStatus(topicId);
    prevHash = status?.lastRecordHash ?? GENESIS_PREV_HASH;
  }

  const messages = await mirror.fetchMessages(topicId, lastSeq);
  for (const msg of messages) {
    const rec = await parseMirrorMessage(msg);
    const claimed = (rec.body as Record<string, unknown>).prev_hash;
    const linkOk = typeof claimed === 'string' ? claimed === prevHash : false;
    store.insertRecord(topicId, rec, msg.message, prevHash, linkOk);
    if (!linkOk) summary.brokenLinks++;
    if (rec.body.v === 'ode-2') {
      store.insertDecision(tenantRef, topicId, rec);
      summary.decisions++;
    } else if (rec.body.v === 'ode-2u') {
      store.insertUnwarrant(tenantRef, topicId, rec);
      summary.unwarrants++;
    } else if (rec.body.v === 'ode-2b') {
      store.insertBatch(tenantRef, topicId, rec);
      summary.batches++;
    }
    summary.newRecords++;
    prevHash = rec.recordHash;
  }
  return summary;
}

/** Full sweep: registry first (discovery), then every known tenant topic. */
export async function ingestAll(
  store: IndexerStore,
  mirror: MirrorSource,
  registryTopicId: string,
): Promise<IngestSummary[]> {
  const summaries: IngestSummary[] = [];
  summaries.push(await ingestRegistry(store, mirror, registryTopicId));
  for (const tenant of store.tenants()) {
    summaries.push(await ingestTenantTopic(store, mirror, tenant.tenantRef, tenant.topicId));
  }
  return summaries;
}

export { restMirror, sha256hexOf, decodeBase64 };

function base(topicId: string): IngestSummary {
  return {
    topicId,
    newRecords: 0,
    decisions: 0,
    unwarrants: 0,
    batches: 0,
    announcements: 0,
    brokenLinks: 0,
  };
}
