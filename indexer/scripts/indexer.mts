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
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createIndexerApi, type ApiState } from '../src/api.ts';
import { ingestAll } from '../src/ingest.ts';
import { restMirror } from '../src/mirror.ts';
import { dispatchAlerts, restRawRowSource, runMonitor, webhookAlertSink } from '../src/monitor.ts';
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

const operatorsTopic = process.env.INDEXER_OPERATORS_TOPIC; // OWT cross-operator board (optional)
const store = new IndexerStore(dbPath);
const mirror = restMirror(mirrorBase);

async function sweep(): Promise<void> {
  const summaries = await ingestAll(store, mirror, registryTopic!, operatorsTopic);
  for (const s of summaries) {
    if (s.newRecords === 0) continue;
    console.log(
      `${s.topicId}: +${s.newRecords} records` +
        (s.announcements ? ` (${s.announcements} announcements)` : '') +
        (s.decisions ? ` ${s.decisions} decisions` : '') +
        (s.unwarrants ? ` ${s.unwarrants} unwarrants` : '') +
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

function loadManifestEntries(): { sequenceNumber: number; tenantRef: string }[] | undefined {
  const path = process.env.AILEDGER_MANIFESTS ?? join(homedir(), '.ailedger-outbox', 'manifests.jsonl');
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { sequenceNumber: number; tenantRef: string });
}

async function monitorSweep(state: ApiState): Promise<void> {
  const report = await runMonitor({
    store,
    mirror,
    rawRows: restRawRowSource(mirrorBase),
    mirrorBase,
    payerAccountId: process.env.HEDERA_OPERATOR_ID,
    minPayerHbar: Number(process.env.MONITOR_MIN_PAYER_HBAR ?? 10),
    manifestEntries: loadManifestEntries(),
  });
  state.lastMonitorReport = report;
  const sink = process.env.ALERT_WEBHOOK ? webhookAlertSink(process.env.ALERT_WEBHOOK) : null;
  const alerted = await dispatchAlerts(report, sink);
  const fails = report.findings.filter((f) => f.level === 'FAIL');
  for (const f of fails) console.error(`MONITOR FAIL ${f.check}/${f.subject}: ${f.detail}`);
  if (fails.length && !alerted) console.error('(no ALERT_WEBHOOK configured — failures logged only)');
}

if (cmd === 'serve') {
  const state: ApiState = {};
  const port = Number(process.env.AILEDGER_INDEXER_PORT ?? 8799);
  serve({ fetch: createIndexerApi(store, state).fetch, port });
  console.log(`indexer read API on :${port} (db=${dbPath}, mirror=${mirrorBase})`);
  await monitorSweep(state);
  const pollS = Number(process.env.INDEXER_POLL_S ?? 15);
  for (;;) {
    await new Promise((r) => setTimeout(r, pollS * 1000));
    try {
      await sweep();
      await monitorSweep(state);
    } catch (err) {
      console.error('sweep error:', (err as Error).message);
    }
  }
} else {
  store.close();
}
