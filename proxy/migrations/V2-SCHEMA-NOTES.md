# V2 Schema Migrations — Notes for Jake (2026-05-12, Vernier)

Vernier authored four migrations during Jake's overnight move, implementing the AILedger posture v2 substrate per `~/workspace/dev/ailedger/CLAUDE.md` §"Decision Event schema (Postgres)" and §"Immediate priorities."

## Files

| File | Purpose |
|---|---|
| `20260512_decision_events_schema.sql` | Primary `ledger.decision_events` table + supporting `ledger.tenants` and `ledger.ai_systems` tables + indexes + append-only triggers |
| `20260512_decision_type_taxonomy_seed.sql` | `ledger.decision_type_taxonomy` table + Annex III seed data + FK from `decision_events.decision_type` to taxonomy |
| `20260512_protected_class_taxonomy_seed.sql` | `ledger.protected_class_field_taxonomy` reference + NIST AI RMF / US Census seed data + JSONB validator |
| `20260512_subject_pseudonymization.sql` | `ledger.tenant_salts` table (separate access policy) + `pseudonymize_subject()` + `provision_tenant_salt()` |
| `20260512_decision_events_chain_trigger.sql` | Canonical-hash function + BEFORE INSERT trigger + `verify_decision_event_chain()` + `decision_event_chain_head()` |

Recommended apply order: **schema → taxonomy_seed (decision_type) → taxonomy_seed (protected_class) → subject_pseudonymization → chain_trigger.**

After the 2026-05-12 batch lands, also apply `20260518_inferred_detection_events.sql` (Vernier 2026-05-18 per param canonicalization spec v1.0).

## Supabase SQL Editor warnings (when pasting these migrations)

When running these migrations via Supabase's SQL Editor, you will hit warnings on any step that creates a table without an explicit `enable row level security` statement in the migration. Supabase surfaces three options:

- **Cancel:** abandon the run; useful only if you want to edit the SQL first.
- **Run without RLS:** new tables are anon-readable via PostgREST. NOT SAFE for production. Tenant identifiers and ledger row content would be exposed.
- **Run and enable RLS:** RLS is turned on for every new table in the batch. No policies are defined, so only `service_role` can read or write. SAFE default.

**Choose "Run and enable RLS" for every migration in this batch** unless you explicitly want the table public-readable (none of the v2 migrations want that).

Per-migration warning expectations:

| Migration | Tables created | RLS in SQL? | Click |
|---|---|---|---|
| `20260512_decision_events_schema.sql` | `ledger.tenants`, `ledger.ai_systems`, `ledger.decision_events` | Only on `decision_events` (line 137) | Run and enable RLS (covers `tenants` + `ai_systems`) |
| `20260512_decision_type_taxonomy_seed.sql` | `ledger.decision_type_taxonomy` | No | Run and enable RLS |
| `20260512_protected_class_taxonomy_seed.sql` | `ledger.protected_class_field_taxonomy` | No | Run and enable RLS |
| `20260512_subject_pseudonymization.sql` | `ledger.tenant_salts` | Yes (line 66) | No warning expected; if it appears, Run and enable RLS |
| `20260512_decision_events_chain_trigger.sql` | (no new tables; only functions + trigger) | n/a | No warning expected |
| `20260518_inferred_detection_events.sql` | (no new tables; only columns + functions on existing decision_events) | n/a | No warning expected |

After all six migrations have run, every v2 table has RLS ON and no permissive policies. Customer reads via the dashboard / contractor-dash will return zero rows until Jake adds the policies. The service_role-backed proxy Worker continues to write Decision Events without policies (service_role bypasses RLS).

## Policies to add (separate from migrations)

Once the schema is live, add policies before any customer-facing read surface ships. Suggested shapes (adapt to your auth model):

```sql
-- decision_events: tenants read their own events
create policy decision_events_tenant_read
  on ledger.decision_events
  for select
  to authenticated
  using (
    tenant_id in (
      select tenant_id from ledger.tenant_memberships
      where user_id = auth.uid()
    )
  );

-- tenants table: members read their own tenant row
create policy tenants_member_read
  on ledger.tenants
  for select
  to authenticated
  using (
    id in (
      select tenant_id from ledger.tenant_memberships
      where user_id = auth.uid()
    )
  );

-- ai_systems: members read systems for tenants they belong to
create policy ai_systems_tenant_read
  on ledger.ai_systems
  for select
  to authenticated
  using (
    tenant_id in (
      select tenant_id from ledger.tenant_memberships
      where user_id = auth.uid()
    )
  );

-- decision_type_taxonomy + protected_class_field_taxonomy: world-readable
-- by authenticated users (reference data, not tenant-scoped)
create policy decision_type_taxonomy_read
  on ledger.decision_type_taxonomy
  for select
  to authenticated
  using (true);

create policy protected_class_field_taxonomy_read
  on ledger.protected_class_field_taxonomy
  for select
  to authenticated
  using (true);
```

These policies assume a `ledger.tenant_memberships` table exists (user_id, tenant_id). If membership lives elsewhere in the auth schema, swap the subquery accordingly.

## CLAUDE.md immediate-priorities coverage

Per `~/workspace/dev/ailedger/CLAUDE.md` §"Immediate priorities (this work session)":

| # | Priority | Coverage |
|---|---|---|
| 1 | Migrate existing hash chain to wrap Decision Event records | ✅ `20260512_decision_events_chain_trigger.sql` |
| 2 | Implement Decision Event schema in Postgres with indexes | ✅ `20260512_decision_events_schema.sql` |
| 3 | Implement subject_id pseudonymization with per-tenant HMAC salts | ✅ `20260512_subject_pseudonymization.sql` |
| 4 | Implement protected class context capture with collection method tracking | ✅ `20260512_decision_events_schema.sql` (column + CHECK) + `20260512_protected_class_taxonomy_seed.sql` (reference + validator) |
| 5 | Stub out flags_raised and required_actions structure | ✅ `20260512_decision_events_schema.sql` (JSONB columns with defaults `'[]'::jsonb`) |
| 6 | Define decision_type_taxonomy and protected_class taxonomy as seed data | ✅ Both seed-data migrations |
| 7 | Update existing API endpoints to accept and validate Decision Event structure | ❌ **NOT DONE.** TypeScript/Worker code changes needed in `proxy/src/`. Out-of-scope for autonomous overnight work; needs Jake's review before touching the deployed Worker. See "Decisions for Jake before running" below. |
| 8 | Write migration path for any existing data | ❌ **NOT NEEDED at pre-revenue stage** per the spec ("likely minimal at pre-revenue stage"). Confirmed: existing `ledger.inference_logs` rows are pre-v2 inference-call records; they remain in their own table. There is nothing to migrate INTO `decision_events`. If the spec changes, write the migration then. |

## Decisions for Jake BEFORE running the migrations

1. **`ledger.tenants` and `ledger.ai_systems` table shape.** The CLAUDE.md spec references `tenants(id)` and `ai_systems(id)` as FK targets. The current v1 schema uses `auth.users(id)` as the tenant analog. Migration 1 SKETCHES these tables (`create table if not exists`) with minimal columns. Two paths:
   - **Path A (taken by these migrations):** Create new `ledger.tenants` and `ledger.ai_systems` tables. Decision Events FK to them. Customer onboarding writes a `ledger.tenants` row at signup. `auth.users` remains the auth-layer table.
   - **Path B:** Rewrite FK references to point at `auth.users(id)` for tenant_id, and add only `ledger.ai_systems` (still per-tenant). Closer to existing pattern.

   If Path B is preferred, edit `20260512_decision_events_schema.sql` before running:
   - Remove the `create table if not exists ledger.tenants` block.
   - Change `references ledger.tenants(id)` to `references auth.users(id)` for `decision_events.tenant_id` AND `ai_systems.tenant_id`.

2. **Row-Level Security policy on `ledger.decision_events`.** The migration enables RLS but does NOT define a permissive policy. Without a policy, only service_role can read this table. **Jake must define the policy** before customer Decision Event reads can happen. Suggested shape (assumes membership table; adapt to your auth model):

   ```sql
   create policy decision_events_tenant_read
     on ledger.decision_events
     for select
     to authenticated
     using (
       tenant_id in (
         select tenant_id from ledger.tenant_memberships
         where user_id = auth.uid()
       )
     );
   ```

3. **Quoted column name `"timestamp"`.** Per the CLAUDE.md spec, the column is named `timestamp`. PostgreSQL allows this but it's a reserved word, requiring quoting in every query. Consider renaming to `decided_at` for ergonomics. If renaming: update the column name in all five migrations + the canonical-hash function field order.

4. **JSON validation of `protected_class_context`.** Migration 3 provides `ledger.validate_protected_class_context(jsonb)` that returns unknown keys. The application layer (Worker / ingest endpoint) must call this on incoming Decision Events and reject any with unknown keys. The migration does NOT add a `CHECK` constraint using this function because computed `CHECK` against function output is fragile across PG versions; better to validate in app code.

5. **Salt rotation procedure.** Migration 4 supports rotation via `superseded_at` but does NOT implement the actual rotation. Documented gap; flagged in threat model §10.3 TD-3. Implement before first paying enterprise customer.

6. **Application-layer enforcement of `refused_at_intake`.** The taxonomy contains `law_enforcement` with `refused_at_intake = true`. The ingest API MUST query this column on each incoming Decision Event and reject if true. Test v2-T12 covers this — code change required to match.

## Verification steps (after running)

Manual smoke test:

```sql
-- Create a test tenant + salt + system
insert into ledger.tenants (name, industry_tag)
  values ('Test Tenant', 'employment') returning id;
-- Capture the tenant_id from above; substitute below.

select ledger.provision_tenant_salt('<tenant_id>');

insert into ledger.ai_systems (tenant_id, name, description)
  values ('<tenant_id>', 'test-system', 'smoke-test') returning id;

-- Insert a Decision Event (trigger will populate hash_chain_*)
insert into ledger.decision_events (
  tenant_id,
  system_id,
  model_version,
  decision_type,
  subject_id,
  inputs_hash,
  output,
  confidence,
  human_in_loop,
  protected_class_context,
  protected_class_collection_method
) values (
  '<tenant_id>',
  '<system_id>',
  'gpt-4-test',
  'employment_screening',
  ledger.pseudonymize_subject('<tenant_id>', 'applicant-12345'),
  '0000000000000000000000000000000000000000000000000000000000000000',
  '{"decision": "advance"}'::jsonb,
  0.87,
  false,
  '{"age_band": "25_34", "age_band_source": "direct", "gender_category": "woman", "gender_category_source": "direct"}'::jsonb,
  'direct'
);

-- Verify chain
select * from ledger.verify_decision_event_chain('<tenant_id>');
-- Should return ok=true, total_rows=1.

-- Try to update (should fail):
update ledger.decision_events
  set confidence = 0.99
  where tenant_id = '<tenant_id>';
-- ERROR: ledger.decision_events is append-only; UPDATE rejected

-- Try refused decision_type:
insert into ledger.decision_events (
  tenant_id, system_id, model_version, decision_type, subject_id,
  inputs_hash, output, protected_class_collection_method, protected_class_context
) values (
  '<tenant_id>', '<system_id>', 'gpt-4', 'law_enforcement',
  ledger.pseudonymize_subject('<tenant_id>', 'subject-X'),
  '0000000000000000000000000000000000000000000000000000000000000000',
  '{}'::jsonb, 'direct',
  '{"age_band": "25_34", "age_band_source": "direct"}'::jsonb
);
-- Note: SCHEMA does not block this; the TAXONOMY records refused_at_intake=true
-- but enforcement is in application code. The above INSERT will SUCCEED unless
-- the application-layer check is also in place. The schema-level
-- demonstration: select refused_at_intake from ledger.decision_type_taxonomy
-- where code = 'law_enforcement' returns true.
```

## What Vernier deliberately did NOT do

- **No `proxy/src/` TypeScript changes.** The Worker code that hosts the v1 proxy is live in production. Touching it autonomously could break things. The ingest-API endpoint changes that priority 7 specifies need Jake's review of:
  - Where the Decision Event ingest endpoint lives (separate from the proxy `/proxy/{provider}` paths?).
  - How customers authenticate to the Decision Event ingest endpoint (same `x-ailedger-key` as proxy? separate?).
  - Whether to ship Decision Event ingest as a separate Worker or extend the existing one.
- **No migration execution.** All migrations are staged files; nothing has been run against Supabase. Jake reviews + runs.
- **No git commits in the ailedger repo yet.** Migrations are uncommitted. Vernier will commit at the end of the overnight session under a single coherent commit covering all v2 substrate work (or Jake can stage commits per-migration on review).

## Cross-references

- `~/workspace/dev/ailedger/CLAUDE.md` — v2 implementation spec.
- [ailedger-dev/charter/CHARTER.md](https://github.com/ailedger-dev/charter/blob/main/CHARTER.md) — Charter v1.2 public commitment.
- `memory/project_ailedger_posture_v2_2026_05_12.md` [FOUNDATIONAL] — canonical posture.
- `docs/ailedger-threat-model.md` §10 — v2-specific threats (including the salt-rotation gap).
- `docs/ailedger-test-plan.md` "Posture v2 test surfaces" — what these migrations need to be tested against.
