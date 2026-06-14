// Warrant-health verdict — TypeScript port of detection/warrant_health.py.
//
// The operator publish path (owh-1) and the indexer board both need to render
// the gap-honest verdict in TS; the Python module is the open-standard
// reference, and this port is pinned to it by the same known-value tests
// (Wilson interval points, GAP/PASS/FLAG cases). A divergence fails CI before
// it can mislabel an operator.
//
// Verdict (gap-honest): FLAG only when the Wilson lower bound exceeds the
// budget (confidently over), PASS only when the upper bound is within it
// (confidently under), else GAP (straddling interval or sub-floor sample —
// declared non-evaluable, never a small-sample false flag).

export const DEFAULT_UNWARRANT_THRESHOLD = 0.05;
export const DEFAULT_MIN_SAMPLE = 30;
export const WILSON_Z_95 = 1.959963984540054;

export type WarrantHealthVerdict = 'PASS' | 'FLAG' | 'GAP';

export interface WarrantHealthResult {
  total: number;
  unwarranted: number;
  rate: number;
  byCategory: Record<string, number>;
  threshold: number;
  sampleSize: number;
  wilsonLower: number;
  wilsonUpper: number;
  verdict: WarrantHealthVerdict;
  flagged: boolean;
  minSample: number;
}

/** Wilson score interval for k/n; (0,1) when n == 0. Clamped to [0,1]. */
export function wilsonInterval(k: number, n: number, z = WILSON_Z_95): [number, number] {
  if (k < 0 || n < 0 || k > n) throw new Error(`need 0 <= k <= n, got k=${k}, n=${n}`);
  if (n === 0) return [0, 1];
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export function computeWarrantHealth(
  warranted: number,
  unwarrantedByCategory: Record<string, number>,
  opts: { threshold?: number; minSample?: number; z?: number } = {},
): WarrantHealthResult {
  const threshold = opts.threshold ?? DEFAULT_UNWARRANT_THRESHOLD;
  const minSample = opts.minSample ?? DEFAULT_MIN_SAMPLE;
  const z = opts.z ?? WILSON_Z_95;
  if (warranted < 0 || Object.values(unwarrantedByCategory).some((v) => v < 0)) {
    throw new Error('counts must be non-negative');
  }
  if (!(threshold > 0 && threshold < 1)) throw new Error('threshold must be in (0, 1)');

  const byCategory: Record<string, number> = {};
  for (const [k, v] of Object.entries(unwarrantedByCategory)) if (v) byCategory[k] = Math.trunc(v);
  const unwarranted = Object.values(byCategory).reduce((a, b) => a + b, 0);
  const total = warranted + unwarranted;
  const rate = total ? unwarranted / total : 0;
  const [wilsonLower, wilsonUpper] = wilsonInterval(unwarranted, total, z);

  let verdict: WarrantHealthVerdict;
  if (total < minSample) verdict = 'GAP';
  else if (wilsonLower > threshold) verdict = 'FLAG';
  else if (wilsonUpper <= threshold) verdict = 'PASS';
  else verdict = 'GAP';

  return {
    total,
    unwarranted,
    rate,
    byCategory,
    threshold,
    sampleSize: total,
    wilsonLower,
    wilsonUpper,
    verdict,
    flagged: verdict === 'FLAG',
    minSample,
  };
}
