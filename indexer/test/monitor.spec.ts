// Monitor v2 + archiver + running-hash port tests.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyTail, type RawTopicRow } from '../src/runninghash.ts';
import { dispatchAlerts, runMonitor, type MonitorDeps, type MonitorFinding, type MonitorReport } from '../src/monitor.ts';
import { archiveAll, validateBundle, type RawRowFetcher } from '../src/archiver.ts';
import { createIndexerApi, type ApiState } from '../src/api.ts';
import { ingestAll } from '../src/ingest.ts';
import { IndexerStore } from '../src/store.ts';
import type { MirrorSource } from '../src/mirror.ts';
import type { MirrorMessage } from '../src/parse.ts';
import { Buffer } from 'node:buffer';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(join(here, 'fixtures', 'hcs-mainnet-368908.json'), 'utf-8'),
) as { messages: RawTopicRow[] };

describe('running-hash TS port', () => {
  it('matches real mainnet data byte-for-byte (same fixture as the Python side)', async () => {
    const result = await verifyTail(FIXTURE.messages, '0.0.368908');
    expect(result.checked).toBe(2); // 3 mid-chain rows → 2 adjacent links
    expect(result.matched).toBe(2);
    expect(result.firstMismatchSeq).toBeNull();
  });

  it('detects a tampered tail at the exact sequence', async () => {
    const tampered = FIXTURE.messages.map((m, i) =>
      i === 1 ? { ...m, message: Buffer.from('forged').toString('base64') } : m,
    );
    const result = await verifyTail(tampered, '0.0.368908');
    expect(result.matched).toBeLessThan(result.checked);
    // Forging row 1's bytes breaks BOTH its own link and its successor's
    // (the successor's prev comes from the reported hash, which no longer
    // matches recompute over forged bytes... successor uses reported prev, so
    // only row 1's own link breaks).
    expect(result.firstMismatchSeq).toBe(FIXTURE.messages[1].sequence_number);
  });
});

// --- fixture topic via fake mirror (reusing ingest machinery) -----------------

const REGISTRY = '0.0.100';
const TENANT_TOPIC = '0.0.200';

function fakeMirror(): MirrorSource & { push(topicId: string, bytes: Uint8Array): void } {
  const topics = new Map<string, MirrorMessage[]>();
  return {
    push(topicId: string, bytes: Uint8Array): void {
      const msgs = topics.get(topicId) ?? [];
      msgs.push({
        sequence_number: msgs.length + 1,
        consensus_timestamp: `17813000${String(msgs.length).padStart(2, '0')}.000000000`,
        message: Buffer.from(bytes).toString('base64'),
      });
      topics.set(topicId, msgs);
    },
    async fetchMessages(topicId: string, afterSeq: number): Promise<MirrorMessage[]> {
      return (topics.get(topicId) ?? []).filter((m) => m.sequence_number > afterSeq);
    },
  };
}

function announcement(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      v: 'reg-1',
      kind: 'tenant-created',
      tenant_ref: 'jv-fleet',
      topic_id: TENANT_TOPIC,
      submit_pubkey: 'ab'.repeat(32),
      admin_threshold: 2,
      admin_key_fingerprints: ['ef'.repeat(32), 'ef'.repeat(32), 'ef'.repeat(32)],
    }),
  );
}

function decisionBytes(n: number, prevHash: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      v: 'ode-2',
      event_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      decision_type: 'x',
      ts: 't',
      prev_hash: prevHash,
      payload_hash: 'cd'.repeat(32),
      human_in_loop: false,
    }),
  );
}

async function sha256hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('monitor v2', () => {
  let store: IndexerStore;
  let mirror: ReturnType<typeof fakeMirror>;
  let fetchSpy: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(async () => {
    store = new IndexerStore(':memory:');
    mirror = fakeMirror();
    mirror.push(REGISTRY, announcement());
    const d1 = decisionBytes(1, '0'.repeat(64));
    mirror.push(TENANT_TOPIC, d1);
    mirror.push(TENANT_TOPIC, decisionBytes(2, await sha256hex(d1)));
    await ingestAll(store, mirror, REGISTRY);
    // topic-guards check fetches the mirror REST directly — fake globally.
    fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ submit_key: { key: 'aa' } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    store.close();
  });

  function deps(overrides: Partial<MonitorDeps> = {}): MonitorDeps {
    return {
      store,
      mirror,
      mirrorBase: 'http://fake-mirror',
      rawRows: { fetchTail: async () => [] }, // tail too short → WARN
      ...overrides,
    };
  }

  it('clean topic: gaps PASS, app-chain PASS, guards PASS', async () => {
    const report = await runMonitor(deps());
    const byCheck = Object.fromEntries(report.findings.map((f) => [f.check, f.level]));
    expect(byCheck['sequence-gaps']).toBe('PASS');
    expect(byCheck['app-chain']).toBe('PASS');
    expect(byCheck['topic-guards']).toBe('PASS');
    expect(byCheck['running-hash']).toBe('WARN'); // empty tail
  });

  it('missing submitKey is a FAIL and fires the alert sink', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ submit_key: null }), { status: 200 }));
    const report = await runMonitor(deps());
    expect(report.findings.some((f) => f.check === 'topic-guards' && f.level === 'FAIL')).toBe(true);

    const captured: MonitorFinding[][] = [];
    const fired = await dispatchAlerts(report, async (_r: MonitorReport, failures) => {
      captured.push(failures);
    });
    expect(fired).toBe(true);
    expect(captured[0].some((f) => f.check === 'topic-guards')).toBe(true);
  });

  it('sealed-sla: manifest entries beyond the indexed tail FAIL', async () => {
    const report = await runMonitor(
      deps({ manifestEntries: [{ sequenceNumber: 99, tenantRef: 'jv-fleet' }] }),
    );
    expect(report.findings.some((f) => f.check === 'sealed-sla' && f.level === 'FAIL')).toBe(true);
    const ok = await runMonitor(
      deps({ manifestEntries: [{ sequenceNumber: 2, tenantRef: 'jv-fleet' }] }),
    );
    expect(ok.findings.some((f) => f.check === 'sealed-sla' && f.level === 'PASS')).toBe(true);
  });

  it('no alert fires when everything passes or warns', async () => {
    const report = await runMonitor(deps());
    expect(await dispatchAlerts(report, async () => {})).toBe(false);
  });

  it('/v1/health serves the last report with correct status code', async () => {
    const state: ApiState = {};
    const api = createIndexerApi(store, state);
    expect((await api.request('/v1/health')).status).toBe(503);
    state.lastMonitorReport = await runMonitor(deps());
    const res = await api.request('/v1/health');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('warn');
  });
});

describe('archiver', () => {
  it('exports court bundles + manifest; detects bundle tampering', async () => {
    const store = new IndexerStore(':memory:');
    const mirror = fakeMirror();
    mirror.push(REGISTRY, announcement());
    mirror.push(TENANT_TOPIC, decisionBytes(1, '0'.repeat(64)));
    await ingestAll(store, mirror, REGISTRY);

    const fetcher: RawRowFetcher = {
      fetchAll: async (topicId) =>
        (await mirror.fetchMessages(topicId, 0)).map((m) => ({
          ...m,
          payer_account_id: '0.0.1',
          running_hash: 'AA==',
          running_hash_version: 3,
        })),
    };
    const dir = await mkdtemp(join(tmpdir(), 'ailedger-bundle-'));
    try {
      const results = await archiveAll(store, fetcher, REGISTRY, dir);
      expect(results.length).toBe(2); // registry + tenant topic
      expect((await validateBundle(dir)).ok).toBe(true);

      // Tamper with an archived file → manifest validation fails. (Message
      // bodies are base64 in the rows, so mutate a structural field.)
      const victim = results[1].file;
      const original = await readFile(victim, 'utf-8');
      const tampered = original.replace('"sequence_number": 1', '"sequence_number": 9');
      expect(tampered).not.toBe(original);
      await writeFile(victim, tampered, 'utf-8');
      const after = await validateBundle(dir);
      expect(after.ok).toBe(false);
      expect(after.detail).toContain('sha256');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    store.close();
  });
});
