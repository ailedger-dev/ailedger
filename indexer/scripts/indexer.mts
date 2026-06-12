// Evidence indexer — operator-independent read layer over public mirror data.
//
//   indexer.mts backfill        discover tenants from the registry topic and
//                               backfill every tenant topic once, then print
//                               chain status per tenant.
//   indexer.mts serve           backfill, then serve the read API
//                               (AILEDGER_INDEXER_PORT, default 8799) and
//                               re-poll the mirror every INDEXER_POLL_S (15s).
//
// Config (env):
//   INDEXER_REGISTRY_TOPIC   registry.tenants topic id (the ONLY required input)
//   HEDERA_NETWORK           testnet (default) | mainnet — derives mirror URL
//   HEDERA_MIRROR_REST       override mirror base URL
//   AILEDGER_INDEXER_DB      sqlite path (default ~/.ailedger-indexer/index.db)
//
// No Hedera keys, no operator credentials — public reads only, by design.

import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createIndexerApi } from '../src/api.ts';
import { ingestAll } from '../src/ingest.ts';
import { restMirror } from '../src/mirror.ts';
import { IndexerStore } from '../src/store.ts';

const registryTopic = process.env.INDEXER_REGISTRY_TOPIC;
if (!registryTopic) {
  console.error('INDEXER_REGISTRY_TOPIC is required (the registry.tenants topic id)');
  process.exit(2);
}
const network = process.env.HEDERA_NETWORK ?? 'testnet';
const mirrorBase = process.env.HEDERA_MIRROR_REST ?? `https://${network}.mirrornode.hedera.com`;
const dbPath =
  process.env.AILEDGER_INDEXER_DB ?? join(homedir(), '.ailedger-indexer', 'index.db');
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });

const store = new IndexerStore(dbPath);
const mirror = restMirror(mirrorBase);

async function sweep(): Promise<void> {
  const summaries = await ingestAll(store, mirror, registryTopic!);
  for (const s of summaries) {
    if (s.newRecords === 0) continue;
    console.log(
      `${s.topicId}: +${s.newRecords} records` +
        (s.announcements ? ` (${s.announcements} announcements)` : '') +
        (s.decisions ? ` ${s.decisions} decisions` : '') +
        (s.batches ? ` ${s.batches} batches` : '') +
        (s.brokenLinks ? ` BROKEN-LINKS=${s.brokenLinks}` : ''),
    );
  }
}

const cmd = process.argv[2] ?? 'backfill';
await sweep();

for (const tenant of store.tenants()) {
  const status = store.chainStatus(tenant.topicId);
  if (status) {
    console.log(
      `tenant ${tenant.tenantRef} (${tenant.topicId}): ${status.records} records, ` +
        `chain ${status.continuous ? 'CONTINUOUS' : `BROKEN at seq ${status.firstBreakSeq}`}, ` +
        `head ${status.lastRecordHash.slice(0, 16)}…`,
    );
  }
}

if (cmd === 'serve') {
  const port = Number(process.env.AILEDGER_INDEXER_PORT ?? 8799);
  serve({ fetch: createIndexerApi(store).fetch, port });
  console.log(`indexer read API on :${port} (db=${dbPath}, mirror=${mirrorBase})`);
  const pollS = Number(process.env.INDEXER_POLL_S ?? 15);
  for (;;) {
    await new Promise((r) => setTimeout(r, pollS * 1000));
    try {
      await sweep();
    } catch (err) {
      console.error('sweep error:', (err as Error).message);
    }
  }
} else {
  store.close();
}
