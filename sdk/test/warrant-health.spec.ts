// Warrant-health TS port — pinned to detection/warrant_health.py by the same
// known-value cases (Wilson points + GAP/PASS/FLAG verdicts).
import { describe, expect, it } from 'vitest';
import { computeWarrantHealth, wilsonInterval } from '../src/evidence/warrant-health.js';

describe('wilson interval (parity with Python)', () => {
  it('n=0 → (0,1); 50/100 ≈ [0.404, 0.596]', () => {
    expect(wilsonInterval(0, 0)).toEqual([0, 1]);
    const [lo, hi] = wilsonInterval(50, 100);
    expect(lo).toBeCloseTo(0.4038, 3);
    expect(hi).toBeCloseTo(0.5962, 3);
  });
  it('bounds bracket the estimate and stay in [0,1]', () => {
    for (const [k, n] of [
      [0, 10],
      [1, 10],
      [10, 10],
      [3, 1000],
    ] as const) {
      const [lo, hi] = wilsonInterval(k, n);
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(1);
      expect(lo - 1e-12).toBeLessThanOrEqual(k / n);
      expect(k / n).toBeLessThanOrEqual(hi + 1e-12);
    }
    expect(() => wilsonInterval(5, 3)).toThrow();
  });
});

describe('warrant-health verdict (gap-honest, parity with Python)', () => {
  it('GAP below the sample floor', () => {
    const r = computeWarrantHealth(3, { 'missing-justification': 1 });
    expect(r).toMatchObject({ total: 4, rate: 0.25, verdict: 'GAP', flagged: false });
  });
  it('PASS when the upper bound is within budget', () => {
    const r = computeWarrantHealth(1000, {});
    expect(r.wilsonUpper).toBeLessThanOrEqual(r.threshold);
    expect(r.verdict).toBe('PASS');
  });
  it('FLAG when the lower bound exceeds budget', () => {
    const r = computeWarrantHealth(800, { 'missing-justification': 150, 'weak-warrant': 50 });
    expect(r).toMatchObject({ total: 1000, unwarranted: 200, verdict: 'FLAG', flagged: true });
    expect(r.wilsonLower).toBeGreaterThan(r.threshold);
  });
  it('GAP when the interval straddles the threshold', () => {
    const r = computeWarrantHealth(95, { 'weak-warrant': 5 }, { minSample: 10 });
    expect(r.rate).toBeCloseTo(0.05, 10);
    expect(r.wilsonLower).toBeLessThan(r.threshold);
    expect(r.wilsonUpper).toBeGreaterThan(r.threshold);
    expect(r.verdict).toBe('GAP');
  });
  it('drops zero-count categories; rejects bad inputs', () => {
    expect(computeWarrantHealth(10, { 'weak-warrant': 0 }).byCategory).toEqual({});
    expect(() => computeWarrantHealth(-1, {})).toThrow();
    expect(() => computeWarrantHealth(10, {}, { threshold: 1 })).toThrow();
  });
});
