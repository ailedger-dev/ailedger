// AILedger evidence relay — the portable Hono app (strangler beside the
// legacy Worker; src/index.ts is untouched).
//
// Runs identically on Node (scripts/serve-node.mts — the self-host mode) and
// on Workers (mounted at the Phase 3 cutover). Every dependency is injected:
// no Workers bindings, no node:* imports, no environment reads in here.
//
//   POST /v2/detection-events   evidence ingest (public/private split → vault
//                               + outbox); 202 { event_id, status: "queued" } —
//                               "sealed" arrives asynchronously by design
//                               (consensus is ~2 s away; the ack contract is
//                               queued-durably, matching the legacy KV-buffer
//                               semantics).
//   POST /v2/inference-logs     log ingest for RFC 6962 batching; 202.
//   GET  /healthz               liveness.

import { Hono } from 'hono';
import {
  ingestDecisionEvent,
  ingestInferenceLog,
  ValidationError,
  type PipelineDeps,
} from './evidence/pipeline.ts';

export interface AppDeps extends PipelineDeps {
  /** Resolve a bearer API key to a tenant ref, or null to reject. */
  authenticate(apiKey: string): Promise<string | null>;
}

interface AppEnv {
  Variables: { tenantRef: string };
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.use('/v2/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const apiKey = header.startsWith('Bearer ') ? header.slice(7) : '';
    const tenantRef = apiKey ? await deps.authenticate(apiKey) : null;
    if (tenantRef === null) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('tenantRef', tenantRef);
    await next();
  });

  app.post('/v2/detection-events', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    try {
      const result = await ingestDecisionEvent(deps, c.get('tenantRef'), body);
      return c.json({ event_id: result.eventId, payload_hash: result.payloadHash, status: result.status }, 202);
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  app.post('/v2/inference-logs', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    try {
      const result = await ingestInferenceLog(deps, c.get('tenantRef'), body);
      return c.json(result, 202);
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  return app;
}
