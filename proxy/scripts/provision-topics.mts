// Operator CLI — provision the Hedera control plane and tenant topics.
//
//   init               create registry.{tenants,keys,schema} + checkpoints
//                      topics once; persist ids + keys to the ops state file.
//                      Refuses to run twice (never overwrites existing state).
//   tenant <ref>       create a tenant Logbook topic (fresh submitKey,
//                      2-of-3 adminKey from state) and announce it on
//                      registry.tenants. Refuses if the tenant file exists.
//   list               read registry.tenants from the MIRROR (operator-
//                      independent) and print parsed announcements.
//   info <topicId>     fetch TopicInfo and assert guards.
//
// State (testnet posture — production custody moves to KMS per plan Phase 4):
//   ~/.secrets/hedera-provision.<network>.json   control-plane keys + topic ids
//   ~/.secrets/hedera-tenants/<ref>.<network>.json  per-tenant submitKey + topic
//
// Env: source ~/.secrets/hedera-testnet.env (HEDERA_OPERATOR_ID/KEY[,NETWORK]).
import { PrivateKey, TopicId } from '@hashgraph/sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHederaClient, readHederaEnv } from '../src/hedera/client.ts';
import {
  buildTenantCreatedAnnouncement,
  checkpointsTopicMemo,
  parseTenantCreatedAnnouncement,
  registryTopicMemo,
  tenantTopicMemo,
  REGISTRY_NAMES,
} from '../src/hedera/topics-format.ts';
import {
  assertTopicGuards,
  createGuardedTopic,
  publicKeyFingerprint,
  submitGuardedMessage,
} from '../src/hedera/topics.ts';

interface ProvisionState {
  network: string;
  createdAt: string;
  adminKeys: { operator: string; customerPlaceholder: string; escrowPlaceholder: string };
  registrySubmitKey: string;
  topics: Record<string, string>;
}

interface TenantState {
  tenantRef: string;
  network: string;
  topicId: string;
  submitKey: string;
  createdAt: string;
  announcementSeq: number;
}

const env = readHederaEnv(process.env);
const STATE_PATH = join(homedir(), '.secrets', `hedera-provision.${env.network}.json`);
const TENANTS_DIR = join(homedir(), '.secrets', 'hedera-tenants');

function loadState(): ProvisionState {
  if (!existsSync(STATE_PATH)) {
    console.error(`no provision state at ${STATE_PATH} — run: provision-topics.mts init`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as ProvisionState;
}

function writeProtected(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

async function init(): Promise<void> {
  if (existsSync(STATE_PATH)) {
    console.error(`provision state already exists at ${STATE_PATH} — refusing to overwrite.`);
    process.exit(2);
  }
  const client = await createHederaClient(env);
  const adminKeys = {
    operator: PrivateKey.generateED25519(),
    customerPlaceholder: PrivateKey.generateED25519(),
    escrowPlaceholder: PrivateKey.generateED25519(),
  };
  const admin = {
    publicKeys: [
      adminKeys.operator.publicKey,
      adminKeys.customerPlaceholder.publicKey,
      adminKeys.escrowPlaceholder.publicKey,
    ],
    threshold: 2,
  };
  const adminSigners = [adminKeys.operator, adminKeys.customerPlaceholder];
  const registrySubmitKey = PrivateKey.generateED25519();

  const topics: Record<string, string> = {};
  for (const name of REGISTRY_NAMES) {
    const id = await createGuardedTopic(client, {
      memo: registryTopicMemo(name),
      submitPublicKey: registrySubmitKey.publicKey,
      admin,
      adminSigners,
    });
    topics[`registry_${name}`] = id.toString();
    console.log(`registry.${name} → ${id.toString()}`);
  }
  const checkpoints = await createGuardedTopic(client, {
    memo: checkpointsTopicMemo(),
    submitPublicKey: registrySubmitKey.publicKey,
    admin,
    adminSigners,
  });
  topics.checkpoints = checkpoints.toString();
  console.log(`checkpoints → ${checkpoints.toString()}`);

  const state: ProvisionState = {
    network: env.network,
    createdAt: new Date().toISOString(),
    adminKeys: {
      operator: adminKeys.operator.toStringDer(),
      customerPlaceholder: adminKeys.customerPlaceholder.toStringDer(),
      escrowPlaceholder: adminKeys.escrowPlaceholder.toStringDer(),
    },
    registrySubmitKey: registrySubmitKey.toStringDer(),
    topics,
  };
  writeProtected(STATE_PATH, state);
  console.log(`state → ${STATE_PATH}`);
  client.close();
}

async function tenant(tenantRef: string): Promise<void> {
  const state = loadState();
  mkdirSync(TENANTS_DIR, { recursive: true, mode: 0o700 });
  const tenantPath = join(TENANTS_DIR, `${tenantRef}.${env.network}.json`);
  if (existsSync(tenantPath)) {
    console.error(`tenant state already exists at ${tenantPath} — refusing to overwrite.`);
    process.exit(2);
  }
  const client = await createHederaClient(env);
  const adminPrivs = {
    operator: PrivateKey.fromStringDer(state.adminKeys.operator),
    customer: PrivateKey.fromStringDer(state.adminKeys.customerPlaceholder),
    escrow: PrivateKey.fromStringDer(state.adminKeys.escrowPlaceholder),
  };
  const admin = {
    publicKeys: [
      adminPrivs.operator.publicKey,
      adminPrivs.customer.publicKey,
      adminPrivs.escrow.publicKey,
    ],
    threshold: 2,
  };
  const submitKey = PrivateKey.generateED25519();
  const memo = tenantTopicMemo(tenantRef);
  const topicId = await createGuardedTopic(client, {
    memo,
    submitPublicKey: submitKey.publicKey,
    admin,
    adminSigners: [adminPrivs.operator, adminPrivs.customer],
  });
  console.log(`tenant ${tenantRef} → topic ${topicId.toString()} (memo: ${memo})`);

  const { encoded } = buildTenantCreatedAnnouncement({
    tenantRef,
    topicId: topicId.toString(),
    submitPubkeyHex: submitKey.publicKey.toStringRaw().toLowerCase(),
    adminThreshold: 2,
    adminKeyFingerprints: [
      await publicKeyFingerprint(adminPrivs.operator.publicKey),
      await publicKeyFingerprint(adminPrivs.customer.publicKey),
      await publicKeyFingerprint(adminPrivs.escrow.publicKey),
    ],
  });
  const registryTopic = TopicId.fromString(state.topics.registry_tenants);
  const seq = await submitGuardedMessage(
    client,
    registryTopic,
    PrivateKey.fromStringDer(state.registrySubmitKey),
    encoded,
  );
  console.log(`announced on registry.tenants (${registryTopic.toString()}) seq ${seq}`);

  const tenantState: TenantState = {
    tenantRef,
    network: env.network,
    topicId: topicId.toString(),
    submitKey: submitKey.toStringDer(),
    createdAt: new Date().toISOString(),
    announcementSeq: seq,
  };
  writeProtected(tenantPath, tenantState);
  console.log(`tenant state → ${tenantPath}`);
  client.close();
}

async function list(): Promise<void> {
  const state = loadState();
  const topic = state.topics.registry_tenants;
  let url = `${env.mirrorRest}/api/v1/topics/${topic}/messages?limit=100&order=asc`;
  let count = 0;
  for (;;) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`mirror ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      messages: { message: string; sequence_number: number }[];
      links?: { next?: string | null };
    };
    for (const row of body.messages) {
      try {
        const a = parseTenantCreatedAnnouncement(Uint8Array.from(atob(row.message), (c) => c.charCodeAt(0)));
        console.log(
          `#${row.sequence_number} tenant=${a.tenant_ref} topic=${a.topic_id} submit=${a.submit_pubkey.slice(0, 16)}… admin=${a.admin_threshold}-of-${a.admin_key_fingerprints.length}`,
        );
        count++;
      } catch (err) {
        console.log(`#${row.sequence_number} UNPARSEABLE: ${String((err as Error).message).slice(0, 60)}`);
      }
    }
    const next = body.links?.next;
    if (!next) break;
    url = `${env.mirrorRest}${next}`;
  }
  console.log(`${count} tenant announcement(s) on registry.tenants ${topic} (read via mirror)`);
}

async function info(topicIdStr: string): Promise<void> {
  const client = await createHederaClient(env);
  await assertTopicGuards(client, TopicId.fromString(topicIdStr), await memoOf(topicIdStr));
  console.log(`topic ${topicIdStr}: guards OK (memo matches, submitKey + adminKey present)`);
  client.close();
}

async function memoOf(topicIdStr: string): Promise<string> {
  const res = await fetch(`${env.mirrorRest}/api/v1/topics/${topicIdStr}`);
  if (!res.ok) throw new Error(`mirror ${res.status}`);
  const body = (await res.json()) as { memo?: string };
  return body.memo ?? '';
}

const [, , cmd, ...args] = process.argv;
switch (cmd) {
  case 'init':
    await init();
    break;
  case 'tenant':
    if (!args[0]) {
      console.error('usage: provision-topics.mts tenant <tenant-ref>');
      process.exit(2);
    }
    await tenant(args[0]);
    break;
  case 'list':
    await list();
    break;
  case 'info':
    await info(args[0]);
    break;
  default:
    console.log('usage: node scripts/provision-topics.mts <init|tenant <ref>|list|info <topicId>>');
    process.exit(2);
}
