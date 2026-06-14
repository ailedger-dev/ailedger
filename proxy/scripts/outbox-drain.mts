// Outbox drainer — seals queued evidence onto Hedera. Separate process from
// the relay by design: this is the ONLY place tenant submitKeys are loaded.
//
//   outbox-drain.mts <tenant-ref> [--force-batch] [--watch <seconds>]
//
// Env: source ~/.secrets/hedera-testnet.env. Batch manifests (ordered leaves
// for inclusion proofs) append to <outbox-root>/manifests.jsonl.

import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHederaClient, readHederaEnv } from '../src/hedera/client.ts';
import { drainTenant, hasChainState, seedChainState, type SealedInfo } from '../src/hedera/outbox.ts';
import { FsOutboxStore } from '../src/hedera/store-fs.ts';
import { loadTenantSecrets, secretsSubmitter } from '../src/hedera/submit.ts';

const OUTBOX_ROOT = process.env.AILEDGER_OUTBOX_DIR ?? join(homedir(), '.ailedger-outbox');
const MANIFESTS = join(OUTBOX_ROOT, 'manifests.jsonl');

const tenantRef = process.argv[2];
if (!tenantRef) {
  console.error('usage: outbox-drain.mts <tenant-ref> [--force-batch] [--watch <seconds>]');
  process.exit(2);
}
const forceBatch = process.argv.includes('--force-batch');
const watchIdx = process.argv.indexOf('--watch');
const watchSeconds = watchIdx > -1 ? Number(process.argv[watchIdx + 1] ?? 30) : null;

const env = readHederaEnv(process.env);
const client = await createHederaClient(env);
const cfg = {
  store: new FsOutboxStore(OUTBOX_ROOT),
  submitter: secretsSubmitter(client, env.network),
  onSealed: (info: SealedInfo) => {
    appendFileSync(MANIFESTS, JSON.stringify({ sealedAt: new Date().toISOString(), ...info }) + '\n', {
      mode: 0o600,
    });
    const line =
      info.kind === 'decision'
        ? `sealed decision ${info.eventId} seq ${info.sequenceNumber}`
        : info.kind === 'unwarrant'
          ? `sealed UNWARRANT ${info.eventId} [${info.unwarrantCategory}] seq ${info.sequenceNumber}`
          : `sealed batch ${info.batchId} (${info.leafCount} leaves) seq ${info.sequenceNumber}`;
    console.log(line);
  },
};

// Chain-tail recovery: with no local chain state, a drain would fork the app
// chain back to genesis on a topic that already has records. Bootstrap the
// tail from the public mirror (last message bytes → SHA-256).
async function ensureChainState(): Promise<void> {
  if (await hasChainState(cfg.store, tenantRef)) return;
  const { topicId } = loadTenantSecrets(tenantRef, env.network);
  const res = await fetch(
    `${env.mirrorRest}/api/v1/topics/${topicId}/messages?limit=1&order=desc`,
  );
  if (!res.ok) throw new Error(`mirror ${res.status} while seeding chain state`);
  const body = (await res.json()) as { messages: { message: string; sequence_number: number }[] };
  if (body.messages.length === 0) {
    console.log(`no prior messages on ${topicId} — chain starts at genesis`);
    return;
  }
  const bytes = Uint8Array.from(atob(body.messages[0].message), (c) => c.charCodeAt(0));
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
  const prevHash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  await seedChainState(cfg.store, tenantRef, prevHash);
  console.log(
    `seeded chain tail from mirror: topic ${topicId} seq ${body.messages[0].sequence_number} → prev_hash ${prevHash.slice(0, 16)}…`,
  );
}

async function once(): Promise<void> {
  await ensureChainState();
  const r = await drainTenant(cfg, tenantRef, { forceBatch });
  const note = [
    `decisions=${r.sealedDecisions}`,
    `unwarrants=${r.sealedUnwarrants}`,
    `batches=${r.sealedBatches}`,
    r.pendingLogsHeld ? `logsHeld=${r.pendingLogsHeld}` : null,
    r.skipped ? `skipped=${r.skipped}` : null,
    r.error ? `ERROR=${r.error}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  console.log(`drain ${tenantRef}: ${note}`);
  if (r.error && watchSeconds === null) process.exit(1);
}

if (watchSeconds === null) {
  await once();
  client.close();
} else {
  console.log(`watching outbox for ${tenantRef} every ${watchSeconds}s…`);
  for (;;) {
    await once();
    await new Promise((r) => setTimeout(r, watchSeconds * 1000));
  }
}
