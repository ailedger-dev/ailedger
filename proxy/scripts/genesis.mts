// Genesis attestation publisher — seals message #1 on a fresh topic, witnessing
// the history that preceded it (runbook §3). Companion to checkpoint.mts.
//
//   genesis.mts <tenant-ref> [opts]
//     --predecessor-topic 0.0.X      topic to witness (default: this env's tenant topic)
//     --predecessor-mirror URL       mirror for the predecessor (default: this env's mirror)
//     --publish --target-topic 0.0.Y publish genesis as message #1 (default: DRY-RUN)
//
// Default is dry-run: read the predecessor's head from the public mirror
// (keyless), compute the gen-1 record, print exactly what message #1 would be.
// This works fully on testnet today. The --publish path is mainnet-gated only by
// the target topic existing + funded; it refuses unless the target is empty
// (genesis is append-only forever — it MUST be the first message).
//
// Env: source ~/.secrets/hedera-{testnet,mainnet}.env.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PrivateKey, TopicId } from '@hashgraph/sdk';
import { createHederaClient, readHederaEnv } from '../src/hedera/client.ts';
import { buildHcsContinuityGenesis, predecessorHeadFromFinalMessage } from '../src/hedera/genesis.ts';
import { submitGuardedMessage } from '../src/hedera/topics.ts';

const env = readHederaEnv(process.env);

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const tenantRef = process.argv[2];
if (!tenantRef || tenantRef.startsWith('--')) {
  console.error('usage: genesis.mts <tenant-ref> [--predecessor-topic 0.0.X] [--predecessor-mirror URL] [--publish --target-topic 0.0.Y]');
  process.exit(2);
}
const publish = process.argv.includes('--publish');
const predecessorMirror = (flag('--predecessor-mirror') ?? env.mirrorRest).replace(/\/$/, '');

function tenantStateTopic(): string {
  const path = join(homedir(), '.secrets', 'hedera-tenants', `${tenantRef}.${env.network}.json`);
  if (!existsSync(path)) {
    console.error(`no --predecessor-topic given and no tenant state at ${path}`);
    process.exit(2);
  }
  return (JSON.parse(readFileSync(path, 'utf8')) as { topicId: string }).topicId;
}

const predecessorTopic = flag('--predecessor-topic') ?? tenantStateTopic();

const bytesFromB64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

interface MirrorMsg {
  message: string;
  sequence_number: number;
  running_hash: string;
}

async function finalMessage(mirror: string, topicId: string): Promise<MirrorMsg | null> {
  const res = await fetch(`${mirror}/api/v1/topics/${topicId}/messages?limit=1&order=desc`);
  if (!res.ok) throw new Error(`mirror ${res.status} for ${topicId}: ${await res.text()}`);
  const body = (await res.json()) as { messages: MirrorMsg[] };
  return body.messages[0] ?? null;
}

const final = await finalMessage(predecessorMirror, predecessorTopic);
if (final === null) {
  console.error(`predecessor topic ${predecessorTopic} has no messages — nothing to witness`);
  process.exit(2);
}

const head = await predecessorHeadFromFinalMessage(predecessorTopic, {
  sequenceNumber: final.sequence_number,
  runningHashHex: toHex(bytesFromB64(final.running_hash)),
  bytes: bytesFromB64(final.message),
});
const { record, encoded } = buildHcsContinuityGenesis({ ts: new Date().toISOString(), head });

if (!publish) {
  console.log(JSON.stringify(record, null, 2));
  console.log(
    `\n[dry-run] genesis witnesses ${predecessorTopic} @ seq ${head.finalSeq} ` +
      `(${head.recordCount} records, app head ${head.finalAppHead.slice(0, 16)}…); ` +
      `${encoded.byteLength} B. To publish: --publish --target-topic <new-topic>`,
  );
  process.exit(0);
}

// --- publish path (mainnet cutover): message #1 on a fresh target topic -------
const targetTopic = flag('--target-topic');
if (!targetTopic) {
  console.error('--publish requires --target-topic <new-topic-id>');
  process.exit(2);
}
// Genesis is append-only forever — refuse unless the target is empty.
if ((await finalMessage(env.mirrorRest, targetTopic)) !== null) {
  console.error(`target ${targetTopic} already has messages — genesis must be the FIRST message; refusing`);
  process.exit(2);
}
const secretsPath = join(homedir(), '.secrets', 'hedera-tenants', `${tenantRef}.${env.network}.json`);
const submitKey = (JSON.parse(readFileSync(secretsPath, 'utf8')) as { submitKey: string }).submitKey;

const client = await createHederaClient(env);
const seq = await submitGuardedMessage(
  client,
  TopicId.fromString(targetTopic),
  PrivateKey.fromStringDer(submitKey),
  encoded,
);
client.close();
console.log(
  `genesis sealed: ${targetTopic}:${seq} witnessing ${predecessorTopic} @ ${head.recordCount} records`,
);
