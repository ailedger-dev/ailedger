// Participation-gating — the consumer-side teeth of OWT (pure module).
//
// Lodestar's Interchange refuses an unwarranted *crossing* between nodes (spec
// §4.5: "a lossy or unwarranted crossing raises a coherence flag and is
// refused, never silently best-effort"). OWT extends that refusal to the
// OPERATOR scope: before federating with / trusting / onboarding an operator,
// a consumer checks the operator's warrant health and REFUSES if it is absent,
// stale, or over budget. This is what gives the public board teeth — a missing
// or bad rate is not neutral, it is exclusion.
//
// The snapshot is what the operator PUBLISHED (from the board). A thorough
// consumer ALSO runs `ailedger verify-warrant-health` to confirm the published
// rate reconciles against the sealed chain (catching a lying aggregate) before
// trusting a PASS. This gate handles absent/stale/over-threshold/no-history;
// reconciliation handles lying. Both are needed; neither replaces the other.

export type WarrantHealthVerdict = 'PASS' | 'FLAG' | 'GAP';

export interface WarrantHealthSnapshot {
  operatorId: string;
  /** The operator's latest published owh-1, or null if they never published. */
  latest: {
    verdict: WarrantHealthVerdict;
    rate: number;
    /** Consensus timestamp (epoch seconds) of the latest owh-1. */
    publishedAtEpochSec: number;
  } | null;
}

export interface GatingPolicy {
  /** Refuse if the latest attestation is older than this (default 7 days). */
  maxStalenessSec?: number;
  /**
   * Refuse on a GAP verdict (default true). GAP = the operator has not
   * demonstrated health (too little data, or a straddling interval).
   * Federation is opt-in trust; "can't show you're healthy" → refused. Set
   * false to admit unproven operators (lenient).
   */
  refuseOnGap?: boolean;
  /** Current time, epoch seconds (injectable for tests). */
  nowEpochSec?: () => number;
}

export type GateResult = { ok: true; reason: string } | { ok: false; reason: string };

const DEFAULT_MAX_STALENESS_SEC = 7 * 24 * 60 * 60;

/**
 * Decide whether to federate with / trust an operator based on its published
 * warrant health. Refusal reasons are stable strings for logging/registry.
 */
export function assertOperatorWarrantHealth(
  snapshot: WarrantHealthSnapshot,
  policy: GatingPolicy = {},
): GateResult {
  const maxStaleness = policy.maxStalenessSec ?? DEFAULT_MAX_STALENESS_SEC;
  const refuseOnGap = policy.refuseOnGap ?? true;
  const now = policy.nowEpochSec ?? (() => Date.now() / 1000);
  const op = snapshot.operatorId;

  // No history — announced but never published (the rotation/new-identity case
  // and the never-participated case both land here).
  if (snapshot.latest === null) {
    return { ok: false, reason: `refused:no-warrant-health (${op} has published no owh-1)` };
  }

  const ageSec = now() - snapshot.latest.publishedAtEpochSec;
  if (ageSec > maxStaleness) {
    return {
      ok: false,
      reason: `refused:stale (${op}'s warrant health is ${Math.round(ageSec / 86400)}d old > ${Math.round(maxStaleness / 86400)}d)`,
    };
  }

  if (snapshot.latest.verdict === 'FLAG') {
    return {
      ok: false,
      reason: `refused:over-threshold (${op} is FLAG — unwarranted rate ${snapshot.latest.rate.toFixed(4)} over budget)`,
    };
  }

  if (snapshot.latest.verdict === 'GAP' && refuseOnGap) {
    return {
      ok: false,
      reason: `refused:unproven (${op} is GAP — has not demonstrated warrant health)`,
    };
  }

  return {
    ok: true,
    reason: `ok (${op} ${snapshot.latest.verdict}, rate ${snapshot.latest.rate.toFixed(4)}, fresh)`,
  };
}
