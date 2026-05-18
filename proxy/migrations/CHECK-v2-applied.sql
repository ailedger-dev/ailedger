-- Diagnostic script: is the v2 schema applied to this Supabase instance?
--
-- Run this in Supabase SQL Editor (Production project).
-- READ-ONLY. Safe to run any time.
--
-- Output: a single row indicating which v2 objects exist and which are missing.
-- Use the row to decide whether to apply the 20260512_* + 20260518 migration
-- stack, or whether the schema is already in place.

with checks as (
  select
    -- 20260512_decision_events_schema.sql
    (to_regclass('ledger.decision_events') is not null)
      as decision_events_table_exists,

    -- 20260512_decision_events_chain_trigger.sql
    exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'ledger' and p.proname = 'decision_events_canonical_hash'
    ) as canonical_hash_function_exists,

    exists (
      select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'ledger'
        and c.relname = 'decision_events'
        and t.tgname like '%chain%'
    ) as chain_trigger_exists,

    -- 20260512_decision_type_taxonomy_seed.sql
    exists (
      select 1 from information_schema.tables
      where table_schema = 'ledger' and table_name = 'decision_type_taxonomy'
    ) as decision_type_taxonomy_exists,

    -- 20260512_protected_class_taxonomy_seed.sql
    -- Actual table name is `protected_class_field_taxonomy` per
    -- proxy/migrations/20260512_protected_class_taxonomy_seed.sql line 17.
    exists (
      select 1 from information_schema.tables
      where table_schema = 'ledger' and table_name = 'protected_class_field_taxonomy'
    ) as protected_class_field_taxonomy_exists,

    -- 20260512_subject_pseudonymization.sql
    exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'ledger' and p.proname like '%pseudonymize%'
    ) as pseudonymization_function_exists,

    -- 20260518_inferred_detection_events.sql
    exists (
      select 1 from information_schema.columns
      where table_schema = 'ledger'
        and table_name = 'decision_events'
        and column_name = 'extractor_method'
    ) as extractor_method_column_exists,

    exists (
      select 1 from information_schema.columns
      where table_schema = 'ledger'
        and table_name = 'decision_events'
        and column_name = 'chain_spec_version'
    ) as chain_spec_version_column_exists,

    exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'ledger' and p.proname = 'decision_events_canonical_hash_v2'
    ) as canonical_hash_v2_function_exists
)
select
  case
    when not decision_events_table_exists then
      'STATE 0: No v2 schema applied. Apply 20260512_* migrations + 20260518 in order.'
    when decision_events_table_exists
      and not extractor_method_column_exists
      and not chain_spec_version_column_exists then
      'STATE 1: 20260512_* applied but 20260518 NOT applied. Apply 20260518_inferred_detection_events.sql.'
    when decision_events_table_exists
      and extractor_method_column_exists
      and chain_spec_version_column_exists
      and canonical_hash_v2_function_exists then
      'STATE 2: Full v2 + inferred-event extension applied. Schema is current.'
    else
      'STATE UNKNOWN: partial / unexpected state. Inspect the individual checks below.'
  end as schema_state,

  decision_events_table_exists,
  canonical_hash_function_exists,
  chain_trigger_exists,
  decision_type_taxonomy_exists,
  protected_class_field_taxonomy_exists,
  pseudonymization_function_exists,
  extractor_method_column_exists,
  chain_spec_version_column_exists,
  canonical_hash_v2_function_exists
from checks;

-- Optional follow-up: if STATE 2, run separately to get row count:
--   select count(*) from ledger.decision_events;
