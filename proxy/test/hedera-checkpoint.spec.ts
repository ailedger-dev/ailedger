// Checkpoint core — pure compute over tenant heads (no SDK keys, no network).
import { describe, expect, it } from 'vitest';
import { checkpointLeaf, merkleRootHex } from '@ailedger/sdk';
import { buildCheckpoint, computeTenantRoot, sortTenantHeads } from '../src/hedera/checkpoint.ts';

// 96-hex (48-byte SHA-384) running hash, distinct per topic.
const head = (n: number, seq: number) => ({
  topicId: `0.0.${n}`,
  sequenceNumber: seq,
  runningHashHex: (n % 16).toString(16).repeat(96),
});

describe('checkpoint core', () => {
  it('orders heads by NUMERIC topic id, not lexicographic', () => {
    const ordered = sortTenantHeads([head(200, 1), head(30, 1), head(201, 1)]);
    expect(ordered.map((h) => h.topicId)).toEqual(['0.0.30', '0.0.200', '0.0.201']);
  });

  it('tenant_root is independent of input order (canonical sort)', async () => {
    const heads = [head(200, 7), head(30, 3), head(201, 9)];
    const a = await computeTenantRoot(heads);
    const b = await computeTenantRoot([heads[2], heads[0], heads[1]]);
    expect(a).toBe(b);
  });

  it('root equals the RFC 6962 root over leaves in canonical order', async () => {
    const heads = [head(200, 7), head(30, 3)];
    const expected = await merkleRootHex(sortTenantHeads(heads).map((h) => checkpointLeaf(h)));
    expect(await computeTenantRoot(heads)).toBe(expected);
  });

  it('builds a chk-1 + manifest with sorted heads and matching root', async () => {
    const { record, manifest } = await buildCheckpoint({
      prevHash: '0'.repeat(64),
      ts: '2026-06-14T00:00:00.000Z',
      fromTs: '2026-05-14T00:00:00.000Z',
      toTs: '2026-06-14T00:00:00.000Z',
      heads: [head(201, 9), head(30, 3)],
    });
    expect(record.v).toBe('chk-1');
    expect(record.tenant_count).toBe(2);
    expect(record.tenant_root).toBe(manifest.tenant_root);
    expect(manifest.heads.map((h) => h.topic_id)).toEqual(['0.0.30', '0.0.201']);
    expect(manifest.heads[0]).toMatchObject({ topic_id: '0.0.30', sequence_number: 3 });
  });

  it('refuses an empty estate', async () => {
    await expect(computeTenantRoot([])).rejects.toThrow(/empty estate/);
  });
});
