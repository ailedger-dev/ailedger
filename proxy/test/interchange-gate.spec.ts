// Participation-gating tests — the full refusal matrix.
import { describe, expect, it } from 'vitest';
import {
  assertOperatorWarrantHealth,
  type WarrantHealthSnapshot,
} from '../src/interchange/gate';

const NOW = 1_781_000_000;
const fresh = NOW - 3600; // 1h ago

function snap(
  latest: WarrantHealthSnapshot['latest'],
  operatorId = 'op',
): WarrantHealthSnapshot {
  return { operatorId, latest };
}

const policy = { nowEpochSec: () => NOW };

describe('assertOperatorWarrantHealth', () => {
  it('admits a fresh PASS operator', () => {
    const r = assertOperatorWarrantHealth(snap({ verdict: 'PASS', rate: 0.01, publishedAtEpochSec: fresh }), policy);
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('PASS');
  });

  it('refuses an operator with no published warrant health', () => {
    const r = assertOperatorWarrantHealth(snap(null), policy);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('refused:no-warrant-health');
  });

  it('refuses a stale attestation', () => {
    const old = NOW - 10 * 86400; // 10 days
    const r = assertOperatorWarrantHealth(snap({ verdict: 'PASS', rate: 0.01, publishedAtEpochSec: old }), policy);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('refused:stale');
  });

  it('refuses an over-budget FLAG operator', () => {
    const r = assertOperatorWarrantHealth(snap({ verdict: 'FLAG', rate: 0.2, publishedAtEpochSec: fresh }), policy);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('refused:over-threshold');
  });

  it('refuses a GAP (unproven) operator by default, admits it when lenient', () => {
    const gap = snap({ verdict: 'GAP', rate: 0.25, publishedAtEpochSec: fresh });
    expect(assertOperatorWarrantHealth(gap, policy).ok).toBe(false);
    expect(assertOperatorWarrantHealth(gap, policy).reason).toContain('refused:unproven');
    expect(assertOperatorWarrantHealth(gap, { ...policy, refuseOnGap: false }).ok).toBe(true);
  });

  it('staleness threshold is tunable', () => {
    const day2 = NOW - 2 * 86400;
    expect(assertOperatorWarrantHealth(snap({ verdict: 'PASS', rate: 0, publishedAtEpochSec: day2 }), policy).ok).toBe(true);
    expect(
      assertOperatorWarrantHealth(snap({ verdict: 'PASS', rate: 0, publishedAtEpochSec: day2 }), {
        ...policy,
        maxStalenessSec: 86400,
      }).ok,
    ).toBe(false);
  });
});
