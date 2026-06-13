// Live end-to-end rails demo — the Phase 1 exit-criteria path:
//   emit (2 decisions with sealed payloads + 3 inference logs)
//   → outbox drain → sealed on the tenant's HCS topic
//   → read back from the PUBLIC MIRROR (no operator credentials)
//   → verify the app prev_hash chain + a batch inclusion proof.
//
// Usage: source ~/.secrets/hedera-testnet.env && node scripts/outbox-demo.mts <tenant-ref>
// Then validate the network running hash:
//   node scripts/spike-hcs.mts mirror-dump <topicId> /tmp/dump.json
//   (cd ../cli && PYTHONPATH=src python3 -m ailedger_cli.runninghash /tmp/dump.json)
import {
  generateDek,
  generateEventSalt,
  sealPayload,
  encodeLeaf,
  inclusionProof,
  merkleRoot,
  verifyInclusion,
  toHex,
  GENESIS_PREV_HASH,
} from '@ailedger/sdk';
import { createHederaClient, readHederaEnv } from '../src/hedera/client.ts';
import {
  drainTenant,
  enqueue,
  type OutboxConfig,
  type OutboxStore,
  type SealedInfo,
} from '../src/hedera/outbox.ts';
import { loadTenantSecrets, secretsSubmitter } from '../src/hedera/submit.ts';

const tenantRef = process.argv[2] ?? 'jv-fleet';
const env = readHederaEnv(process.env);

class MemoryStore implements OutboxStore {
  data = new Map<string, string>();
  async get(k: string) {
    return this.data.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.data.set(k, v);
  }
  async delete(k: string) {
    this.data.delete(k);
  }
  async list(p: string) {
    return [...this.data.keys()].filter((k) => k.startsWith(p)).sort();
  }
}

async function sha256hexOf(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const client = await createHederaClient(env);
const sealed: SealedInfo[] = [];
const cfg: OutboxConfig = {
  store: new MemoryStore(),
  submitter: secretsSubmitter(client, env.network),
  onSealed: (info) => {
    sealed.push(info);
  },
};

// --- emit: two decisions with REAL sealed payloads -------------------------
for (const n of [1, 2]) {
  const eventId = crypto.randomUUID();
  const salt = generateEventSalt();
  const dek = generateDek();
  const commitInputs = {
    inputs: { applicant_features: 14, role: 'demo' },
    output: { decision: n === 1 ? 'advance' : 'review', score: 0.8 + n / 100 },
    context: { collection_method: 'blind' },
    actions: { flags_raised: [], required_actions: [], actions_taken: [] },
    trace: [`call-${n}a`, `call-${n}b`],
  };
  const { payloadHash } = await sealPayload(
    dek,
    {
      subject_id: 'f0'.repeat(32), // HMAC pseudonym — payload-only, never on-chain
      ...commitInputs,
      event_salt: toHex(salt),
    },
    eventId,
  );
  await enqueue(cfg, tenantRef, {
    kind: 'decision',
    eventId,
    decisionType: 'employment_screening',
    ts: new Date().toISOString(),
    humanInLoop: false,
    modelWeightsHash: null,
    commitInputs,
    saltHex: toHex(salt),
    payloadHash,
  });
}
// --- emit: three inference logs --------------------------------------------
for (const n of [1, 2, 3]) {
  await enqueue(cfg, tenantRef, {
    kind: 'log',
    ts: new Date().toISOString(),
    logRecord: { call_id: `call-${n}`, provider: 'demo', input_hash: 'aa'.repeat(32), n },
  });
}

console.log('draining outbox (2 decisions + 1 forced batch of 3 logs)…');
const result = await drainTenant(cfg, tenantRef, { forceBatch: true });
if (result.error) {
  console.error('drain error:', result.error);
  process.exit(1);
}
console.log(
  `sealed: ${result.sealedDecisions} decisions + ${result.sealedBatches} batch — seqs ${sealed
    .map((s) => s.sequenceNumber)
    .join(', ')}`,
);

// --- verify from the PUBLIC MIRROR (operator-independent) -------------------
const { topicId } = loadTenantSecrets(tenantRef, env.network);
console.log(`\nreading topic ${topicId} back via mirror…`);
await new Promise((r) => setTimeout(r, 3000));
const res = await fetch(`${env.mirrorRest}/api/v1/topics/${topicId}/messages?limit=100&order=asc`);
if (!res.ok) throw new Error(`mirror ${res.status}`);
const body = (await res.json()) as { messages: { sequence_number: number; message: string }[] };
const records = body.messages.map((m) => ({
  seq: m.sequence_number,
  bytes: Uint8Array.from(atob(m.message), (c) => c.charCodeAt(0)),
}));
console.log(`mirror shows ${records.length} message(s)`);

let prev = GENESIS_PREV_HASH;
let chainOk = true;
for (const r of records) {
  const rec = JSON.parse(new TextDecoder().decode(r.bytes)) as Record<string, unknown>;
  const linkOk = rec.prev_hash === prev;
  chainOk &&= linkOk;
  console.log(
    `  seq ${r.seq} ${String(rec.v).padEnd(6)} prev_hash ${linkOk ? 'LINKS' : 'BROKEN'} ${
      rec.v === 'ode-2' ? `event=${String(rec.event_id).slice(0, 8)}…` : `leaves=${rec.leaf_count}`
    }`,
  );
  prev = await sha256hexOf(r.bytes);
}

// --- batch inclusion proof from the sealed manifest -------------------------
const batch = sealed.find((s) => s.kind === 'batch');
let proofOk = false;
if (batch?.kind === 'batch') {
  const leaves = batch.logs.map((l) => encodeLeaf(l));
  const root = await merkleRoot(leaves);
  const proof = await inclusionProof(2, leaves);
  proofOk = await verifyInclusion(leaves[2], 2, leaves.length, proof, root);
  console.log(
    `batch ${batch.batchId.slice(0, 14)}… root=${batch.merkleRoot.slice(0, 16)}… inclusion proof for leaf 2: ${proofOk ? 'VERIFIES' : 'FAILS'}`,
  );
}

console.log(
  `\napp chain: ${chainOk ? 'CONTINUOUS' : 'BROKEN'}; inclusion proof: ${proofOk ? 'OK' : 'FAIL'}`,
);
client.close();
process.exit(chainOk && proofOk ? 0 : 1);
