-- Migration: tenant_id column on ledger.api_keys (Option B per
-- docs/tenant-ownership-design-2026-05-18.md, Jake-ratified 2026-05-18).
--
-- Context: SDK v0.2.0 + proxy /v2/detection-events trust the SDK-supplied
-- tenant_id (TODO at proxy/src/index.ts:115). This migration adds the
-- schema binding so the proxy can validate tenant_id against the API
-- key's bound tenant on every Detection Event ingest.
--
-- Semantics for /v2/detection-events:
--   - resolveApiKey() returns the api_keys row including tenant_id
--   - handleDetectionEventIngest() rejects (403) if payload.tenant_id does
--     not match resolved.tenant_id, OR if resolved.tenant_id IS NULL
--     (key not provisioned for v2; legacy v1-only keys cannot ingest
--     Decision Events)
--
-- Backfill posture: existing api_keys rows are v1-era; they use the
-- /proxy/<provider> path which writes to ledger.inference_logs (NOT
-- ledger.decision_events). They do not need a tenant_id to keep working.
-- They DO need one to use /v2/detection-events; provision a tenant + set
-- tenant_id on the existing key in a follow-up step (out of scope for
-- this migration; manual or scripted depending on customer count).
--
-- Idempotent.

alter table ledger.api_keys
  add column if not exists tenant_id uuid references ledger.tenants(id);

-- Partial index: most queries that need tenant_id will filter to
-- non-null rows (the v2-enabled keys). Partial index keeps the lookup
-- cheap without polluting the index with NULL rows.
create index if not exists api_keys_tenant_id_idx
  on ledger.api_keys (tenant_id)
  where tenant_id is not null;

comment on column ledger.api_keys.tenant_id is
  'For v2 substrate (Detection Event ingest): the ledger.tenants row this '
  'API key is scoped to. NULL = legacy v1-only key (no /v2/detection-events '
  'access). New API keys provisioned via the v2 signup flow set tenant_id '
  'at creation time. Per docs/tenant-ownership-design-2026-05-18.md '
  '(Option B, Jake-ratified 2026-05-18).';

-- ─── RLS implications ────────────────────────────────────────────────────
-- ledger.api_keys already has RLS implications via the existing v1 chain.
-- The new tenant_id column does not change the RLS posture; the proxy
-- worker continues to read api_keys via service_role only. No new policy
-- needed.
