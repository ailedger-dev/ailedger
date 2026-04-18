-- AILedger — hardened schema
-- Run this in the Supabase SQL editor

-- Drop public table if it exists from previous attempt
drop table if exists public.inference_logs;

-- ─── Inference log table (ledger schema) ────────────────────────────────────
create table if not exists ledger.inference_logs (
    id              bigserial primary key,
    logged_at       timestamptz not null default now(),
    customer_id     uuid        not null references auth.users(id),
    provider        text        not null,
    model_name      text,
    method          text        not null,
    path            text        not null,
    input_hash      text check (input_hash  is null or length(input_hash)  = 64),
    output_hash     text check (output_hash is null or length(output_hash) = 64),
    status_code     int         not null,
    latency_ms      int         not null,
    -- SHA-256 of the previous row's canonical serialization. Filled by the
    -- BEFORE INSERT trigger from migrations/20260418_tamper_evident_chain.sql.
    -- First row per customer uses the all-zero genesis hash.
    chain_prev_hash  text check (chain_prev_hash is null or length(chain_prev_hash) = 64),
    chain_genesis_at timestamptz
);

-- ─── Indexes ────────────────────────────────────────────────────────────────
create index on ledger.inference_logs (customer_id, logged_at desc);

-- ─── Row Level Security ─────────────────────────────────────────────────────
alter table ledger.inference_logs enable row level security;
alter table ledger.inference_logs force row level security;

-- Customers can only read their own rows
create policy "customers read own logs"
    on ledger.inference_logs
    for select
    using (customer_id = auth.uid());

-- No updates or deletes — immutable legal record
revoke update, delete on ledger.inference_logs from anon, authenticated;

-- ─── Realtime ───────────────────────────────────────────────────────────────
-- Required for Supabase Realtime to apply RLS checks on custom schema events
alter table ledger.inference_logs replica identity full;
alter publication supabase_realtime add table ledger.inference_logs;

-- ─── Account settings table ─────────────────────────────────────────────────
-- Stores AI system metadata used in compliance report generation
create table if not exists ledger.account_settings (
  customer_id        uuid primary key references auth.users(id) on delete cascade,
  system_name        text,
  system_purpose     text,
  annex_iii_category text,
  data_residency     text not null default 'EU (Supabase)',
  retention_policy   text not null default 'Indefinite — records are append-only and cannot be deleted per EU AI Act Article 12',
  updated_at         timestamptz default now()
);

alter table ledger.account_settings enable row level security;
alter table ledger.account_settings force row level security;

create policy "customer_select_own_settings"
  on ledger.account_settings for select
  to authenticated using (customer_id = auth.uid());

create policy "customer_insert_own_settings"
  on ledger.account_settings for insert
  to authenticated with check (customer_id = auth.uid());

create policy "customer_update_own_settings"
  on ledger.account_settings for update
  to authenticated using (customer_id = auth.uid()) with check (customer_id = auth.uid());

-- ─── Grants ─────────────────────────────────────────────────────────────────
grant usage on schema ledger to postgres, authenticator, service_role, anon, authenticated;
grant all privileges on all tables in schema ledger to postgres, authenticator, service_role;
grant all privileges on all sequences in schema ledger to postgres, authenticator, service_role;
grant select on all tables in schema ledger to anon, authenticated;
grant select, insert, update on ledger.account_settings to authenticated;
