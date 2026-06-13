// Court-bundle archiver — export every known topic's full mirror rows to an
// archive directory the verifier consumes offline. Run on a schedule (or
// after notable sealing activity); idempotent.
//
//   INDEXER_REGISTRY_TOPIC=0.0.X node scripts/archive.mts [outDir]
//
// Default outDir: ~/.ailedger-archive. The bundle is customer-pullable as-is.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { archiveAll, restRawRowFetcher, validateBundle } from '../src/archiver.ts';
import { ingestRegistry } from '../src/ingest.ts';
import { restMirror } from '../src/mirror.ts';
import { IndexerStore } from '../src/store.ts';

const registryTopic = process.env.INDEXER_REGISTRY_TOPIC;
if (!registryTopic) {
  console.error('INDEXER_REGISTRY_TOPIC is required');
  process.exit(2);
}
const network = process.env.HEDERA_NETWORK ?? 'testnet';
const mirrorBase = process.env.HEDERA_MIRROR_REST ?? `https://${network}.mirrornode.hedera.com`;
const outDir = process.argv[2] ?? join(homedir(), '.ailedger-archive');

// Tenant discovery straight from the registry (in-memory store — the
// archiver needs no persistent state of its own).
const store = new IndexerStore(':memory:');
await ingestRegistry(store, restMirror(mirrorBase), registryTopic);

const results = await archiveAll(store, restRawRowFetcher(mirrorBase), registryTopic, outDir);
for (const r of results) {
  console.log(`${r.topicId}: ${r.messages} message(s) → ${r.file} (sha256 ${r.sha256.slice(0, 16)}…)`);
}
const check = await validateBundle(outDir);
console.log(`bundle: ${check.ok ? 'VALID' : 'INVALID'} — ${check.detail}`);
store.close();
process.exit(check.ok ? 0 : 1);
