-- Migration: api_keys.system_id → account_settings.id ON DELETE SET NULL
-- Context: deleting an AI system via dashboard left api_keys pointing at a
-- now-nonexistent account_settings row (silent data-integrity loss — the
-- dashboard just displayed "-" because the join returned nothing).
--
-- Run in the Supabase SQL editor. Idempotent: safe to re-run.

-- Null out any pre-existing orphans so the FK can be added/recreated cleanly.
update ledger.api_keys
set system_id = null
where system_id is not null
  and system_id not in (select id from ledger.account_settings);

-- Drop any existing FK constraint on system_id, regardless of its prior name,
-- so we can restate it with the desired ON DELETE behavior.
do $$
declare
  r record;
begin
  for r in
    select conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'ledger'
      and t.relname = 'api_keys'
      and c.contype = 'f'
      and c.conkey = (
        select array_agg(attnum order by attnum)
        from pg_attribute
        where attrelid = t.oid and attname = 'system_id'
      )
  loop
    execute format('alter table ledger.api_keys drop constraint %I', r.conname);
  end loop;
end$$;

alter table ledger.api_keys
  add constraint api_keys_system_id_fkey
  foreign key (system_id)
  references ledger.account_settings(id)
  on delete set null;
