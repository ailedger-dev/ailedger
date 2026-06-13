// HCS v3 running-hash recompute — TypeScript port of cli/ailedger_cli/
// runninghash.py, restricted to the empirically pinned layout
// (v3/jos/payer/nanos-i32, ADR-016): Java ObjectOutputStream framing, payer
// account included, nanos int32. Pinned by the same real-mainnet fixture as
// the Python side; a divergence between the ports fails CI before it can
// mis-monitor.

const JOS_HEADER = hex('aced0005');
const JOS_BYTE_ARRAY_CLASSDESC = hex('7200025b42acf317f8060854e00200007870');
const JOS_TC_ARRAY = hex('75');
const JOS_CLASSDESC_REF = hex('71007e0000');
const JOS_TC_BLOCKDATA = hex('77');
const RUNNING_HASH_VERSION = 3n;

export interface RawTopicRow {
  consensus_timestamp: string;
  payer_account_id: string;
  sequence_number: number;
  message: string; // base64
  running_hash: string; // base64
  running_hash_version: number;
  topic_id?: string;
}

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function i64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, value);
  return out;
}

function i32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value);
  return out;
}

function entity(id: string): [bigint, bigint, bigint] {
  const [shard, realm, num] = id.split('.');
  return [BigInt(shard), BigInt(realm), BigInt(num)];
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

async function sha384(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-384', bytes.slice()));
}

/** Running hash after one message, given the 48-byte hash before it. */
export async function step(prev: Uint8Array, row: RawTopicRow, topicId: string): Promise<Uint8Array> {
  const [tsS, tsN = '0'] = row.consensus_timestamp.split('.');
  const prims = concat(
    i64(RUNNING_HASH_VERSION),
    ...entity(row.payer_account_id).map(i64),
    ...entity(topicId).map(i64),
    i64(BigInt(tsS)),
    i32(Number(tsN)),
    i64(BigInt(row.sequence_number)),
  );
  if (prims.byteLength >= 256) throw new Error('block-data short form exceeded');
  const messageDigest = await sha384(Uint8Array.from(Buffer.from(row.message, 'base64')));
  const lenBE = (n: number) => i32(n);
  const preimage = concat(
    JOS_HEADER,
    JOS_TC_ARRAY,
    JOS_BYTE_ARRAY_CLASSDESC,
    lenBE(prev.byteLength),
    prev,
    JOS_TC_BLOCKDATA,
    new Uint8Array([prims.byteLength]),
    prims,
    JOS_TC_ARRAY,
    JOS_CLASSDESC_REF,
    lenBE(messageDigest.byteLength),
    messageDigest,
  );
  return sha384(preimage);
}

export interface TailVerification {
  checked: number;
  matched: number;
  firstMismatchSeq: number | null;
}

/**
 * Verify adjacent running-hash links over a window of rows (ascending). The
 * first row's predecessor is unknown in a tail window, so checks start at
 * the second row — unless the window starts at seq 1 (genesis = 48 zeros).
 */
export async function verifyTail(rows: RawTopicRow[], topicId: string): Promise<TailVerification> {
  const sorted = [...rows].sort((a, b) => a.sequence_number - b.sequence_number);
  let checked = 0;
  let matched = 0;
  let firstMismatchSeq: number | null = null;
  for (let i = 0; i < sorted.length; i++) {
    let prev: Uint8Array;
    if (i > 0) prev = Uint8Array.from(Buffer.from(sorted[i - 1].running_hash, 'base64'));
    else if (sorted[i].sequence_number === 1) prev = new Uint8Array(48);
    else continue;
    checked++;
    const reported = Uint8Array.from(Buffer.from(sorted[i].running_hash, 'base64'));
    const computed = await step(prev, sorted[i], topicId);
    if (Buffer.from(computed).equals(Buffer.from(reported))) matched++;
    else firstMismatchSeq ??= sorted[i].sequence_number;
  }
  return { checked, matched, firstMismatchSeq };
}
