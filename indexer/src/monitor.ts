// Monitor v2 — mirror-driven health checks per sweep. Replaces the legacy
// monitorChains for the evidence path (the legacy cron is untouched).
//
// Checks per tenant topic:
//   sequence-gaps     stored seqs must be exactly 1..maxSeq
//   app-chain         link_ok flags from ingest (break = WARN, per D11)
//   running-hash      recompute the network SHA-384 over the freshest tail
//                     rows straight from the mirror (network integrity)
//   topic-guards      mirror /topics/{id}: submit_key must be present
// Plus globally:
//   payer-balance     mirror /accounts/{id}: HBAR above threshold
//   sealed-sla        every drainer-manifest entry must appear in the store
//                     within the SLA window (the queued→sealed promise)
//
// Findings flow to an injectable alert sink (webhook POST in production,
// captured array in tests). FAIL = page-worthy; WARN = surface in /v1/health.

import type { MirrorSource } from './mirror.ts';
import type { IndexerStore } from './store.ts';
import { verifyTail, type RawTopicRow } from './runninghash.ts';

export interface MonitorFinding {
  level: 'PASS' | 'WARN' | 'FAIL';
  check: string;
  subject: string;
  detail: string;
}

export interface MonitorReport {
  ranAt: string;
  findings: MonitorFinding[];
}

export interface RawRowSource {
  /** Latest N raw REST rows for a topic (full fields incl. running_hash). */
  fetchTail(topicId: string, limit: number): Promise<RawTopicRow[]>;
}

export function restRawRowSource(baseUrl: string): RawRowSource {
  return {
    async fetchTail(topicId: string, limit: number): Promise<RawTopicRow[]> {
      const res = await fetch(
        `${baseUrl}/api/v1/topics/${topicId}/messages?limit=${limit}&order=desc`,
      );
      if (!res.ok) throw new Error(`mirror ${res.status} for ${topicId}`);
      const body = (await res.json()) as { messages: RawTopicRow[] };
      return body.messages;
    },
  };
}

export interface MonitorDeps {
  store: IndexerStore;
  mirror: MirrorSource;
  rawRows: RawRowSource;
  mirrorBase: string;
  payerAccountId?: string;
  minPayerHbar?: number;
  manifestEntries?: { sequenceNumber: number; tenantRef: string }[];
  tailWindow?: number;
}

export async function runMonitor(deps: MonitorDeps): Promise<MonitorReport> {
  const findings: MonitorFinding[] = [];
  const add = (level: MonitorFinding['level'], check: string, subject: string, detail: string) =>
    findings.push({ level, check, subject, detail });

  for (const tenant of deps.store.tenants()) {
    const { tenantRef, topicId } = tenant;
    const status = deps.store.chainStatus(topicId);
    if (!status) {
      add('WARN', 'presence', tenantRef, 'no records indexed yet');
      continue;
    }

    // sequence gaps: contiguous 1..lastSeq means records == lastSeq.
    if (status.records === status.lastSeq) {
      add('PASS', 'sequence-gaps', tenantRef, `contiguous 1..${status.lastSeq}`);
    } else {
      add(
        'FAIL',
        'sequence-gaps',
        tenantRef,
        `${status.records} records but lastSeq ${status.lastSeq} — gap(s) in index`,
      );
    }

    if (status.continuous) {
      add('PASS', 'app-chain', tenantRef, `continuous over ${status.records} records`);
    } else {
      add('WARN', 'app-chain', tenantRef, `break at seq ${status.firstBreakSeq} (consensus order authoritative)`);
    }

    try {
      const tail = await deps.rawRows.fetchTail(topicId, deps.tailWindow ?? 10);
      const result = await verifyTail(tail, topicId);
      if (result.checked === 0) {
        add('WARN', 'running-hash', tenantRef, 'tail too short to check');
      } else if (result.matched === result.checked) {
        add('PASS', 'running-hash', tenantRef, `${result.matched}/${result.checked} tail links match network hash`);
      } else {
        add('FAIL', 'running-hash', tenantRef, `mismatch at seq ${result.firstMismatchSeq}`);
      }
    } catch (err) {
      add('WARN', 'running-hash', tenantRef, `tail fetch failed: ${(err as Error).message}`);
    }

    try {
      const res = await fetch(`${deps.mirrorBase}/api/v1/topics/${topicId}`);
      if (res.ok) {
        const info = (await res.json()) as { submit_key?: { key?: string } | null };
        if (info.submit_key?.key) add('PASS', 'topic-guards', tenantRef, 'submitKey present');
        else add('FAIL', 'topic-guards', tenantRef, 'NO submitKey — topic is world-writable');
      } else {
        add('WARN', 'topic-guards', tenantRef, `mirror ${res.status}`);
      }
    } catch (err) {
      add('WARN', 'topic-guards', tenantRef, (err as Error).message);
    }
  }

  if (deps.payerAccountId) {
    try {
      const res = await fetch(`${deps.mirrorBase}/api/v1/accounts/${deps.payerAccountId}`);
      if (res.ok) {
        const body = (await res.json()) as { balance?: { balance?: number } };
        const hbar = (body.balance?.balance ?? 0) / 1e8;
        const min = deps.minPayerHbar ?? 10;
        add(
          hbar >= min ? 'PASS' : 'FAIL',
          'payer-balance',
          deps.payerAccountId,
          `${hbar.toFixed(2)} ℏ (threshold ${min})`,
        );
      } else {
        add('WARN', 'payer-balance', deps.payerAccountId, `mirror ${res.status}`);
      }
    } catch (err) {
      add('WARN', 'payer-balance', deps.payerAccountId, (err as Error).message);
    }
  }

  if (deps.manifestEntries && deps.manifestEntries.length > 0) {
    const missing: number[] = [];
    for (const entry of deps.manifestEntries) {
      const tenant = deps.store.tenantByRef(entry.tenantRef);
      const status = tenant ? deps.store.chainStatus(tenant.topicId) : null;
      if (!status || entry.sequenceNumber > status.lastSeq) missing.push(entry.sequenceNumber);
    }
    if (missing.length === 0) {
      add('PASS', 'sealed-sla', 'drainer', `all ${deps.manifestEntries.length} sealed records indexed`);
    } else {
      add('FAIL', 'sealed-sla', 'drainer', `sealed but not indexed: seq ${missing.slice(0, 5)}`);
    }
  }

  return { ranAt: new Date().toISOString(), findings };
}

export type AlertSink = (report: MonitorReport, failures: MonitorFinding[]) => Promise<void>;

/** POST failures to a webhook (Postmark-compatible relay or any receiver). */
export function webhookAlertSink(url: string): AlertSink {
  return async (report, failures) => {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ran_at: report.ranAt, failures }),
    });
  };
}

/** Dispatch: alert only when FAILs exist. Returns whether an alert fired. */
export async function dispatchAlerts(report: MonitorReport, sink: AlertSink | null): Promise<boolean> {
  const failures = report.findings.filter((f) => f.level === 'FAIL');
  if (failures.length === 0 || sink === null) return false;
  await sink(report, failures);
  return true;
}
