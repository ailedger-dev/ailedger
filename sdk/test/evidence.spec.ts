// Evidence core tests — ode-2 records, RFC 6962 Merkle, envelope.
import { describe, expect, it } from 'vitest';
import {
  buildBatchRecord,
  buildDecisionRecord,
  commitField,
  encodeRecord,
  generateEventSalt,
  MAX_RECORD_BYTES,
  verifyFieldCommitment,
} from '../src/evidence/record.js';
import {
  encodeLeaf,
  fromHex,
  inclusionProof,
  leafHash,
  merkleRoot,
  merkleRootHex,
  toHex,
  verifyInclusion,
} from '../src/evidence/merkle.js';
import { generateDek, openPayload, payloadHashOf, sealPayload } from '../src/evidence/envelope.js';

const HEX64 = /^[0-9a-f]{64}$/;
const SALT = new Uint8Array(32).fill(7);

function baseParams() {
  return {
    eventId: '3f2c1a9e-7b4d-4e0a-9c1f-2d5b8a6e4f01',
    decisionType: 'employment_screening',
    ts: '2026-06-12T17:00:00.000000Z',
    prevHash: '0'.repeat(64),
    humanInLoop: false,
    modelWeightsHash: 'ab'.repeat(32),
    commitInputs: {
      inputs: { resume_tokens: 1832, role: 'staff-engineer' },
      output: { decision: 'advance', score: 0.92 },
      context: { collection_method: 'blind' },
      actions: { flags_raised: [], required_actions: [], actions_taken: [] },
      trace: ['log-1', 'log-2'],
    },
    salt: SALT,
    payloadHash: 'cd'.repeat(32),
  };
}

describe('ode-2 decision record', () => {
  it('builds a deterministic lean record under the size cap', async () => {
    const a = await buildDecisionRecord(baseParams());
    const b = await buildDecisionRecord(baseParams());
    expect(toHex(a.encoded)).toBe(toHex(b.encoded));
    expect(a.encoded.byteLength).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    expect(a.record.v).toBe('ode-2');
    expect(a.record.profile).toBe('lean');
    for (const commit of [
      a.record.inputs_commit,
      a.record.output_commit,
      a.record.context_commit,
      a.record.actions_commit,
      a.record.trace_commit!,
    ]) {
      expect(commit).toMatch(HEX64);
    }
  });

  it('commitments are domain-separated: same value, different field ⇒ different commit', async () => {
    const value = { same: 'value' };
    const inputsCommit = await commitField(SALT, 'inputs', value);
    const outputCommit = await commitField(SALT, 'output', value);
    expect(inputsCommit).not.toBe(outputCommit);
  });

  it('commitments are hiding across salts: same value, different salt ⇒ different commit', async () => {
    const other = new Uint8Array(32).fill(8);
    expect(await commitField(SALT, 'inputs', { x: 1 })).not.toBe(
      await commitField(other, 'inputs', { x: 1 }),
    );
  });

  it('verifyFieldCommitment round-trips and rejects wrong values', async () => {
    const commit = await commitField(SALT, 'output', { decision: 'advance' });
    expect(await verifyFieldCommitment(SALT, 'output', { decision: 'advance' }, commit)).toBe(true);
    expect(await verifyFieldCommitment(SALT, 'output', { decision: 'reject' }, commit)).toBe(false);
  });

  it('null trace stays null; subject_id never appears in the encoded record', async () => {
    const params = baseParams();
    params.commitInputs.trace = null;
    const { record, encoded } = await buildDecisionRecord(params);
    expect(record.trace_commit).toBeNull();
    expect(new TextDecoder().decode(encoded)).not.toContain('subject');
  });

  it('rejects oversize records instead of chunking', async () => {
    const params = baseParams();
    params.decisionType = 'x'.repeat(1100);
    await expect(buildDecisionRecord(params)).rejects.toThrow(/hard cap/);
  });

  it('rejects malformed hex inputs', async () => {
    const params = baseParams();
    params.prevHash = 'not-hex';
    await expect(buildDecisionRecord(params)).rejects.toThrow(/prevHash/);
  });
});

describe('ode-2b batch record', () => {
  it('builds and encodes', () => {
    const { record, encoded } = buildBatchRecord({
      batchId: 'b-1',
      prevHash: '0'.repeat(64),
      merkleRoot: 'ef'.repeat(32),
      leafCount: 1000,
      fromTs: '2026-06-12T17:00:00Z',
      toTs: '2026-06-12T17:05:00Z',
    });
    expect(record.v).toBe('ode-2b');
    expect(record.leaf_spec).toBe('rfc6962-sha256/jcs-v1');
    expect(encoded.byteLength).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    expect(() => encodeRecord(record)).not.toThrow();
  });

  it('rejects zero leaves', () => {
    expect(() =>
      buildBatchRecord({
        batchId: 'b',
        prevHash: '0'.repeat(64),
        merkleRoot: 'ef'.repeat(32),
        leafCount: 0,
        fromTs: 't',
        toTs: 't',
      }),
    ).toThrow(/positive/);
  });
});

// Independent reference implementation of RFC 6962 MTH for cross-checking:
// recompute the root top-down with its own recursion, no shared code paths
// with inclusionProof/verifyInclusion.
async function referenceRoot(leaves: Uint8Array[]): Promise<Uint8Array> {
  if (leaves.length === 1) return leafHash(leaves[0]);
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  const left = await referenceRoot(leaves.slice(0, k));
  const right = await referenceRoot(leaves.slice(k));
  const buf = new Uint8Array(1 + left.length + right.length);
  buf[0] = 0x01;
  buf.set(left, 1);
  buf.set(right, 1 + left.length);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
}

describe('RFC 6962 merkle tree', () => {
  it('known answer: single-leaf root is SHA-256(0x00 ‖ leaf)', async () => {
    // RFC 6962: MTH({d0}) = SHA-256(0x00 || d0). For d0 = "" this is the
    // hash of the single byte 0x00.
    const root = await merkleRootHex([new Uint8Array(0)]);
    expect(root).toBe('6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d');
  });

  it('every (treeSize ≤ 16, index) inclusion proof verifies against the reference root', async () => {
    for (let n = 1; n <= 16; n++) {
      const leaves = Array.from({ length: n }, (_, i) => encodeLeaf({ log: i, n }));
      const root = await merkleRoot(leaves);
      expect(toHex(root)).toBe(toHex(await referenceRoot(leaves)));
      for (let i = 0; i < n; i++) {
        const proof = await inclusionProof(i, leaves);
        expect(await verifyInclusion(leaves[i], i, n, proof, root)).toBe(true);
        // Wrong leaf must fail.
        expect(await verifyInclusion(encodeLeaf({ log: 'tampered' }), i, n, proof, root)).toBe(
          false,
        );
        // Wrong index must fail.
        expect(await verifyInclusion(leaves[i], (i + 1) % n, n, proof, root)).toBe(
          n === 1 ? true : false,
        );
      }
    }
  });

  it('proof length is O(log n) — 1000 leaves ⇒ ≤ 10 siblings', async () => {
    const leaves = Array.from({ length: 1000 }, (_, i) => encodeLeaf({ i }));
    const proof = await inclusionProof(500, leaves);
    expect(proof.length).toBeLessThanOrEqual(10);
    expect(await verifyInclusion(leaves[500], 500, 1000, proof, await merkleRoot(leaves))).toBe(
      true,
    );
  });

  it('truncated and padded proofs are rejected', async () => {
    const leaves = Array.from({ length: 8 }, (_, i) => encodeLeaf({ i }));
    const root = await merkleRoot(leaves);
    const proof = await inclusionProof(3, leaves);
    expect(await verifyInclusion(leaves[3], 3, 8, proof.slice(1), root)).toBe(false);
    expect(await verifyInclusion(leaves[3], 3, 8, [...proof, proof[0]], root)).toBe(false);
  });

  it('hex helpers round-trip', () => {
    const bytes = new Uint8Array([0, 1, 0xab, 0xff]);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
    expect(() => fromHex('zz')).toThrow(/invalid hex/);
  });
});

describe('payload envelope', () => {
  const payload = {
    subject_id: 'a1'.repeat(32),
    protected_class_context: { age_band: '40-55' },
    output: { decision: 'advance', score: 0.92 },
    event_salt: toHex(SALT),
  };

  it('seals and opens round-trip; payload_hash binds the blob', async () => {
    const dek = generateDek();
    const sealed = await sealPayload(dek, payload, 'event-1');
    expect(sealed.payloadHash).toMatch(HEX64);
    expect(await payloadHashOf(sealed.blob)).toBe(sealed.payloadHash);
    expect(await openPayload(dek, sealed.blob, 'event-1')).toEqual(payload);
  });

  it('wrong DEK, wrong eventId (AAD), and bit-tampering all fail closed', async () => {
    const dek = generateDek();
    const sealed = await sealPayload(dek, payload, 'event-1');
    await expect(openPayload(generateDek(), sealed.blob, 'event-1')).rejects.toThrow();
    await expect(openPayload(dek, sealed.blob, 'event-2')).rejects.toThrow();
    const tampered = new Uint8Array(sealed.blob);
    tampered[tampered.length - 1] ^= 0x01;
    await expect(openPayload(dek, tampered, 'event-1')).rejects.toThrow();
  });

  it('ciphertext is non-deterministic (fresh IV) but hash always matches its own blob', async () => {
    const dek = generateDek();
    const a = await sealPayload(dek, payload, 'e');
    const b = await sealPayload(dek, payload, 'e');
    expect(a.payloadHash).not.toBe(b.payloadHash);
    expect(await payloadHashOf(b.blob)).toBe(b.payloadHash);
  });
});
