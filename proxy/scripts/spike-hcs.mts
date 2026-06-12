// Phase 0 HCS spike — measures what the docs don't state. See docs/adr/016.
//
// Subcommands:
//   lifecycle                      create topic (submitKey + 2-of-3 adminKey),
//                                  submit 200B/700B/1024B/5120B(chunked),
//                                  report fees, latencies, mirror lag
//   mirror-dump <topicId> <out>    dump all topic messages from mirror REST
//                                  (input for cli runninghash layout detection)
//   burst <topicId> <n> <bytes>    n concurrent submits — throttle behavior
//   rotate <topicId>               rehearse submitKey rotation via 2-of-3 adminKey
//
// Env (source ~/.secrets/hedera-testnet.env — never commit values):
//   HEDERA_NETWORK       testnet (default) | previewnet | mainnet
//   HEDERA_OPERATOR_ID   0.0.x payer account
//   HEDERA_OPERATOR_KEY  DER or hex private key
//   HEDERA_MIRROR_REST   override mirror base URL (optional)
//
// Generated topic keys are throwaway spike material but still follow secrets
// hygiene: written to ~/.secrets/hedera-spike/<topicId>.json mode 600.
//
// Runs natively on Node >= 23 (type-stripping); no build step.
import {
  AccountId,
  Client,
  KeyList,
  PrivateKey,
  TopicCreateTransaction,
  TopicId,
  TopicInfoQuery,
  TopicMessageSubmitTransaction,
  TopicUpdateTransaction,
} from '@hashgraph/sdk';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const NETWORK = process.env.HEDERA_NETWORK ?? 'testnet';
const MIRROR_REST =
  process.env.HEDERA_MIRROR_REST ?? `https://${NETWORK}.mirrornode.hedera.com`;
const SPIKE_DIR = join(homedir(), '.secrets', 'hedera-spike');

interface SpikeKeys {
  network: string;
  topicId: string;
  submitKey: string;
  adminKeys: string[];
  threshold: number;
  createdAt: string;
}

function client(): Client {
  const id = process.env.HEDERA_OPERATOR_ID;
  const key = process.env.HEDERA_OPERATOR_KEY;
  if (!id || !key) {
    console.error(
      'HEDERA_OPERATOR_ID / HEDERA_OPERATOR_KEY not set. source ~/.secrets/hedera-testnet.env',
    );
    process.exit(2);
  }
  const c = Client.forName(NETWORK);
  c.setOperator(AccountId.fromString(id), PrivateKey.fromString(key));
  return c;
}

function saveKeys(keys: SpikeKeys): string {
  mkdirSync(SPIKE_DIR, { recursive: true, mode: 0o700 });
  const path = join(SPIKE_DIR, `${keys.topicId.replaceAll('.', '_')}.json`);
  writeFileSync(path, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
  return path;
}

function loadKeys(topicId: string): SpikeKeys {
  const path = join(SPIKE_DIR, `${topicId.replaceAll('.', '_')}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as SpikeKeys;
}

function usdFromHbar(hbar: number, centsPerHbar: number | null): string {
  return centsPerHbar == null ? 'n/a' : `$${((hbar * centsPerHbar) / 100).toFixed(6)}`;
}

async function submitOnce(
  c: Client,
  topicId: TopicId,
  submitKey: PrivateKey,
  size: number,
): Promise<{ size: number; seqs: number[]; feeHbar: number; usd: string; ms: number }> {
  // Deterministic-ish filler; content is irrelevant to fee/latency.
  const message = Buffer.alloc(size, 0x61);
  const tx = new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(message)
    .freezeWith(c);
  await tx.sign(submitKey);
  const t0 = performance.now();
  const responses = await tx.executeAll(c);
  const seqs: number[] = [];
  let feeHbar = 0;
  let centsPerHbar: number | null = null;
  for (const resp of responses) {
    const receipt = await resp.getReceipt(c);
    if (receipt.topicSequenceNumber != null) seqs.push(receipt.topicSequenceNumber.toNumber());
    const rate = receipt.exchangeRate;
    if (rate != null) centsPerHbar = rate.exchangeRateInCents;
    const record = await resp.getRecord(c);
    feeHbar += record.transactionFee.toBigNumber().toNumber();
  }
  const ms = performance.now() - t0;
  return { size, seqs, feeHbar, usd: usdFromHbar(feeHbar, centsPerHbar), ms };
}

async function mirrorMessages(topicId: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let url = `${MIRROR_REST}/api/v1/topics/${topicId}/messages?limit=100&order=asc`;
  for (;;) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`mirror ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      messages: Record<string, unknown>[];
      links?: { next?: string | null };
    };
    rows.push(...body.messages);
    const next = body.links?.next;
    if (!next) return rows;
    url = `${MIRROR_REST}${next}`;
  }
}

async function waitForMirrorSeq(topicId: string, seq: number): Promise<number> {
  const t0 = performance.now();
  for (;;) {
    const res = await fetch(
      `${MIRROR_REST}/api/v1/topics/${topicId}/messages/${seq}`,
    );
    if (res.ok) return performance.now() - t0;
    if (res.status !== 404) throw new Error(`mirror ${res.status}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function lifecycle(): Promise<void> {
  const c = client();
  const submitKey = PrivateKey.generateED25519();
  const adminKeys = [
    PrivateKey.generateED25519(),
    PrivateKey.generateED25519(),
    PrivateKey.generateED25519(),
  ];
  const adminThreshold = new KeyList(
    adminKeys.map((k) => k.publicKey),
    2,
  );

  console.log(`network=${NETWORK} mirror=${MIRROR_REST}`);
  console.log('creating topic (submitKey=ed25519, adminKey=2-of-3 threshold)…');
  const createTx = new TopicCreateTransaction()
    .setTopicMemo('ailedger phase0 spike')
    .setSubmitKey(submitKey.publicKey)
    .setAdminKey(adminThreshold)
    .freezeWith(c);
  // adminKey must satisfy its threshold on create: sign with 2 of 3.
  await createTx.sign(adminKeys[0]);
  await createTx.sign(adminKeys[1]);
  const t0 = performance.now();
  const createResp = await createTx.execute(c);
  const createReceipt = await createResp.getReceipt(c);
  const createMs = performance.now() - t0;
  const topicId = createReceipt.topicId;
  if (topicId == null) throw new Error('no topicId in receipt');
  const createRecord = await createResp.getRecord(c);
  const createFee = createRecord.transactionFee.toBigNumber().toNumber();
  const cents = createReceipt.exchangeRate?.exchangeRateInCents ?? null;
  console.log(
    `topic ${topicId.toString()} created in ${createMs.toFixed(0)}ms — fee ${createFee} ℏ (${usdFromHbar(createFee, cents)})`,
  );

  const keysPath = saveKeys({
    network: NETWORK,
    topicId: topicId.toString(),
    submitKey: submitKey.toStringDer(),
    adminKeys: adminKeys.map((k) => k.toStringDer()),
    threshold: 2,
    createdAt: new Date().toISOString(),
  });
  console.log(`keys → ${keysPath}`);

  console.log('\nsize     seq(s)        fee ℏ        USD         submit→receipt');
  let lastSeq = 0;
  for (const size of [200, 700, 1024, 5120]) {
    const r = await submitOnce(c, topicId, submitKey, size);
    lastSeq = Math.max(lastSeq, ...r.seqs);
    console.log(
      `${String(size).padEnd(8)} ${r.seqs.join(',').padEnd(13)} ${r.feeHbar.toFixed(8).padEnd(12)} ${r.usd.padEnd(11)} ${r.ms.toFixed(0)}ms${r.seqs.length > 1 ? ` (${r.seqs.length} chunks)` : ''}`,
    );
  }

  const lagMs = await waitForMirrorSeq(topicId.toString(), lastSeq);
  console.log(`\nconsensus→mirror availability for seq ${lastSeq}: ~${lagMs.toFixed(0)}ms`);
  console.log(`next: node scripts/spike-hcs.mts mirror-dump ${topicId.toString()} /tmp/hcs-dump.json`);
  c.close();
}

async function mirrorDump(topicId: string, outfile: string): Promise<void> {
  const messages = await mirrorMessages(topicId);
  const out = { network: NETWORK, mirror: MIRROR_REST, topic_id: topicId, messages };
  writeFileSync(outfile, JSON.stringify(out, null, 1) + '\n');
  console.log(`${messages.length} messages → ${outfile}`);
  console.log(`validate: python3 -m ailedger_cli.runninghash ${outfile}`);
}

async function burst(topicId: string, count: number, size: number): Promise<void> {
  const c = client();
  const keys = loadKeys(topicId);
  const submitKey = PrivateKey.fromString(keys.submitKey);
  const topic = TopicId.fromString(topicId);
  console.log(`burst: ${count} concurrent submits of ${size}B to ${topicId}…`);
  const t0 = performance.now();
  const results = await Promise.allSettled(
    Array.from({ length: count }, async (_, i) => {
      const tx = new TopicMessageSubmitTransaction()
        .setTopicId(topic)
        .setMessage(Buffer.alloc(size, 0x30 + (i % 10)))
        .freezeWith(c);
      await tx.sign(submitKey);
      const resp = await tx.execute(c);
      await resp.getReceipt(c);
    }),
  );
  const wallMs = performance.now() - t0;
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const failures = new Map<string, number>();
  for (const r of results) {
    if (r.status === 'rejected') {
      const msg = String((r.reason as Error)?.message ?? r.reason).slice(0, 80);
      failures.set(msg, (failures.get(msg) ?? 0) + 1);
    }
  }
  console.log(
    `ok ${ok}/${count} in ${wallMs.toFixed(0)}ms → effective ${(ok / (wallMs / 1000)).toFixed(1)} sealed/s`,
  );
  for (const [msg, n] of failures) console.log(`  ${n}× ${msg}`);
  c.close();
}

async function rotate(topicId: string): Promise<void> {
  const c = client();
  const keys = loadKeys(topicId);
  const topic = TopicId.fromString(topicId);
  const adminKeys = keys.adminKeys.map((k) => PrivateKey.fromString(k));
  const oldSubmit = PrivateKey.fromString(keys.submitKey);
  const newSubmit = PrivateKey.generateED25519();

  console.log(`rotating submitKey on ${topicId} (2-of-3 adminKey ceremony)…`);
  const updateTx = new TopicUpdateTransaction()
    .setTopicId(topic)
    .setSubmitKey(newSubmit.publicKey)
    .freezeWith(c);
  await updateTx.sign(adminKeys[0]);
  await updateTx.sign(adminKeys[2]); // a different pair than create — proves any-2-of-3
  const updateResp = await updateTx.execute(c);
  await updateResp.getReceipt(c);

  const info = await new TopicInfoQuery().setTopicId(topic).execute(c);
  console.log(`topic submitKey now: ${info.submitKey?.toString().slice(0, 32)}…`);

  // Old key must now be rejected; new key must work.
  let oldRejected = false;
  try {
    const tx = new TopicMessageSubmitTransaction()
      .setTopicId(topic)
      .setMessage('post-rotation message signed with OLD key')
      .freezeWith(c);
    await tx.sign(oldSubmit);
    await (await tx.execute(c)).getReceipt(c);
  } catch (err) {
    oldRejected = true;
    console.log(`old submitKey rejected as expected: ${String((err as Error).message).slice(0, 60)}`);
  }
  const tx2 = new TopicMessageSubmitTransaction()
    .setTopicId(topic)
    .setMessage('post-rotation message signed with NEW key')
    .freezeWith(c);
  await tx2.sign(newSubmit);
  const r2 = await (await tx2.execute(c)).getReceipt(c);
  console.log(
    `new submitKey accepted (seq ${r2.topicSequenceNumber?.toNumber()}). rotation ${oldRejected ? 'VERIFIED' : 'INCOMPLETE — old key still accepted!'}`,
  );

  keys.submitKey = newSubmit.toStringDer();
  const path = saveKeys(keys);
  console.log(`keys file updated → ${path}`);
  c.close();
}

const [, , cmd, ...args] = process.argv;
switch (cmd) {
  case 'lifecycle':
    await lifecycle();
    break;
  case 'mirror-dump':
    await mirrorDump(args[0], args[1] ?? '/tmp/hcs-dump.json');
    break;
  case 'burst':
    await burst(args[0], Number(args[1] ?? 25), Number(args[2] ?? 700));
    break;
  case 'rotate':
    await rotate(args[0]);
    break;
  default:
    console.log('usage: node scripts/spike-hcs.mts <lifecycle|mirror-dump|burst|rotate> [args]');
    process.exit(2);
}
