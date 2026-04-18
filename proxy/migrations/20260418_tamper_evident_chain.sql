-- Migration: tamper-evident hash chain on ledger.inference_logs
-- Context: marketing claims a tamper-evident chain; the schema only had
-- per-row input/output hashes. This adds a SHA-256 chain linking every row
-- to the previous row's canonical serialization, a verify_chain() function
-- regulators can use to re-verify, and a chain_head getter for PDF export.
--
-- Run in the Supabase SQL editor. Idempotent: safe to re-run.

-- pgcrypto provides digest() for SHA-256. Supabase includes it by default
-- but create-extension-if-not-exists keeps this migration portable.
create extension if not exists pgcrypto with schema extensions;

-- ─── Columns (purely additive, no existing column changes) ──────────────────
alter table ledger.inference_logs
  add column if not exists chain_prev_hash  text
    check (chain_prev_hash is null or length(chain_prev_hash) = 64);

alter table ledger.inference_logs
  add column if not exists chain_genesis_at timestamptz;

-- ─── Canonical serialization ────────────────────────────────────────────────
-- Deterministic pipe-delimited form. Field order is part of the contract:
-- changing it invalidates every prior chain link. NULLs serialize as empty
-- strings. Timestamps serialize as microsecond-precision ISO-8601 UTC.
create or replace function ledger.canonical_hash(r ledger.inference_logs)
returns text
language sql
immutable
as $$
  select encode(
    extensions.digest(
      r.id::text                                                          || '|' ||
      to_char(r.logged_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')                            || '|' ||
      r.customer_id::text                                                 || '|' ||
      coalesce(r.provider,    '')                                         || '|' ||
      coalesce(r.model_name,  '')                                         || '|' ||
      coalesce(r.method,      '')                                         || '|' ||
      coalesce(r.path,        '')                                         || '|' ||
      coalesce(r.input_hash,  '')                                         || '|' ||
      coalesce(r.output_hash, '')                                         || '|' ||
      coalesce(r.status_code::text, '')                                   || '|' ||
      coalesce(r.latency_ms::text,  '')                                   || '|' ||
      coalesce(r.chain_prev_hash, ''),
      'sha256'
    ),
    'hex'
  );
$$;

-- ─── BEFORE INSERT trigger: atomic chain_prev_hash computation ──────────────
-- Concurrency note: two proxy workers inserting for the same customer at the
-- same instant would race if the proxy tried to read the previous row itself.
-- A BEFORE INSERT trigger with a per-customer advisory lock serializes the
-- read-then-write inside a single transaction, which is the only correct
-- place for this to live.
create or replace function ledger.inference_logs_chain_trigger()
returns trigger
language plpgsql
as $$
declare
  prev           ledger.inference_logs;
  is_disclosure  boolean;
begin
  -- Serialize chain extension per customer so concurrent inserts don't fork.
  perform pg_advisory_xact_lock(hashtextextended(new.customer_id::text, 0));

  -- The genesis-disclosure row (inserted by this migration for pre-existing
  -- customers) always resets the chain: it's the explicit marker that
  -- historical unchained rows live BEFORE this point and subsequent rows
  -- form the tamper-evident chain.
  is_disclosure :=
       new.provider = 'ailedger-system'
   and new.path     = '/_chain/genesis';

  -- Only consider rows that are themselves part of the chain when looking
  -- for "previous". Legacy rows (chain_prev_hash IS NULL) are not chained.
  select *
    into prev
    from ledger.inference_logs
   where customer_id = new.customer_id
     and chain_prev_hash is not null
   order by id desc
   limit 1;

  if is_disclosure or not found then
    -- Genesis: the first chained row per customer uses an all-zero nil hash.
    new.chain_prev_hash  := repeat('0', 64);
    new.chain_genesis_at := coalesce(new.chain_genesis_at, new.logged_at, now());
  else
    new.chain_prev_hash  := ledger.canonical_hash(prev);
    new.chain_genesis_at := coalesce(new.chain_genesis_at, prev.chain_genesis_at);
  end if;

  return new;
end;
$$;

drop trigger if exists inference_logs_chain on ledger.inference_logs;
create trigger inference_logs_chain
before insert on ledger.inference_logs
for each row execute function ledger.inference_logs_chain_trigger();

-- ─── Genesis disclosure row ─────────────────────────────────────────────────
-- Regulator-readable marker that historical rows (pre-migration) were NOT
-- retroactively chained. This is inserted once per existing customer that
-- already has rows; if the customer has no rows the genesis happens
-- naturally at their first real insert.
insert into ledger.inference_logs (
  customer_id, provider, model_name, method, path,
  input_hash, output_hash, status_code, latency_ms
)
select distinct
  customer_id,
  'ailedger-system',
  'chain-genesis-disclosure',
  'NOTICE',
  '/_chain/genesis',
  null,
  null,
  0,
  0
from ledger.inference_logs
where customer_id not in (
  select customer_id
    from ledger.inference_logs
   where path = '/_chain/genesis'
     and provider = 'ailedger-system'
)
on conflict do nothing;

-- ─── verify_chain: recompute and report first break ─────────────────────────
-- Returns jsonb:
--   { ok: bool, broken_at_id: bigint|null, expected_hash: text|null,
--     actual_hash: text|null, chain_head_hash: text|null, row_count: bigint }
-- Security: SECURITY INVOKER (default). RLS on inference_logs means a
-- customer-authenticated caller can only verify their own chain. The
-- service role bypasses RLS for CLI use.
create or replace function ledger.verify_chain(p_customer_id uuid default auth.uid())
returns jsonb
language plpgsql
stable
as $$
declare
  expected  text := repeat('0', 64);
  r         ledger.inference_logs;
  n         bigint := 0;
begin
  if p_customer_id is null then
    return jsonb_build_object(
      'ok', false, 'broken_at_id', null,
      'expected_hash', null, 'actual_hash', null,
      'chain_head_hash', null, 'row_count', 0,
      'error', 'no customer_id (unauthenticated and no arg provided)'
    );
  end if;

  -- Only iterate chained rows. Legacy rows (chain_prev_hash IS NULL,
  -- inserted before this migration) are explicitly outside the chain and
  -- separated from chained rows by the genesis-disclosure row.
  for r in
    select *
      from ledger.inference_logs
     where customer_id = p_customer_id
       and chain_prev_hash is not null
     order by id asc
  loop
    n := n + 1;
    if r.chain_prev_hash is distinct from expected then
      return jsonb_build_object(
        'ok',              false,
        'broken_at_id',    r.id,
        'expected_hash',   expected,
        'actual_hash',     r.chain_prev_hash,
        'chain_head_hash', null,
        'row_count',       n
      );
    end if;
    expected := ledger.canonical_hash(r);
  end loop;

  return jsonb_build_object(
    'ok',              true,
    'broken_at_id',    null,
    'expected_hash',   null,
    'actual_hash',     null,
    'chain_head_hash', case when n = 0 then null else expected end,
    'row_count',       n
  );
end;
$$;

-- ─── chain_head: cheap getter for audit-PDF export ──────────────────────────
create or replace function ledger.chain_head(p_customer_id uuid default auth.uid())
returns jsonb
language plpgsql
stable
as $$
declare
  last_row ledger.inference_logs;
begin
  if p_customer_id is null then
    return jsonb_build_object('chain_head_hash', null, 'last_id', null, 'row_count', 0);
  end if;

  -- Consider only chained rows (legacy pre-migration rows are excluded).
  select *
    into last_row
    from ledger.inference_logs
   where customer_id = p_customer_id
     and chain_prev_hash is not null
   order by id desc
   limit 1;

  if not found then
    return jsonb_build_object('chain_head_hash', null, 'last_id', null, 'row_count', 0);
  end if;

  return jsonb_build_object(
    'chain_head_hash', ledger.canonical_hash(last_row),
    'last_id',         last_row.id,
    'row_count',       (
      select count(*)
        from ledger.inference_logs
       where customer_id = p_customer_id
         and chain_prev_hash is not null
    )
  );
end;
$$;

-- ─── Grants ─────────────────────────────────────────────────────────────────
grant execute on function ledger.verify_chain(uuid) to authenticated, service_role;
grant execute on function ledger.chain_head(uuid)   to authenticated, service_role;
grant execute on function ledger.canonical_hash(ledger.inference_logs) to authenticated, service_role;
