// Read API — the shapes the dashboard, CLI, and detection layer consume.
// Serves only derived public data; there is nothing privileged to leak.

import { Hono } from 'hono';
import type { IndexerStore } from './store.ts';

export function createIndexerApi(store: IndexerStore): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));

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
