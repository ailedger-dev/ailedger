-- Migration: decision_type taxonomy + seed data
--
-- Context: AILedger posture v2. Decision Event records reference a
-- decision_type from a fixed taxonomy aligned with EU AI Act Annex III
-- high-risk categories. Spec at ~/workspace/dev/ailedger/CLAUDE.md.
--
-- Note: `law_enforcement` is kept in the taxonomy for completeness but is
-- refused at intake per Charter v1.1 ("Customers we refuse"). The ingest
-- API must reject decision_events with decision_type='law_enforcement'.
--
-- Idempotent: safe to re-run. Adding rows uses on-conflict-do-nothing so
-- pre-existing rows are preserved.

-- ─── decision_type_taxonomy table ────────────────────────────────────────────

create table if not exists ledger.decision_type_taxonomy (
  code              text primary key,
  display_name      text not null,
  description       text not null,
  annex_iii_category text,
    -- Mapping to EU AI Act Annex III high-risk category name. Free-text
    -- because Annex III categories may shift in delegated acts; keep
    -- the mapping flexible.
  applicable_articles jsonb not null default '[]'::jsonb,
    -- Array of EU AI Act article numbers that apply to this decision_type.
    -- E.g., ["12", "19", "26"]. Used for downstream evidence generation.
  refused_at_intake boolean not null default false,
    -- If true, the ingest API rejects decision_events with this decision_type.
    -- Maintained for completeness in the taxonomy but commercially refused.
  created_at        timestamptz not null default now()
);

comment on table ledger.decision_type_taxonomy is
  'Canonical decision_type values for ledger.decision_events.decision_type. '
  'Aligned with EU AI Act Annex III high-risk categories. Adding new codes '
  'requires migration; customer-facing API rejects values not in this table.';

comment on column ledger.decision_type_taxonomy.refused_at_intake is
  'When true, ingest API rejects decision_events with this code. Charter-'
  'refused category (predictive policing, social scoring). Code kept in '
  'taxonomy for completeness; usage refused at sale.';

-- ─── Seed data: Annex III high-risk decision types ──────────────────────────

insert into ledger.decision_type_taxonomy
  (code, display_name, description, annex_iii_category, applicable_articles, refused_at_intake)
values
  (
    'biometric_identification',
    'Biometric identification',
    'AI systems intended for biometric identification of natural persons (excluding biometric verification for narrow access-control purposes already covered elsewhere in law).',
    'Annex III 1(a)',
    '["12", "19", "26"]'::jsonb,
    false
  ),
  (
    'critical_infrastructure_management',
    'Critical infrastructure management',
    'AI systems intended to be used as safety components in the management and operation of critical digital infrastructure, road traffic, or the supply of water, gas, heating, and electricity.',
    'Annex III 2',
    '["12", "19", "26"]'::jsonb,
    false
  ),
  (
    'education_assessment',
    'Education and vocational training assessment',
    'AI systems for determining access to or admission to educational institutions; evaluating learning outcomes; assigning levels; assessing test-taking behavior. Includes admissions, grading, and evaluation contexts.',
    'Annex III 3',
    '["12", "19", "26"]'::jsonb,
    false
  ),
  (
    'employment_screening',
    'Employment and worker management',
    'AI systems for recruitment, hiring, promotion, task allocation, monitoring and evaluation of workers, termination of work-related relationships, allocation of tasks based on individual behavior or personal traits.',
    'Annex III 4',
    '["12", "19", "26"]'::jsonb,
    false
  ),
  (
    'essential_services_eligibility',
    'Access to essential services',
    'AI systems determining eligibility for essential public assistance benefits, credit and insurance, emergency dispatch, classification of emergency calls.',
    'Annex III 5',
    '["12", "19", "26"]'::jsonb,
    false
  ),
  (
    'law_enforcement',
    'Law enforcement (refused at intake)',
    'AI systems for predictive policing, individual risk assessment of natural persons committing or recommitting offenses, polygraph and similar tools, evaluation of reliability of evidence, profiling of natural persons. Listed in taxonomy for completeness; AILedger refuses customers in this category per Charter v1.1.',
    'Annex III 6',
    '["12", "19", "26"]'::jsonb,
    true  -- REFUSED AT INTAKE per Charter v1.1
  ),
  (
    'migration_asylum_border',
    'Migration, asylum, and border control',
    'AI systems for risk assessment regarding migration, asylum, border control, examination of asylum/visa/residence permit applications, related complaints.',
    'Annex III 7',
    '["12", "19", "26"]'::jsonb,
    false
  ),
  (
    'justice_democratic_processes',
    'Administration of justice and democratic processes',
    'AI systems intended to assist judicial authorities in researching and interpreting facts and law, applying the law to a concrete set of facts; AI systems intended to influence outcomes of elections or voting behavior of natural persons.',
    'Annex III 8',
    '["12", "19", "26"]'::jsonb,
    false
  ),
  (
    'medical_diagnosis_triage',
    'Medical diagnosis and triage',
    'AI systems used in medical contexts for diagnostic support, triage, or risk stratification of patients. Subject to additional sectoral regulation (MDR, IVDR) on top of AI Act obligations.',
    'Annex III (sector-specific via medical devices regulation)',
    '["12", "19", "26"]'::jsonb,
    false
  ),
  (
    'medical_treatment_recommendation',
    'Medical treatment recommendation',
    'AI systems recommending or determining medical treatments, dosages, or care plans. Sector regulation applies in addition to AI Act.',
    'Annex III (sector-specific via medical devices regulation)',
    '["12", "19", "26"]'::jsonb,
    false
  )
on conflict (code) do nothing;

-- ─── Add FK from decision_events to taxonomy ────────────────────────────────
-- Done in this migration (not the schema migration) so the taxonomy table
-- exists before the FK is enforced.

do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where constraint_name = 'decision_events_decision_type_fkey'
      and table_schema = 'ledger'
      and table_name = 'decision_events'
  ) then
    alter table ledger.decision_events
      add constraint decision_events_decision_type_fkey
      foreign key (decision_type)
      references ledger.decision_type_taxonomy (code);
  end if;
end
$$;

-- ─── Ingest-API enforcement note ────────────────────────────────────────────
-- The application layer (proxy / decision-event ingest endpoint) must
-- reject incoming Decision Events with decision_type values where
-- refused_at_intake = true. This is enforced in code, not schema, because
-- the value should be visible in the taxonomy for documentation, audit,
-- and migration purposes. Test v2-T12 (refused-customer-at-intake) in
-- docs/ailedger-test-plan.md covers this enforcement path.
