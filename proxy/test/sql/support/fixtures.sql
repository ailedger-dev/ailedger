-- Bootstrap the Supabase-shaped surface the tamper-evident-chain migration
-- assumes: an `auth` schema with `users(id uuid)`, an `auth.uid()` resolver,
-- the `authenticated` and `service_role` roles, and the `ledger` schema with
-- `inference_logs`. After this runs, the production migration file can be
-- applied verbatim against the same database.

create schema if not exists extensions;
create schema if not exists ledger;
create schema if not exists auth;

-- Roles Supabase provides out of the box. We re-create them locally so the
-- production GRANTs in the migration succeed unchanged. NOLOGIN because we
-- only ever `set local role` to them; we never connect as them.
do $$
begin
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit nologin;
  end if;
end$$;

grant authenticated, anon, service_role to authenticator;
grant usage on schema auth, ledger, extensions to authenticated, service_role, anon;

-- Mock auth.users — production has columns we don't need. The chain migration
-- only references the FK, so a single `id` column is enough.
create table if not exists auth.users (
  id uuid primary key
);
grant select on auth.users to authenticated, service_role;

-- auth.uid() in Supabase returns the JWT `sub` claim. Tests drive it via a
-- session config var so we can switch identity per-transaction with
-- `set local "test.uid" = '<uuid>'` — same semantics as Postgres GUC, no
-- extra extension required.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;
grant execute on function auth.uid() to authenticated, service_role, anon;

-- ledger.inference_logs — copied from proxy/schema.sql. Kept minimal: the
-- columns the migration's canonical_hash() reads, plus the FK to auth.users
-- and the RLS policy we need for the cross-tenant verify_chain test.
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
  latency_ms      int         not null
);

create index if not exists inference_logs_customer_logged_at
  on ledger.inference_logs (customer_id, logged_at desc);

-- RLS so customer A literally cannot see customer B's rows, mirroring the
-- production policy. `force` is critical: without it, a table owner (which
-- the test connection effectively is) bypasses RLS even with it enabled.
alter table ledger.inference_logs enable row level security;
alter table ledger.inference_logs force row level security;

drop policy if exists "customers read own logs" on ledger.inference_logs;
create policy "customers read own logs"
  on ledger.inference_logs
  for select
  using (customer_id = auth.uid());

-- Customers also need INSERT for the chain-construction tests; production
-- proxy inserts run via service_role (which bypasses RLS), but our T3 tests
-- assert the trigger fires under an authenticated role so we add a matching
-- INSERT policy. Production is unchanged — this only exists in the fixture.
drop policy if exists "customers insert own logs" on ledger.inference_logs;
create policy "customers insert own logs"
  on ledger.inference_logs
  for insert
  with check (customer_id = auth.uid());

grant usage  on schema ledger to authenticated, service_role;
grant select, insert on ledger.inference_logs        to authenticated;
grant all     on ledger.inference_logs               to service_role;
grant usage, select on sequence ledger.inference_logs_id_seq
  to authenticated, service_role;
