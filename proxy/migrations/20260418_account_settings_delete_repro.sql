-- Repro + integration test for ai-8xe: system delete RLS silent-fail.
--
-- Run in the Supabase SQL editor while authenticated as a real end-user
-- (i.e. with `request.jwt.claim.sub` set, not as postgres/service_role —
-- those bypass RLS and cannot reproduce this bug). The test harness on
-- this project is SQL-level because there is no JS test runner in the
-- dashboard package (no Jest/Vitest wired up).
--
-- Expected behavior, PRE-MIGRATION (before 20260418_account_settings_delete_policy.sql):
--   Step A inserts a row, Step B returns it, Step C returns 0 rows deleted,
--   Step D returns the row still present → bug confirmed.
--
-- Expected behavior, POST-MIGRATION:
--   Step A inserts a row, Step B returns it, Step C returns 1 row deleted,
--   Step D returns no rows → fix confirmed.

-- ─── Step A: seed a system owned by the current user ───────────────────────
insert into ledger.account_settings (customer_id, system_name, system_purpose, annex_iii_category)
values (auth.uid(), 'test-delete-repro', 'integration test for ai-8xe', 'Other (describe in system purpose)')
returning id, system_name;

-- ─── Step B: confirm the row is visible to the caller ──────────────────────
select id, system_name
from ledger.account_settings
where customer_id = auth.uid()
  and system_name = 'test-delete-repro';

-- ─── Step C: attempt delete as the authenticated user ──────────────────────
-- `returning id` surfaces row count; pre-migration this returns zero rows
-- (RLS filtered the row out); post-migration it returns the deleted id.
delete from ledger.account_settings
where customer_id = auth.uid()
  and system_name = 'test-delete-repro'
returning id;

-- ─── Step D: verify persistence (the actual test) ──────────────────────────
-- Post-migration: zero rows. Pre-migration: one row (bug).
select id, system_name
from ledger.account_settings
where customer_id = auth.uid()
  and system_name = 'test-delete-repro';

-- ─── Cleanup (only needed if step C left the row behind on pre-migration runs) ─
delete from ledger.account_settings
where customer_id = auth.uid()
  and system_name = 'test-delete-repro';
