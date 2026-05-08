-- Migration: chain_health + chain_alerts for server-side 24/7 monitoring.
-- Context: the scheduled-handler chain monitor runs verify_chain for every
-- customer on each cron tick, persists last-known status to chain_health,
-- and writes one row to chain_alerts per newly-detected break. The dashboard
-- reads chain_health to show "monitored" status without forcing the user
-- to click Verify; chain_alerts is the immutable log of alert events.
--
-- Run in the Supabase SQL editor. Idempotent: safe to re-run.

-- ─── chain_health: one row per customer, latest status ──────────────────────
create table if not exists ledger.chain_health (
  customer_id        uuid primary key references auth.users(id) on delete cascade,
  last_verified_at   timestamptz,
  last_status        text not null default 'never'
                     check (last_status in ('ok', 'broken', 'never')),
  last_row_count     bigint not null default 0,
  chain_head_hash    text,
  broken_at_id       bigint,
  expected_hash      text,
  actual_hash        text,
  last_alerted_at    timestamptz,
  updated_at         timestamptz not null default now()
);

-- RLS: customer can SELECT their own row only. Inserts/updates are done
-- by the worker with service-role auth which bypasses RLS.
alter table ledger.chain_health enable row level security;
drop policy if exists chain_health_self on ledger.chain_health;
create policy chain_health_self
  on ledger.chain_health
  for select
  using (customer_id = auth.uid());

-- ─── chain_alerts: append-only log of break alerts ──────────────────────────
-- Dedupe on (customer_id, broken_at_id, actual_hash) so re-detection of
-- the same break doesn't re-alert. Record stays for audit even if the
-- break is later corrected (compliance reviewers want to see "this got
-- caught and surfaced at time T, alert sent at T+ε").
create table if not exists ledger.chain_alerts (
  id              bigserial primary key,
  customer_id     uuid not null references auth.users(id) on delete cascade,
  broken_at_id    bigint not null,
  actual_hash     text not null,
  expected_hash   text not null,
  row_count       bigint not null default 0,
  alerted_at      timestamptz not null default now()
);

create unique index if not exists chain_alerts_dedupe_uidx
  on ledger.chain_alerts (customer_id, broken_at_id, actual_hash);

create index if not exists chain_alerts_customer_alerted_at_idx
  on ledger.chain_alerts (customer_id, alerted_at desc);

alter table ledger.chain_alerts enable row level security;
drop policy if exists chain_alerts_self on ledger.chain_alerts;
create policy chain_alerts_self
  on ledger.chain_alerts
  for select
  using (customer_id = auth.uid());

-- ─── Grants ─────────────────────────────────────────────────────────────────
grant select on ledger.chain_health to authenticated;
grant select on ledger.chain_alerts to authenticated;
