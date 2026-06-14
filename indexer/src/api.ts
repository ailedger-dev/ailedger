// Read API — the shapes the dashboard, CLI, and detection layer consume.
// Serves only derived public data; there is nothing privileged to leak.

import { Hono } from 'hono';
import type { IndexerStore } from './store.ts';
import type { MonitorReport } from './monitor.ts';

export interface ApiState {
  /** Last monitor sweep result; updated by the serve loop. */
  lastMonitorReport?: MonitorReport;
}

export function createIndexerApi(store: IndexerStore, state: ApiState = {}): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.get('/v1/health', (c) => {
    const report = state.lastMonitorReport;
    if (!report) return c.json({ status: 'unknown', detail: 'no monitor sweep yet' }, 503);
    const fails = report.findings.filter((f) => f.level === 'FAIL');
    const warns = report.findings.filter((f) => f.level === 'WARN');
    return c.json(
      {
        status: fails.length ? 'fail' : warns.length ? 'warn' : 'ok',
        ran_at: report.ranAt,
        findings: report.findings,
      },
      fails.length ? 500 : 200,
    );
  });

  app.get('/v1/tenants', (c) =>
    c.json({
      tenants: store.tenants().map((t) => ({
        tenant_ref: t.tenantRef,
        topic_id: t.topicId,
        submit_pubkey: t.submitPubkey,
      })),
    }),
  );

  app.get('/v1/tenants/:ref/events', (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 1000);
    return c.json({ events: store.decisionsForTenant(c.req.param('ref'), limit) });
  });

  app.get('/v1/events/:eventId', (c) => {
    const event = store.decisionById(c.req.param('eventId'));
    return event ? c.json(event) : c.json({ error: 'not found' }, 404);
  });

  app.get('/v1/tenants/:ref/warrant-health', (c) => {
    const tenant = store.tenantByRef(c.req.param('ref'));
    if (!tenant) return c.json({ error: 'unknown tenant' }, 404);
    const h = store.warrantHealth(tenant.tenantRef);
    return c.json({
      tenant_ref: tenant.tenantRef,
      total_decisions: h.total,
      warranted: h.warranted,
      unwarranted: h.unwarranted,
      unwarranted_rate: h.rate,
      by_category: h.byCategory,
    });
  });

  app.get('/v1/tenants/:ref/batches', (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 1000);
    return c.json({ batches: store.batchesForTenant(c.req.param('ref'), limit) });
  });

  app.get('/v1/tenants/:ref/chain', (c) => {
    const tenant = store.tenantByRef(c.req.param('ref'));
    if (!tenant) return c.json({ error: 'unknown tenant' }, 404);
    const status = store.chainStatus(tenant.topicId);
    if (!status) return c.json({ error: 'no records' }, 404);
    return c.json({
      topic_id: status.topicId,
      records: status.records,
      last_seq: status.lastSeq,
      chain_head: status.lastRecordHash,
      continuous: status.continuous,
      first_break_seq: status.firstBreakSeq,
      duplicates: store.duplicateCount(status.topicId),
    });
  });

  return app;
}
