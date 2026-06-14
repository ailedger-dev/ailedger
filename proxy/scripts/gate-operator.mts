// Participation-gating CLI — decide whether to federate with an operator based
// on its PUBLISHED warrant health (the public board), keyless.
//
//   gate-operator.mts --operator-topic <owh-topic> [--max-staleness-days N]
//                     [--allow-gap]
//
// A thorough consumer ALSO runs `ailedger verify-warrant-health` first to
// confirm the published rate reconciles against the sealed chain (catch a
// lying aggregate); this gate then refuses absent/stale/over-threshold/unproven.
import { readHederaEnv } from '../src/hedera/client.ts';
import { assertOperatorWarrantHealth, type WarrantHealthSnapshot } from '../src/interchange/gate.ts';

const env = readHederaEnv(process.env);
const args = process.argv.slice(2);
const topicIdx = args.indexOf('--operator-topic');
if (topicIdx === -1) {
  console.error('usage: gate-operator.mts --operator-topic <owh-topic> [--max-staleness-days N] [--allow-gap]');
  process.exit(2);
}
const owhTopic = args[topicIdx + 1];
const staleIdx = args.indexOf('--max-staleness-days');
const maxStalenessSec = staleIdx > -1 ? Number(args[staleIdx + 1]) * 86400 : undefined;
const refuseOnGap = !args.includes('--allow-gap');

// Latest published owh-1 on the operator's warrant-health topic.
const res = await fetch(`${env.mirrorRest}/api/v1/topics/${owhTopic}/messages?limit=1&order=desc`);
if (!res.ok) throw new Error(`mirror ${res.status}`);
const body = (await res.json()) as { messages: { message: string; consensus_timestamp: string }[] };

let snapshot: WarrantHealthSnapshot = { operatorId: owhTopic, latest: null };
const m = body.messages[0];
if (m) {
  const rec = JSON.parse(Buffer.from(m.message, 'base64').toString('utf8')) as {
    v?: string;
    operator_id?: string;
    verdict?: 'PASS' | 'FLAG' | 'GAP';
    rate?: number;
  };
  // Only an owh-1 is warrant health; anything else = no health published.
  if (rec.v === 'owh-1' && rec.verdict && typeof rec.rate === 'number') {
    snapshot = {
      operatorId: rec.operator_id ?? owhTopic,
      latest: {
        verdict: rec.verdict,
        rate: rec.rate,
        publishedAtEpochSec: Number(m.consensus_timestamp.split('.')[0]),
      },
    };
  }
}

const result = assertOperatorWarrantHealth(snapshot, { maxStalenessSec, refuseOnGap });
console.log(`${result.ok ? 'ADMIT' : 'REFUSE'} ${snapshot.operatorId}: ${result.reason}`);
process.exit(result.ok ? 0 : 1);
