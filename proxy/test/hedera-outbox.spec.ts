// Outbox semantics tests — fake store + fake submitter, deterministic clock.
import { describe, expect, it } from 'vitest';
import {
  drainTenant,
  enqueue,
  type OutboxConfig,
  type OutboxStore,
  type QueuedDecision,
  type QueuedLog,
  type SealedInfo,
} from '../src/hedera/outbox';
import {
  encodeLeaf,
  inclusionProof,
  merkleRoot,
  verifyInclusion,
  fromHex,
  GENESIS_PREV_HASH,
} from '@ailedger/sdk';

class MemoryStore implements OutboxStore {
  data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.data.set(key, value);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
  async list(prefix: string) {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

class CapturingSubmitter {
  submitted: { tenantRef: string; encoded: Uint8Array }[] = [];
  failOnCall: number | null = null;
  async submit(tenantRef: string, encoded: Uint8Array) {
    if (this.failOnCall !== null && this.submitted.length + 1 === this.failOnCall) {
      throw new Error('synthetic submit failure');
    }
    this.submitted.push({ tenantRef, encoded });
    return { sequenceNumber: this.submitted.length };
  }
}

async function sha256hexOf(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function decision(n: number): QueuedDecision {
  return {
    kind: 'decision',
    eventId: `event-${n}`,
    decisionType: 'employment_screening',
    ts: `2026-06-12T17:00:0${n}.000000Z`,
    humanInLoop: false,
    modelWeightsHash: null,
    commitInputs: {
      inputs: { n },
      output: { decision: 'advance' },
      context: { collection_method: 'blind' },
      actions: { flags_raised: [] },
      trace: null,
    },
    saltHex: '07'.repeat(32),
    payloadHash: 'cd'.repeat(32),
  };
}

function log(n: number): QueuedLog {
  return { kind: 'log', ts: `2026-06-12T17:00:0${n}.000000Z`, logRecord: { call: n } };
}

function makeCfg(overrides: Partial<OutboxConfig> = {}) {
  const store = new MemoryStore();
  const submitter = new CapturingSubmitter();
  let clock = 1_000_000_000_000;
  let counter = 0;
  const sealed: SealedInfo[] = [];
  const cfg: OutboxConfig = {
    store,
    submitter,
    batchIntervalMs: 60_000,
    now: () => clock,
    entropy: () => String(counter++).padStart(8, '0'),
    onSealed: (info) => {
      sealed.push(info);
    },
    ...overrides,
  };
  return {
    cfg,
    store,
    submitter,
    sealed,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const decode = (bytes: Uint8Array) =>
  JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;

describe('outbox drain', () => {
  it('threads prev_hash across decisions and the batch (one chain per tenant)', async () => {
    const { cfg, submitter, sealed, tick } = makeCfg();
    await enqueue(cfg, 't1', decision(1));
    tick(10);
    await enqueue(cfg, 't1', decision(2));
    tick(10);
    for (const n of [3, 4, 5]) {
      await enqueue(cfg, 't1', log(n));
      tick(10);
    }

    const result = await drainTenant(cfg, 't1', { forceBatch: true });
    expect(result.error).toBeUndefined();
    expect(result.sealedDecisions).toBe(2);
    expect(result.sealedBatches).toBe(1);
    expect(submitter.submitted.length).toBe(3);

    const [r1, r2, rb] = submitter.submitted.map((s) => decode(s.encoded));
    expect(r1.prev_hash).toBe(GENESIS_PREV_HASH);
    expect(r2.prev_hash).toBe(await sha256hexOf(submitter.submitted[0].encoded));
    expect(rb.prev_hash).toBe(await sha256hexOf(submitter.submitted[1].encoded));
    expect(rb.v).toBe('ode-2b');
    expect(rb.leaf_count).toBe(3);

    // The sealed-batch manifest reproduces the root and serves proofs.
    const batch = sealed.find((s) => s.kind === 'batch');
    expect(batch?.kind).toBe('batch');
    if (batch?.kind !== 'batch') return;
    const leaves = batch.logs.map((l) => encodeLeaf(l));
    const root = await merkleRoot(leaves);
    expect(rb.merkle_root).toBe(
      Array.from(root)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
    );
    const proof = await inclusionProof(1, leaves);
    expect(await verifyInclusion(leaves[1], 1, leaves.length, proof, root)).toBe(true);
  });

  it('head-of-line blocking: a failed submit stops the drain; retry continues the same chain', async () => {
    const { cfg, store, submitter } = makeCfg();
    await enqueue(cfg, 't1', decision(1));
    await enqueue(cfg, 't1', decision(2));

    submitter.failOnCall = 2;
    const first = await drainTenant(cfg, 't1');
    expect(first.sealedDecisions).toBe(1);
    expect(first.error).toMatch(/synthetic submit failure/);
    expect((await store.list('outbox:t1:')).length).toBe(1); // d2 retained

    submitter.failOnCall = null;
    const second = await drainTenant(cfg, 't1');
    expect(second.error).toBeUndefined();
    expect(second.sealedDecisions).toBe(1);
    const [, r2] = submitter.submitted.map((s) => decode(s.encoded));
    expect(r2.prev_hash).toBe(await sha256hexOf(submitter.submitted[0].encoded));
  });

  it('lease exclusion: a held lease skips the drain; own lease is released after', async () => {
    const { cfg, store, submitter } = makeCfg();
    await enqueue(cfg, 't1', decision(1));
    await store.put('lease:t1', 'someone-else');
    const skipped = await drainTenant(cfg, 't1');
    expect(skipped.skipped).toBe('lease-held');
    expect(submitter.submitted.length).toBe(0);

    await store.delete('lease:t1');
    const drained = await drainTenant(cfg, 't1');
    expect(drained.sealedDecisions).toBe(1);
    expect(await store.get('lease:t1')).toBeNull();
  });

  it('batch timing: logs are held until the oldest exceeds the interval', async () => {
    const { cfg, submitter, tick } = makeCfg();
    await enqueue(cfg, 't1', log(1));
    const held = await drainTenant(cfg, 't1');
    expect(held.pendingLogsHeld).toBe(1);
    expect(held.sealedBatches).toBe(0);
    expect(submitter.submitted.length).toBe(0);

    tick(61_000);
    const due = await drainTenant(cfg, 't1');
    expect(due.sealedBatches).toBe(1);
  });

  it('at-least-once: a crash after submit re-submits the same record, dedupe-able by event_id', async () => {
    const base = makeCfg();
    let failNextChainStatePut = true;
    const flakyStore: OutboxStore = {
      get: (k) => base.store.get(k),
      delete: (k) => base.store.delete(k),
      list: (p) => base.store.list(p),
      put: async (k, v, o) => {
        if (failNextChainStatePut && k.startsWith('chainstate:')) {
          failNextChainStatePut = false;
          throw new Error('synthetic crash between submit and state persist');
        }
        return base.store.put(k, v, o);
      },
    };
    const cfg = { ...base.cfg, store: flakyStore };

    await enqueue(cfg, 't1', decision(1));
    const crashed = await drainTenant(cfg, 't1');
    expect(crashed.error).toMatch(/synthetic crash/);
    expect(base.submitter.submitted.length).toBe(1); // submit happened

    const retried = await drainTenant(cfg, 't1');
    expect(retried.error).toBeUndefined();
    expect(base.submitter.submitted.length).toBe(2); // duplicate on the topic
    const [a, b] = base.submitter.submitted.map((s) => decode(s.encoded));
    expect(a.event_id).toBe(b.event_id); // consumers dedupe on event_id
    expect(a.prev_hash).toBe(b.prev_hash); // identical record — benign duplicate
  });

  it('drains tenants independently (no cross-tenant chain bleed)', async () => {
    const { cfg, submitter } = makeCfg();
    await enqueue(cfg, 't1', decision(1));
    await enqueue(cfg, 't2', decision(2));
    await drainTenant(cfg, 't1');
    await drainTenant(cfg, 't2');
    const [r1, r2] = submitter.submitted.map((s) => decode(s.encoded));
    expect(r1.prev_hash).toBe(GENESIS_PREV_HASH);
    expect(r2.prev_hash).toBe(GENESIS_PREV_HASH); // t2 starts its own genesis
    expect(fromHex(String(r1.prev_hash)).length).toBe(32);
  });
});
