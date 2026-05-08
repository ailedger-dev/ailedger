-- Migration: ledger.attestations — monthly public-blockchain anchor rows
-- Context: the regulator primer (§3.5) and Thursday briefing (§3) promise a
-- monthly root-hash anchor across all customer chain-heads. This table is the
-- durable record of each anchor event: root hash, anchor network, on-chain
-- transaction id, and the chain_head_map snapshot the root hash was computed
-- over (for independent re-verification).
--
-- Cross-customer metadata: rows are NOT customer-owned. Read and write are
-- restricted to service_role. Authenticated customer users get no access.
--
-- Run in the Supabase SQL editor. Idempotent: safe to re-run.

create extension if not exists pgcrypto with schema extensions;

-- ─── Table ──────────────────────────────────────────────────────────────────
create table if not exists ledger.attestations (
  id              uuid        primary key default gen_random_uuid(),
  root_hash       text        not null
    check (length(root_hash) = 64 and root_hash ~ '^[0-9a-f]{64}$'),
  anchored_at     timestamptz not null default now(),
  chain_head_map  jsonb       not null,
  anchor_network  text        not null
    check (anchor_network in ('mock', 'bitcoin-testnet', 'bitcoin')),
  anchor_tx_id    text        null,
  customer_count  integer     not null
    check (customer_count >= 0),
  created_at      timestamptz not null default now()
);

-- Queries are dominated by "most recent attestations first" (list command,
-- regulator spot-checks, dashboards). Also enforces uniqueness per-network on
-- tx_id so the same on-chain tx can't be recorded twice by mistake.
create index if not exists attestations_anchored_at_idx
  on ledger.attestations (anchored_at desc);

create unique index if not exists attestations_anchor_tx_id_uniq
  on ledger.attestations (anchor_network, anchor_tx_id)
  where anchor_tx_id is not null;

-- ─── RLS: service_role only ─────────────────────────────────────────────────
-- Attestations are cross-customer metadata. No customer-authenticated role
-- can read or write. The service_role bypasses RLS, so the CLI (running with
-- a service-role key) remains fully functional.
alter table ledger.attestations enable row level security;

-- Defensive: explicitly deny authenticated + anon. Without these policies the
-- default-deny of RLS already blocks them, but an explicit policy is easier
-- for reviewers to audit.
drop policy if exists attestations_deny_authenticated on ledger.attestations;
create policy attestations_deny_authenticated
  on ledger.attestations
  for all
  to authenticated, anon
  using (false)
  with check (false);

-- ─── all_chain_heads: single-call snapshot for the CLI ──────────────────────
-- Returns {customer_id: chain_head_hash} across every customer that has at
-- least one chained row. The CLI feeds this into its deterministic root-hash
-- computation. SECURITY DEFINER + service_role grant means only callers with
-- the service_role key can invoke it — customer-authenticated callers get
-- permission-denied at the EXECUTE check.
create or replace function ledger.all_chain_heads()
returns jsonb
language plpgsql
stable
security definer
set search_path = ledger, extensions, public
as $$
declare
  result jsonb;
begin
  with heads as (
    select distinct on (customer_id)
      customer_id,
      ledger.canonical_hash(inference_logs.*) as head_hash
    from ledger.inference_logs
    where chain_prev_hash is not null
    order by customer_id, id desc
  )
  select coalesce(
           jsonb_object_agg(customer_id::text, head_hash),
           '{}'::jsonb
         )
    into result
  from heads;

  return result;
end;
$$;

-- Lock execution to service_role. Revoke the default PUBLIC grant first so
-- an authenticated caller cannot invoke the SECURITY DEFINER function.
revoke all on function ledger.all_chain_heads() from public;
grant execute on function ledger.all_chain_heads() to service_role;

-- ─── Grants ─────────────────────────────────────────────────────────────────
-- service_role handles all read/write. Keep authenticated + anon off the
-- table entirely (RLS policies above would deny, but revoking also prevents
-- them from discovering the table via PostgREST schema cache).
grant all on ledger.attestations to service_role;
revoke all on ledger.attestations from authenticated, anon;
