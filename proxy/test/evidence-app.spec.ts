// Portable evidence app tests — Hono app exercised via app.request(), all
// deps faked. Ends with the full-circle auditor flow: HTTP ingest → vault →
// outbox drain → field commitments on the "on-chain" record verified from
// the opened payload.
import { describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../src/app';
import { MemoryOutboxStore } from '../src/hedera/store-memory';
import { drainTenant } from '../src/hedera/outbox';
import { MemoryVault } from '../src/vault/types';
import { unwrapDek, type KekProvider } from '../src/vault/kek';
import { fromHex, openPayload, payloadHashOf, verifyFieldCommitment } from '@ailedger/sdk';

const KEK = new Uint8Array(32).fill(42);
const keks: KekProvider = { getKek: async () => KEK };

function makeApp() {
  const vault = new MemoryVault();
  const store = new MemoryOutboxStore();
  const submitted: Uint8Array[] = [];
  const deps: AppDeps = {
    vault,
    keks,
    outbox: {
      store,
      submitter: {
        async submit(_t, encoded) {
          submitted.push(encoded);
          return { sequenceNumber: submitted.length };
        },
      },
    },
    authenticate: async (key) => (key === 'good-key' ? 'jv-fleet' : null),
  };
  return { app: createApp(deps), vault, store, submitted, deps };
}

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, key = 'good-key') =>
  app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const validEvent = {
  timestamp: '2026-06-12T18:00:00.000Z',
  decision_type: 'employment_screening',
  subject_id: 'f0'.repeat(32),
  output: { decision: 'advance', score: 0.91 },
  protected_class_context: { age_band: '40-55' },
  protected_class_collection_method: 'direct',
  flags_raised: [{ code: 'F1' }],
  trace: ['call-1'],
};

const unwarrantBody = {
  timestamp: '2026-06-12T18:00:00.000Z',
  decision_type: 'agent_decision',
  unwarrant_category: 'missing-justification',
  attempt: { decision: 'acted', warrant: { rejected_alternatives: ['x'] }, subject_id: 'f1'.repeat(32) },
};

describe('evidence app', () => {
  it('records an unwarranted decision: vault seals the attempt, outbox holds ode-2u', async () => {
    const { app, vault, store } = makeApp();
    const res = await post(app, '/v2/unwarranted-events', unwarrantBody);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { event_id: string; payload_hash: string; status: string };
    expect(body.status).toBe('queued');
    expect(await vault.get('jv-fleet', body.payload_hash)).not.toBeNull();
    const keys = await store.list('outbox:jv-fleet:');
    const item = JSON.parse((await store.get(keys[0]))!) as { kind: string; unwarrantCategory: string };
    expect(item.kind).toBe('unwarrant');
    expect(item.unwarrantCategory).toBe('missing-justification');
  });

  it('rejects an unwarrant with a bad category or missing attempt (400)', async () => {
    const { app } = makeApp();
    expect((await post(app, '/v2/unwarranted-events', { ...unwarrantBody, unwarrant_category: 'nope' })).status).toBe(400);
    const noAttempt: Record<string, unknown> = { ...unwarrantBody };
    delete noAttempt.attempt;
    expect((await post(app, '/v2/unwarranted-events', noAttempt)).status).toBe(400);
    expect((await post(app, '/v2/unwarranted-events', unwarrantBody, 'bad-key')).status).toBe(401);
  });

  it('healthz is open; /v2 requires auth', async () => {
    const { app } = makeApp();
    expect((await app.request('/healthz')).status).toBe(200);
    expect((await post(app, '/v2/detection-events', validEvent, 'bad-key')).status).toBe(401);
    const noAuth = await app.request('/v2/detection-events', {
      method: 'POST',
      body: JSON.stringify(validEvent),
    });
    expect(noAuth.status).toBe(401);
  });

  it('rejects invalid bodies with 400', async () => {
    const { app } = makeApp();
    expect((await post(app, '/v2/detection-events', { ...validEvent, timestamp: 'lol' })).status).toBe(400);
    const missingOutput: Record<string, unknown> = { ...validEvent };
    delete missingOutput.output;
    expect((await post(app, '/v2/detection-events', missingOutput)).status).toBe(400);
    const badJson = await app.request('/v2/detection-events', {
      method: 'POST',
      headers: { authorization: 'Bearer good-key' },
      body: '{nope',
    });
    expect(badJson.status).toBe(400);
  });

  it('queues a decision: vault holds the sealed payload, outbox holds the item', async () => {
    const { app, vault, store } = makeApp();
    const res = await post(app, '/v2/detection-events', validEvent);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { event_id: string; payload_hash: string; status: string };
    expect(body.status).toBe('queued');

    const entry = await vault.get('jv-fleet', body.payload_hash);
    expect(entry).not.toBeNull();
    expect(await payloadHashOf(entry!.blob)).toBe(body.payload_hash);

    const keys = await store.list('outbox:jv-fleet:');
    expect(keys.length).toBe(1);
    const item = JSON.parse((await store.get(keys[0]))!) as { payloadHash: string };
    expect(item.payloadHash).toBe(body.payload_hash);
  });

  it('queues inference logs', async () => {
    const { app, store } = makeApp();
    const res = await post(app, '/v2/inference-logs', {
      timestamp: '2026-06-12T18:00:01.000Z',
      call_id: 'call-1',
      input_hash: 'aa'.repeat(32),
    });
    expect(res.status).toBe(202);
    expect((await store.list('outbox:jv-fleet:')).length).toBe(1);
  });

  it('full circle: ingest → drain → auditor verifies commitments from the opened payload', async () => {
    const { app, vault, deps, submitted } = makeApp();
    const res = await post(app, '/v2/detection-events', validEvent);
    const { event_id, payload_hash } = (await res.json()) as {
      event_id: string;
      payload_hash: string;
    };

    const drained = await drainTenant(deps.outbox, 'jv-fleet');
    expect(drained.sealedDecisions).toBe(1);
    const record = JSON.parse(new TextDecoder().decode(submitted[0])) as Record<string, string>;
    expect(record.event_id).toBe(event_id);
    expect(record.payload_hash).toBe(payload_hash);

    // Auditor path: unwrap the DEK, open the payload, verify commitments.
    const entry = (await vault.get('jv-fleet', payload_hash))!;
    const dek = await unwrapDek(KEK, entry.wrappedDek, payload_hash);
    const payload = await openPayload(dek, entry.blob, event_id);
    expect(payload.subject_id).toBe(validEvent.subject_id);
    const salt = fromHex(String(payload.event_salt));
    expect(
      await verifyFieldCommitment(salt, 'output', payload.output, record.output_commit),
    ).toBe(true);
    expect(
      await verifyFieldCommitment(salt, 'context', payload.context, record.context_commit),
    ).toBe(true);
    // And the record itself never contains the subject.
    expect(new TextDecoder().decode(submitted[0])).not.toContain(validEvent.subject_id);
  });

  it('wrong KEK cannot unwrap; wrong payload_hash AAD cannot unwrap', async () => {
    const { app, vault } = makeApp();
    const res = await post(app, '/v2/detection-events', validEvent);
    const { payload_hash } = (await res.json()) as { payload_hash: string };
    const entry = (await vault.get('jv-fleet', payload_hash))!;
    await expect(unwrapDek(new Uint8Array(32).fill(9), entry.wrappedDek, payload_hash)).rejects.toThrow();
    await expect(unwrapDek(KEK, entry.wrappedDek, 'ff'.repeat(32))).rejects.toThrow();
  });
});
