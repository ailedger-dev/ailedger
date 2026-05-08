-- Migration: add missing DELETE RLS policy + privilege on ledger.account_settings
--
-- Context (ai-8xe): Jake reported that deleting an AI system from the dashboard
-- appeared to succeed (no error, row vanished from local state) but the row
-- reappeared after a reload. Root cause:
--
--   * ledger.account_settings has RLS enabled AND forced (see proxy/schema.sql)
--   * Policies existed for SELECT/INSERT/UPDATE, but NOT for DELETE
--   * The grant on account_settings was `select, insert, update` — no `delete`
--
-- Under forced RLS with no DELETE policy, Postgres filters every row from the
-- DELETE target list; the statement completes with 0 rows affected and
-- PostgREST returns 204 No Content. The client read that as success. This
-- migration closes both gaps (policy + grant) so deletes actually fire, and
-- the client-side assertion added in the same PR guarantees a silent 0-row
-- delete surfaces as an error.
--
-- Idempotent: safe to re-run.

-- ─── DELETE policy ──────────────────────────────────────────────────────────
-- Customers may delete their own settings rows (scoped by customer_id = auth.uid()).
-- account_settings.customer_id references auth.users(id) directly in this schema,
-- so the policy predicate is a direct equality check — no join through customers.
drop policy if exists "customer_delete_own_settings" on ledger.account_settings;

create policy "customer_delete_own_settings"
  on ledger.account_settings for delete
  to authenticated
  using (customer_id = auth.uid());

-- ─── Privilege grant ────────────────────────────────────────────────────────
-- The policy is a no-op without the table-level DELETE privilege.
grant delete on ledger.account_settings to authenticated;
