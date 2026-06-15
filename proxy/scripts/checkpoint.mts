// Cross-topic checkpoint publisher — seals one chk-1 root over every tenant
// topic's head onto the public `checkpoints` topic. Operator tooling, run on a
// cadence (monthly per the Lodestar roadmap); like the outbox drainer this is a
// separate, key-holding process — the keyless CLI verifier reconciles its work.
//
//   checkpoint.mts [--dry-run]
//
// Env: source ~/.secrets/hedera-testnet.env. Reads the provision state for the
// checkpoints topic id + registry submit key; discovers tenant topics and their
// heads from the public mirror (no tenant keys needed — heads are public). The
// ordered head manifest appends to <outbox-root>/checkpoints.jsonl so a verifier
// can recompute the root with `ailedger verify-checkpoint`.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PrivateKey, TopicId } from '@hashgraph/sdk';
import { GENESIS_PREV_HASH } from '@ailedger/sdk';
import { createHederaClient, readHederaEnv } from '../src/hedera/client.ts';
import { buildCheckpoint, type TenantHead } from '../src/hedera/checkpoint.ts';
import { parseTenantCreatedAnnouncement } from '../src/hedera/topics-format.ts';
import { submitGuardedMessage } from '../src/hedera/topics.ts';

interface ProvisionState {
  network: string;
  registrySubmitKey: string;
  topics: Record<string, string>;
}

const env = readHederaEnv(process.env);
const STATE_PATH = join(homedir(), '.secrets', `hedera-provision.${env.network}.json`);
const OUTBOX_ROOT = process.env.AILEDGER_OUTBOX_DIR ?? join(homedir(), '.ailedger-outbox');
const MANIFESTS = join(OUTBOX_ROOT, 'checkpoints.jsonl');
const dryRun = process.argv.includes('--dry-run');

if (!existsSync(STATE_PATH)) {
  console.error(`no provision state at ${STATE_PATH} — run: provision-topics.mts init`);
  process.exit(2);
}
const state = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as ProvisionState;
const checkpointsTopic = state.topics.checkpoints;
const registryTenants = state.topics.registry_tenants;
if (!checkpointsTopic || !registryTenants) {
  console.error('provision state is missing the checkpoints / registry_tenants topic ids');
  process.exit(2);
}

const bytesFromB64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

async function sha256hex(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice())));
}

interface MirrorMsg {
  message: string;
  sequence_number: number;
  running_hash: string;
}

async function mirrorMessages(topicId: string, query: string): Promise<MirrorMsg[]> {
  const out: MirrorMsg[] = [];
  let url = `${env.mirrorRest}/api/v1/topics/${topicId}/messages?${query}`;
  for (;;) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`mirror ${res.status} for topic ${topicId}: ${await res.text()}`);
    const body = (await res.json()) as { messages: MirrorMsg[]; links?: { next?: string | null } };
    out.push(...body.messages);
    const next = body.links?.next;
    if (!next) break;
    url = `${env.mirrorRest}${next}`;
  }
  return out;
}

/** Discover tenant topics from registry.tenants (last announcement per ref wins). */
async function discoverTenantTopics(): Promise<string[]> {
  const byRef = new Map<string, string>();
  for (const m of await mirrorMessages(registryTenants, 'limit=100&order=asc')) {
    try {
      const a = parseTenantCreatedAnnouncement(bytesFromB64(m.message));
      byRef.set(a.tenant_ref, a.topic_id);
    } catch {
      // non-announcement control-plane message — ignore
    }
  }
  return [...byRef.values()];
}

/** Latest message of a tenant topic → its head (seq + network running hash). */
async function tenantHead(topicId: string): Promise<TenantHead | null> {
  const msgs = await mirrorMessages(topicId, 'limit=1&order=desc');
  if (msgs.length === 0) return null; // empty topic — nothing to commit yet
  const m = msgs[0];
  return {
    topicId,
    sequenceNumber: m.sequence_number,
    runningHashHex: toHex(bytesFromB64(m.running_hash)),
  };
}

/** Prev-hash + window start from the last chk-1 on the checkpoints topic. */
async function checkpointTail(): Promise<{ prevHash: string; fromTs: string }> {
  const msgs = await mirrorMessages(checkpointsTopic, 'limit=1&order=desc');
  if (msgs.length === 0) return { prevHash: GENESIS_PREV_HASH, fromTs: 'genesis' };
  const bytes = bytesFromB64(msgs[0].message);
  const prevHash = await sha256hex(bytes);
  let fromTs = 'genesis';
  try {
    // Contiguous windows: this checkpoint starts where the previous one ended.
    fromTs = JSON.parse(new TextDecoder().decode(bytes)).period?.to_ts ?? 'genesis';
  } catch {
    /* unparseable previous record — leave fromTs at genesis */
  }
  return { prevHash, fromTs };
}

const topics = await discoverTenantTopics();
const heads = (await Promise.all(topics.map(tenantHead))).filter((h): h is TenantHead => h !== null);
if (heads.length === 0) {
  console.error(`no non-empty tenant topics under registry.tenants ${registryTenants} — nothing to checkpoint`);
  process.exit(0);
}

const { prevHash, fromTs } = await checkpointTail();
const toTs = new Date().toISOString();
const { record, encoded, manifest } = await buildCheckpoint({ prevHash, ts: toTs, fromTs, toTs, heads });

if (dryRun) {
  console.log(JSON.stringify({ record, manifest }, null, 2));
  console.log(`\n[dry-run] would seal ${encoded.byteLength} B over ${heads.length} tenant head(s)`);
  process.exit(0);
}

const client = await createHederaClient(env);
const seq = await submitGuardedMessage(
  client,
  TopicId.fromString(checkpointsTopic),
  PrivateKey.fromStringDer(state.registrySubmitKey),
  encoded,
);
client.close();

const ref = `${checkpointsTopic}:${seq}`;
mkdirSync(OUTBOX_ROOT, { recursive: true, mode: 0o700 });
appendFileSync(MANIFESTS, JSON.stringify({ sealedAt: new Date().toISOString(), ref, ...manifest }) + '\n', {
  mode: 0o600,
});
console.log(
  `checkpoint sealed: ${ref} tenant_root=${manifest.tenant_root.slice(0, 16)}… over ${heads.length} tenant head(s); manifest → ${MANIFESTS}`,
);
