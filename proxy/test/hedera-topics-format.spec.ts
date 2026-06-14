// Pure-format tests for the Hedera topic conventions (no SDK, runs in the
// workers pool like the rest of the proxy suite).
import { describe, expect, it } from 'vitest';
import {
  assertTenantRef,
  buildOperatorCreatedAnnouncement,
  buildTenantCreatedAnnouncement,
  checkpointsTopicMemo,
  parseOperatorCreatedAnnouncement,
  parseTenantCreatedAnnouncement,
  registryTopicMemo,
  tenantTopicMemo,
  warrantHealthTopicMemo,
  TOPIC_MEMO_MAX_BYTES,
} from '../src/hedera/topics-format';

const FP = 'ab'.repeat(32);

describe('topic memos', () => {
  it('builds the fixed memo formats', () => {
    expect(tenantTopicMemo('jv-fleet')).toBe('ailedger/ode-2 tenant=jv-fleet');
    expect(registryTopicMemo('tenants')).toBe('ailedger/registry/tenants v1');
    expect(registryTopicMemo('operators')).toBe('ailedger/registry/operators v1');
    expect(checkpointsTopicMemo()).toBe('ailedger/checkpoints v1');
    expect(warrantHealthTopicMemo('jv-fleet')).toBe('ailedger/owh-1 operator=jv-fleet');
  });

  it('rejects refs that are invalid or would overflow the memo byte limit', () => {
    expect(() => tenantTopicMemo('Bad_Ref!')).toThrow(/must match/);
    expect(() => tenantTopicMemo('ab')).toThrow(/must match/);
    // 64-char ref is valid per slug rule and still fits the 100-byte memo.
    const ref = 'a'.repeat(64);
    expect(new TextEncoder().encode(tenantTopicMemo(ref)).byteLength).toBeLessThanOrEqual(
      TOPIC_MEMO_MAX_BYTES,
    );
    expect(() => assertTenantRef('a'.repeat(65))).toThrow(/must match/);
  });
});

describe('tenant-created announcement', () => {
  const params = {
    tenantRef: 'jv-fleet',
    topicId: '0.0.9219001',
    submitPubkeyHex: 'cd'.repeat(32),
    adminThreshold: 2,
    adminKeyFingerprints: [FP, FP, FP],
  };

  it('round-trips through build/encode/parse', () => {
    const { announcement, encoded } = buildTenantCreatedAnnouncement(params);
    expect(encoded.byteLength).toBeLessThanOrEqual(1024);
    const parsed = parseTenantCreatedAnnouncement(encoded);
    expect(parsed).toEqual(announcement);
  });

  it('rejects bad topic ids, bad pubkeys, bad thresholds', () => {
    expect(() => buildTenantCreatedAnnouncement({ ...params, topicId: 'nope' })).toThrow(
      /invalid topic id/,
    );
    expect(() =>
      buildTenantCreatedAnnouncement({ ...params, submitPubkeyHex: 'xyz' }),
    ).toThrow(/raw hex/);
    expect(() => buildTenantCreatedAnnouncement({ ...params, adminThreshold: 4 })).toThrow(
      /admin_threshold/,
    );
    expect(() =>
      buildTenantCreatedAnnouncement({ ...params, adminKeyFingerprints: ['short'] }),
    ).toThrow(/fingerprints/);
  });

  it('parse rejects non-announcement payloads', () => {
    const junk = new TextEncoder().encode('{"v":"reg-1","kind":"other"}');
    expect(() => parseTenantCreatedAnnouncement(junk)).toThrow(/not a reg-1/);
  });
});

describe('operator-created announcement (OWT)', () => {
  const params = {
    operatorId: 'jv-fleet',
    operatorPubkeyHex: 'cd'.repeat(32),
    warrantHealthTopicId: '0.0.9300001',
  };

  it('round-trips build → encode → parse and binds id→pubkey→topic', () => {
    const { announcement, encoded } = buildOperatorCreatedAnnouncement(params);
    expect(encoded.byteLength).toBeLessThanOrEqual(1024);
    expect(announcement.kind).toBe('operator-created');
    expect(parseOperatorCreatedAnnouncement(encoded)).toEqual(announcement);
  });

  it('rejects bad pubkey / topic id / non-announcement', () => {
    expect(() => buildOperatorCreatedAnnouncement({ ...params, operatorPubkeyHex: 'xyz' })).toThrow(/raw hex/);
    expect(() => buildOperatorCreatedAnnouncement({ ...params, warrantHealthTopicId: 'nope' })).toThrow(/warrant_health_topic_id/);
    const junk = new TextEncoder().encode('{"v":"reg-1","kind":"tenant-created"}');
    expect(() => parseOperatorCreatedAnnouncement(junk)).toThrow(/not a reg-1 operator-created/);
  });
});
