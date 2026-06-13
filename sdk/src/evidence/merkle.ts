// AILedger SDK — RFC 6962 (Certificate Transparency) Merkle tree.
//
// The inference-log batching primitive: thousands of logs per tenant per
// interval collapse to one anchored root, while every individual log keeps an
// O(log n) inclusion proof. RFC 6962 is used deliberately over a naive
// pairwise tree: the 0x00/0x01 leaf/node domain prefixes prevent
// second-preimage ("node-as-leaf") attacks, and the unbalanced-tree split
// (largest power of two strictly less than n) gives stable proofs for any
// leaf count — this is the proven CT design the Lodestar integrity roadmap
// cites (roadmap v3).
//
// Leaf preimage contract (leaf_spec 'rfc6962-sha256/jcs-v1'):
//   leaf bytes = UTF-8(JCS(log record)); leafHash = SHA-256(0x00 ‖ leaf bytes).

import canonicalize from 'canonicalize';

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    buf.set(part, offset);
    offset += part.byteLength;
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/.test(hex)) throw new Error(`invalid hex: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Encode an arbitrary JCS-serializable log record into leaf bytes. */
export function encodeLeaf(value: unknown): Uint8Array {
  const jcs = canonicalize(value as Parameters<typeof canonicalize>[0]);
  if (jcs === undefined) throw new Error('leaf value is not JCS-serializable');
  return new TextEncoder().encode(jcs);
}

export async function leafHash(leafBytes: Uint8Array): Promise<Uint8Array> {
  return sha256(new Uint8Array([LEAF_PREFIX]), leafBytes);
}

async function nodeHash(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  return sha256(new Uint8Array([NODE_PREFIX]), left, right);
}

/** Largest power of two strictly less than n (RFC 6962 split point), n >= 2. */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** RFC 6962 MTH over the leaf byte arrays. Throws on an empty batch. */
export async function merkleRoot(leaves: Uint8Array[]): Promise<Uint8Array> {
  if (leaves.length === 0) throw new Error('empty batch has no root (do not anchor empties)');
  if (leaves.length === 1) return leafHash(leaves[0]);
  const k = splitPoint(leaves.length);
  const [left, right] = await Promise.all([
    merkleRoot(leaves.slice(0, k)),
    merkleRoot(leaves.slice(k)),
  ]);
  return nodeHash(left, right);
}

export async function merkleRootHex(leaves: Uint8Array[]): Promise<string> {
  return toHex(await merkleRoot(leaves));
}

/**
 * RFC 6962 §2.1.1 audit PATH for the leaf at `index` — the sibling hashes
 * bottom-up that, combined with the leaf hash, reproduce the root.
 */
export async function inclusionProof(index: number, leaves: Uint8Array[]): Promise<Uint8Array[]> {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new Error(`leaf index ${index} out of range [0, ${leaves.length})`);
  }
  if (leaves.length === 1) return [];
  const k = splitPoint(leaves.length);
  if (index < k) {
    const path = await inclusionProof(index, leaves.slice(0, k));
    path.push(await merkleRoot(leaves.slice(k)));
    return path;
  }
  const path = await inclusionProof(index - k, leaves.slice(k));
  path.push(await merkleRoot(leaves.slice(0, k)));
  return path;
}

/**
 * Verify an inclusion proof — the exact iterative algorithm from RFC 9162
 * §2.1.3.2 (the successor spec to RFC 6962; proofs are leaf-adjacent-first,
 * as produced by inclusionProof above). Pure function of public data — this
 * is what auditors and the verifier CLI run; it must not depend on any
 * AILedger service.
 */
export async function verifyInclusion(
  leafBytes: Uint8Array,
  index: number,
  treeSize: number,
  proof: Uint8Array[],
  expectedRoot: Uint8Array,
): Promise<boolean> {
  if (!Number.isInteger(index) || index < 0 || index >= treeSize) return false;
  let fn = index;
  let sn = treeSize - 1;
  let r = await leafHash(leafBytes);
  for (const p of proof) {
    if (sn === 0) return false; // proof longer than the tree
    if (fn % 2 === 1 || fn === sn) {
      r = await nodeHash(p, r);
      if (fn % 2 === 0) {
        // Right-edge promotion: ascend until fn is odd or reaches the root.
        do {
          fn = fn >>> 1;
          sn = sn >>> 1;
        } while (fn % 2 === 0 && fn !== 0);
      }
    } else {
      r = await nodeHash(r, p);
    }
    fn = fn >>> 1;
    sn = sn >>> 1;
  }
  return sn === 0 && toHex(r) === toHex(expectedRoot);
}
