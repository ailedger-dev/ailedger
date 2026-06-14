// Operator-side OWT tooling — provision an operator's warrant-health topic and
// publish signed owh-1 aggregates (Phase B).
//
//   operator-init <operator-id>          create the operator's warrant-health
//                                        topic + announce on registry.operators
//                                        (lazily creates registry.operators if
//                                        the provision state predates it).
//   publish <operator-id> <tenant>...    count warranted/unwarranted from the
//                                        tenants' sealed chains (public mirror),
//                                        compute the gap-honest verdict, seal an
//                                        owh-1 on the operator's warrant-health
//                                        topic (prev_hash threaded).
//
// Env: source ~/.secrets/hedera-testnet.env. Operator state:
//   ~/.secrets/hedera-operators/<id>.<network>.json (warrant-health topic + key)
import { PrivateKey, PublicKey, TopicId } from '@hashgraph/sdk';
import { computeWarrantHealth, buildWarrantHealthRecord } from '@ailedger/sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHederaClient, readHederaEnv } from '../src/hedera/client.ts';
import {
  buildOperatorCreatedAnnouncement,
  registryTopicMemo,
  warrantHealthTopicMemo,
} from '../src/hedera/topics-format.ts';
import { createGuardedTopic, submitGuardedMessage } from '../src/hedera/topics.ts';

const env = readHederaEnv(process.env);
const STATE_PATH = join(homedir(), '.secrets', `hedera-provision.${env.network}.json`);
const OPERATORS_DIR = join(homedir(), '.secrets', 'hedera-operators');
const TENANTS_DIR = join(homedir(), '.secrets', 'hedera-tenants');

interface ProvisionState {
  adminKeys: { operator: string; customerPlaceholder: string; escrowPublicKey: string };
  registrySubmitKey: string;
  topics: Record<string, string>;
}

function loadState(): ProvisionState {
  if (!existsSync(STATE_PATH)) {
    console.error(`no provision state at ${STATE_PATH} — run provision-topics.mts init first`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as ProvisionState;
}

function adminSet(state: ProvisionState) {
  const operator = PrivateKey.fromStringDer(state.adminKeys.operator);
  const customer = PrivateKey.fromStringDer(state.adminKeys.customerPlaceholder);
  const escrow = PublicKey.fromString(state.adminKeys.escrowPublicKey);
  return {
    admin: { publicKeys: [operator.publicKey, customer.publicKey, escrow], threshold: 2 },
    adminSigners: [operator, customer],
  };
}

async function ensureOperatorsRegistry(client: Awaited<ReturnType<typeof createHederaClient>>, state: ProvisionState): Promise<string> {
  if (state.topics.registry_operators) return state.topics.registry_operators;
  const { admin, adminSigners } = adminSet(state);
  const id = await createGuardedTopic(client, {
    memo: registryTopicMemo('operators'),
    submitPublicKey: PrivateKey.fromStringDer(state.registrySubmitKey).publicKey,
    admin,
    adminSigners,
  });
  state.topics.registry_operators = id.toString();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  console.log(`registry.operators → ${id.toString()} (patched into state)`);
  return id.toString();
}

async function operatorInit(operatorId: string): Promise<void> {
  const state = loadState();
  mkdirSync(OPERATORS_DIR, { recursive: true, mode: 0o700 });
  const opPath = join(OPERATORS_DIR, `${operatorId}.${env.network}.json`);
  if (existsSync(opPath)) {
    console.error(`operator state already exists at ${opPath} — refusing to overwrite.`);
    process.exit(2);
  }
  const client = await createHederaClient(env);
  const registryOperators = await ensureOperatorsRegistry(client, state);
  const { admin, adminSigners } = adminSet(state);

  // One operator identity key: it is both the warrant-health topic's submitKey
  // and the announced operator_pubkey (identity bound to the writer).
  const operatorKey = PrivateKey.generateED25519();
  const whTopic = await createGuardedTopic(client, {
    memo: warrantHealthTopicMemo(operatorId),
    submitPublicKey: operatorKey.publicKey,
    admin,
    adminSigners,
  });
  console.log(`operator ${operatorId} warrant-health topic → ${whTopic.toString()}`);

  const { encoded } = buildOperatorCreatedAnnouncement({
    operatorId,
    operatorPubkeyHex: operatorKey.publicKey.toStringRaw().toLowerCase(),
    warrantHealthTopicId: whTopic.toString(),
  });
  const seq = await submitGuardedMessage(
    client,
    TopicId.fromString(registryOperators),
    PrivateKey.fromStringDer(state.registrySubmitKey),
    encoded,
  );
  console.log(`announced on registry.operators (${registryOperators}) seq ${seq}`);

  writeFileSync(
    opPath,
    JSON.stringify(
      {
        operatorId,
        network: env.network,
        warrantHealthTopicId: whTopic.toString(),
        operatorKey: operatorKey.toStringDer(),
        operatorPubkey: operatorKey.publicKey.toStringRaw(),
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  console.log(`operator state → ${opPath}`);
  client.close();
}

async function countTenant(tenantTopicId: string): Promise<{ warranted: number; byCategory: Record<string, number> }> {
  let warranted = 0;
  const byCategory: Record<string, number> = {};
  let url = `${env.mirrorRest}/api/v1/topics/${tenantTopicId}/messages?limit=100&order=asc`;
  for (;;) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`mirror ${res.status} for ${tenantTopicId}`);
    const body = (await res.json()) as {
      messages: { message: string }[];
      links?: { next?: string | null };
    };
    for (const m of body.messages) {
      const rec = JSON.parse(Buffer.from(m.message, 'base64').toString('utf8')) as Record<string, unknown>;
      if (rec.v === 'ode-2') warranted++;
      else if (rec.v === 'ode-2u') {
        const c = String(rec.unwarrant_category);
        byCategory[c] = (byCategory[c] ?? 0) + 1;
      }
    }
    const next = body.links?.next;
    if (!next) break;
    url = `${env.mirrorRest}${next}`;
  }
  return { warranted, byCategory };
}

async function chainTail(whTopicId: string): Promise<string> {
  const res = await fetch(`${env.mirrorRest}/api/v1/topics/${whTopicId}/messages?limit=1&order=desc`);
  if (!res.ok) throw new Error(`mirror ${res.status}`);
  const body = (await res.json()) as { messages: { message: string }[] };
  if (body.messages.length === 0) return '0'.repeat(64);
  const bytes = Uint8Array.from(Buffer.from(body.messages[0].message, 'base64'));
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function publish(operatorId: string, tenantRefs: string[], minSample: number): Promise<void> {
  const opPath = join(OPERATORS_DIR, `${operatorId}.${env.network}.json`);
  if (!existsSync(opPath)) {
    console.error(`no operator state — run: warrant-health.mts operator-init ${operatorId}`);
    process.exit(2);
  }
  const op = JSON.parse(readFileSync(opPath, 'utf8')) as { warrantHealthTopicId: string; operatorKey: string };

  let warranted = 0;
  const byCategory: Record<string, number> = {};
  for (const ref of tenantRefs) {
    const tenant = JSON.parse(
      readFileSync(join(TENANTS_DIR, `${ref}.${env.network}.json`), 'utf8'),
    ) as { topicId: string };
    const c = await countTenant(tenant.topicId);
    warranted += c.warranted;
    for (const [k, v] of Object.entries(c.byCategory)) byCategory[k] = (byCategory[k] ?? 0) + v;
  }

  const health = computeWarrantHealth(warranted, byCategory, { minSample });
  const now = new Date().toISOString();
  const { record, encoded } = buildWarrantHealthRecord({
    prevHash: await chainTail(op.warrantHealthTopicId),
    operatorId,
    fromTs: '1970-01-01T00:00:00Z', // whole-history window for v1
    toTs: now,
    total: health.total,
    unwarranted: health.unwarranted,
    byCategory: health.byCategory,
    rate: health.rate,
    sampleSize: health.sampleSize,
    threshold: health.threshold,
    verdict: health.verdict,
  });

  const client = await createHederaClient(env);
  const seq = await submitGuardedMessage(
    client,
    TopicId.fromString(op.warrantHealthTopicId),
    PrivateKey.fromStringDer(op.operatorKey),
    encoded,
  );
  console.log(
    `owh-1 sealed seq ${seq} on ${op.warrantHealthTopicId}: ` +
      `${record.unwarranted}/${record.total} unwarranted (rate ${record.rate.toFixed(4)}) → ${record.verdict}` +
      ` ${JSON.stringify(record.by_category)}`,
  );
  client.close();
}

const [, , cmd, ...args] = process.argv;
if (cmd === 'operator-init') {
  if (!args[0]) {
    console.error('usage: warrant-health.mts operator-init <operator-id>');
    process.exit(2);
  }
  await operatorInit(args[0]);
} else if (cmd === 'publish') {
  const minIdx = args.indexOf('--min-sample');
  const minSample = minIdx > -1 ? Number(args[minIdx + 1]) : 30;
  const tenants = args.slice(1).filter((a) => a !== '--min-sample' && a !== String(minSample));
  if (!args[0] || tenants.length === 0) {
    console.error('usage: warrant-health.mts publish <operator-id> <tenant-ref>... [--min-sample N]');
    process.exit(2);
  }
  await publish(args[0], tenants, minSample);
} else {
  console.log('usage: warrant-health.mts <operator-init <id> | publish <id> <tenant>... [--min-sample N]>');
  process.exit(2);
}
