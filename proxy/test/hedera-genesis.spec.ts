// Genesis core — pure compute over a predecessor head (no SDK keys, no network).
import { describe, expect, it } from 'vitest';
import {
  buildHcsContinuityGenesis,
  predecessorHeadFromFinalMessage,
} from '../src/hedera/genesis.ts';

const FINAL = {
  sequenceNumber: 7,
  runningHashHex: 'AB'.repeat(48),
  bytes: new TextEncoder().encode('{"v":"ode-2b","batch_id":"b-7"}'),
};

async function sha256hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('genesis core', () => {
  it('derives the head from the final message (count = final seq, app head = sha256 bytes)', async () => {
    const head = await predecessorHeadFromFinalMessage('0.0.9218174', FINAL);
    expect(head.finalSeq).toBe(7);
    expect(head.recordCount).toBe(7);
    expect(head.finalRunningHashHex).toBe('ab'.repeat(48)); // lowercased
    expect(head.finalAppHead).toBe(await sha256hex(FINAL.bytes));
  });

  it('builds a gen-1 hcs-continuity record pinned to genesis prev_hash', async () => {
    const head = await predecessorHeadFromFinalMessage('0.0.9218174', FINAL);
    const { record, encoded } = buildHcsContinuityGenesis({ ts: '2026-06-14T00:00:00.000Z', head });
    expect(record.v).toBe('gen-1');
    expect(record.prev_hash).toBe('0'.repeat(64));
    expect(record.witness).toMatchObject({
      kind: 'hcs-continuity',
      predecessor_topic_id: '0.0.9218174',
      final_seq: 7,
      record_count: 7,
    });
    expect(encoded.byteLength).toBeLessThanOrEqual(1024);
  });
});
