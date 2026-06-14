// Indexer tests — fixtures are REAL records built with the SDK evidence core,
// chained correctly, then served through a fake mirror.
import { beforeEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  buildBatchRecord,
  buildDecisionRecord,
  buildUnwarrantRecord,
  buildWarrantHealthRecord,
  encodeLeaf,
  merkleRootHex,
  GENESIS_PREV_HASH,
} from '@ailedger/sdk';
import { ingestAll, ingestRegistry, ingestTenantTopic } from '../src/ingest.ts';
import type { MirrorSource } from '../src/mirror.ts';
import type { MirrorMessage } from '../src/parse.ts';
import { sha256hexOf } from '../src/parse.ts';
import { IndexerStore } from '../src/store.ts';
import { createIndexerApi } from '../src/api.ts';

const REGISTRY = '0.0.100';
const TENANT_TOPIC = '0.0.200';
const SALT = '07'.repeat(32);

class FakeMirror implements MirrorSource {
  topics = new Map<string, MirrorMessage[]>();
  push(topicId: string, bytes: Uint8Array): void {
    const msgs = this.topics.get(topicId) ?? [];
    msgs.push({
      sequence_number: msgs.length + 1,
      consensus_timestamp: `17813000${String(msgs.length).padStart(2, '0')}.000000000`,
      message: Buffer.from(bytes).toString('base64'),
    });
    this.topics.set(topicId, msgs);
  }
  async fetchMessages(topicId: string, afterSeq: number): Promise<MirrorMessage[]> {
    return (this.topics.get(topicId) ?? []).filter((m) => m.sequence_number > afterSeq);
  }
}

async function decisionEncoded(n: number, prevHash: string, eventId?: string) {
  return buildDecisionRecord({
    eventId: eventId ?? `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    decisionType: 'employment_screening',
    ts: `2026-06-12T19:00:0${n}.000Z`,
    prevHash,
    humanInLoop: false,
    modelWeightsHash: null,
    commitInputs: {
      inputs: { n },
      output: { decision: 'advance' },
      context: null,
      actions: null,
      trace: null,
    },
    salt: new Uint8Array(32).fill(7),
    payloadHash: 'cd'.repeat(32),
  });
}

async function unwarrantEncoded(n: number, prevHash: string) {
  return buildUnwarrantRecord({
    eventId: `00000000-0000-4000-8000-0000000000u${n}`.slice(0, 36),
    decisionType: 'agent_decision',
    ts: `2026-06-12T19:00:0${n}.000Z`,
    prevHash,
    unwarrantCategory: 'missing-justification',
    salt: new Uint8Array(32).fill(7),
    attempt: { decision: 'acted', n },
    payloadHash: 'cd'.repeat(32),
  });
}

async function buildFixture(mirror: FakeMirror) {
  // registry: one tenant announcement
  const announcement = {
    v: 'reg-1',
    kind: 'tenant-created',
    tenant_ref: 'jv-fleet',
    topic_id: TENANT_TOPIC,
    submit_pubkey: 'ab'.repeat(32),
    admin_threshold: 2,
    admin_key_fingerprints: ['ef'.repeat(32), 'ef'.repeat(32), 'ef'.repeat(32)],
  };
  mirror.push(REGISTRY, new TextEncoder().encode(JSON.stringify(announcement)));

  // tenant topic: d1 → d2 → batch, properly chained
  const d1 = await decisionEncoded(1, GENESIS_PREV_HASH);
  mirror.push(TENANT_TOPIC, d1.encoded);
  const d2 = await decisionEncoded(2, await sha256hexOf(d1.encoded));
  mirror.push(TENANT_TOPIC, d2.encoded);
  const logs = [{ call: 1 }, { call: 2 }];
  const batch = buildBatchRecord({
    batchId: 'batch-1',
    prevHash: await sha256hexOf(d2.encoded),
    merkleRoot: await merkleRootHex(logs.map((l) => encodeLeaf(l))),
    leafCount: logs.length,
    fromTs: '2026-06-12T19:00:03.000Z',
    toTs: '2026-06-12T19:00:04.000Z',
  });
  mirror.push(TENANT_TOPIC, batch.encoded);
  return { d1, d2, batch };
}

describe('indexer', () => {
  let mirror: FakeMirror;
  let store: IndexerStore;

  beforeEach(() => {
    mirror = new FakeMirror();
    store = new IndexerStore(':memory:');
  });

  it('discovers tenants from the registry and backfills a continuous chain', async () => {
    await buildFixture(mirror);
    const summaries = await ingestAll(store, mirror, REGISTRY);
    expect(summaries[0].announcements).toBe(1);
    expect(store.tenants()[0]).toMatchObject({ tenantRef: 'jv-fleet', topicId: TENANT_TOPIC });

    const status = store.chainStatus(TENANT_TOPIC)!;
    expect(status.records).toBe(3);
    expect(status.continuous).toBe(true);
    expect(store.decisionsForTenant('jv-fleet').length).toBe(2);
    expect(store.batchesForTenant('jv-fleet').length).toBe(1);
  });

  it('ode-2u counts toward warrant-health on the same chain as ode-2', async () => {
    // d1 (warranted) -> u2 (unwarranted) -> d3 (warranted), one chain.
    const d1 = await decisionEncoded(1, GENESIS_PREV_HASH);
    mirror.push(TENANT_TOPIC, d1.encoded);
    const u2 = await unwarrantEncoded(2, await sha256hexOf(d1.encoded));
    mirror.push(TENANT_TOPIC, u2.encoded);
    const d3 = await decisionEncoded(3, await sha256hexOf(u2.encoded));
    mirror.push(TENANT_TOPIC, d3.encoded);
    // announce the tenant so warrantHealth resolves it
    mirror.push(
      REGISTRY,
      new TextEncoder().encode(
        JSON.stringify({
          v: 'reg-1',
          kind: 'tenant-created',
          tenant_ref: 'jv-fleet',
          topic_id: TENANT_TOPIC,
          submit_pubkey: 'ab'.repeat(32),
          admin_threshold: 2,
          admin_key_fingerprints: ['ef'.repeat(32), 'ef'.repeat(32), 'ef'.repeat(32)],
        }),
      ),
    );

    await ingestAll(store, mirror, REGISTRY);
    const status = store.chainStatus(TENANT_TOPIC)!;
    expect(status.records).toBe(3);
    expect(status.continuous).toBe(true); // unwarrant threads the same chain

    const h = store.warrantHealth('jv-fleet');
    expect(h).toMatchObject({
      total: 3,
      warranted: 2,
      unwarranted: 1,
      byCategory: { 'missing-justification': 1 },
    });
    expect(h.rate).toBeCloseTo(1 / 3, 10);
  });

  it('discovers operators from registry.operators and builds the public board', async () => {
    const OPERATORS_REGISTRY = '0.0.300';
    const WH_TOPIC = '0.0.301';
    // operator announcement on the operators registry
    mirror.push(
      OPERATORS_REGISTRY,
      new TextEncoder().encode(
        JSON.stringify({
          v: 'reg-1',
          kind: 'operator-created',
          operator_id: 'jv-fleet',
          operator_pubkey: 'cd'.repeat(32),
          warrant_health_topic_id: WH_TOPIC,
        }),
      ),
    );
    // one owh-1 on the operator's warrant-health topic
    const owh = buildWarrantHealthRecord({
      prevHash: GENESIS_PREV_HASH,
      operatorId: 'jv-fleet',
      fromTs: '1970-01-01T00:00:00Z',
      toTs: '2026-06-12T00:00:00Z',
      total: 1000,
      unwarranted: 30,
      byCategory: { 'missing-justification': 30 },
      rate: 0.03,
      sampleSize: 1000,
      threshold: 0.05,
      verdict: 'PASS',
    });
    mirror.push(WH_TOPIC, owh.encoded);

    // bootstrap from BOTH roots — tenants (empty here) + operators
    await ingestAll(store, mirror, REGISTRY, OPERATORS_REGISTRY);

    expect(store.operators()[0]).toMatchObject({ operatorId: 'jv-fleet', warrantHealthTopicId: WH_TOPIC });
    const board = store.board();
    expect(board).toHaveLength(1);
    expect(board[0].latest).toMatchObject({
      total: 1000,
      unwarranted: 30,
      rate: 0.03,
      verdict: 'PASS',
      byCategory: { 'missing-justification': 30 },
    });

    // cold rebuild from the same mirror reproduces the board
    const b = new IndexerStore(':memory:');
    await ingestAll(b, mirror, REGISTRY, OPERATORS_REGISTRY);
    expect(b.board()).toEqual(board);
  });

  it('detects a broken link at the exact sequence', async () => {
    const d1 = await decisionEncoded(1, GENESIS_PREV_HASH);
    mirror.push(TENANT_TOPIC, d1.encoded);
    // d2 forged with a WRONG prev_hash (not sha256(d1)).
    const d2 = await decisionEncoded(2, 'ee'.repeat(32));
    mirror.push(TENANT_TOPIC, d2.encoded);
    // d3 correctly chains onto d2's actual bytes.
    const d3 = await decisionEncoded(3, await sha256hexOf(d2.encoded));
    mirror.push(TENANT_TOPIC, d3.encoded);

    const summary = await ingestTenantTopic(store, mirror, 'jv-fleet', TENANT_TOPIC);
    expect(summary.brokenLinks).toBe(1);
    const status = store.chainStatus(TENANT_TOPIC)!;
    expect(status.continuous).toBe(false);
    expect(status.firstBreakSeq).toBe(2);
  });

  it('dedupes at-least-once duplicates by event_id', async () => {
    const eventId = '00000000-0000-4000-8000-aaaaaaaaaaaa';
    const d1 = await decisionEncoded(1, GENESIS_PREV_HASH, eventId);
    mirror.push(TENANT_TOPIC, d1.encoded);
    // The duplicate the outbox crash-window produces: same event_id, same prev_hash.
    mirror.push(TENANT_TOPIC, d1.encoded);

    await ingestTenantTopic(store, mirror, 'jv-fleet', TENANT_TOPIC);
    expect(store.decisionsForTenant('jv-fleet').length).toBe(1);
    expect(store.duplicateCount(TENANT_TOPIC)).toBe(1);
  });

  it('incremental ingest resumes the chain check from the stored tail', async () => {
    const { d1 } = await buildFixture(mirror);
    // First sweep sees only seq 1.
    const truncated: MirrorSource = {
      fetchMessages: async (t, after) =>
        (await mirror.fetchMessages(t, after)).filter((m) => m.sequence_number <= 1),
    };
    await ingestTenantTopic(store, truncated, 'jv-fleet', TENANT_TOPIC);
    expect(store.chainStatus(TENANT_TOPIC)!.records).toBe(1);
    expect(store.chainStatus(TENANT_TOPIC)!.lastRecordHash).toBe(await sha256hexOf(d1.encoded));

    // Second sweep gets the rest; links must still verify.
    const summary = await ingestTenantTopic(store, mirror, 'jv-fleet', TENANT_TOPIC);
    expect(summary.newRecords).toBe(2);
    const status = store.chainStatus(TENANT_TOPIC)!;
    expect(status.records).toBe(3);
    expect(status.continuous).toBe(true);
  });

  it('cold rebuild: two fresh stores over the same mirror produce identical state', async () => {
    await buildFixture(mirror);
    const a = new IndexerStore(':memory:');
    const b = new IndexerStore(':memory:');
    await ingestAll(a, mirror, REGISTRY);
    await ingestAll(b, mirror, REGISTRY);
    expect(a.chainStatus(TENANT_TOPIC)).toEqual(b.chainStatus(TENANT_TOPIC));
    expect(a.decisionsForTenant('jv-fleet')).toEqual(b.decisionsForTenant('jv-fleet'));
    expect(a.batchesForTenant('jv-fleet')).toEqual(b.batchesForTenant('jv-fleet'));
    expect(a.tenants()).toEqual(b.tenants());
  });

  it('serves the read API shapes', async () => {
    await buildFixture(mirror);
    await ingestAll(store, mirror, REGISTRY);
    const api = createIndexerApi(store);

    const tenants = (await (await api.request('/v1/tenants')).json()) as {
      tenants: { tenant_ref: string }[];
    };
    expect(tenants.tenants[0].tenant_ref).toBe('jv-fleet');

    const chainRes = await api.request('/v1/tenants/jv-fleet/chain');
    expect(chainRes.status).toBe(200);
    const chain = (await chainRes.json()) as { continuous: boolean; records: number };
    expect(chain).toMatchObject({ continuous: true, records: 3, duplicates: 0 });

    const events = (await (await api.request('/v1/tenants/jv-fleet/events')).json()) as {
      events: { event_id: string }[];
    };
    expect(events.events.length).toBe(2);

    const one = await api.request(`/v1/events/${events.events[0].event_id}`);
    expect(one.status).toBe(200);
    expect((await api.request('/v1/events/nope')).status).toBe(404);
    expect((await api.request('/v1/tenants/ghost/chain')).status).toBe(404);
  });
});
