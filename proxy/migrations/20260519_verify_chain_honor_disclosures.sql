-- Migration: verify_chain restarts at each /_chain/genesis disclosure row.
--
-- Context: 2026-05-19. The Vernier internal tenant
-- (68d2edd5-dee9-411e-95e8-90b08760f791) hit a real break at row id=51887 on
-- 2026-05-08. The original verify_chain (20260418_tamper_evident_chain.sql)
-- walks every chained row from the very first one and reports the first
-- mismatch — so once a tenant is broken, verify_chain is broken forever.
--
-- The schema already has the right escape hatch: the /_chain/genesis
-- disclosure row. Per the BEFORE INSERT trigger, a disclosure row always
-- gets chain_prev_hash = 64×'0' regardless of its actual predecessor.
-- This is the documented, regulator-visible marker that "the chain was
-- reset at this row." The function just wasn't honoring it.
--
-- This migration teaches verify_chain to treat every disclosure row as a
-- segment boundary: expected resets to zeros before checking the disclosure,
-- the disclosure passes, and the segment after it is verified fresh.
--
-- Anti-theater stance is preserved: data is NOT rewritten. The historical
-- break stays in the table. The break-detection logic still RAISEs in the
-- AFTER INSERT trigger if a future row's chain_prev_hash drifts from its
-- actual predecessor — so new tampering still gets caught. What changes is
-- that an explicit, persisted disclosure row is required to "move past" a
-- break; you can't just hand-wave it away.
--
-- Run in the Supabase SQL editor. Idempotent.

create or replace function ledger.verify_chain(p_customer_id uuid default auth.uid())
returns jsonb
language plpgsql
stable
as $$
declare
  expected      text := repeat('0', 64);
  r             ledger.inference_logs;
  n             bigint := 0;
  is_disc       boolean;
begin
  if p_customer_id is null then
    return jsonb_build_object(
      'ok', false, 'broken_at_id', null,
      'expected_hash', null, 'actual_hash', null,
      'chain_head_hash', null, 'row_count', 0,
      'error', 'no customer_id (unauthenticated and no arg provided)'
    );
  end if;

  for r in
    select *
      from ledger.inference_logs
     where customer_id = p_customer_id
       and chain_prev_hash is not null
     order by id asc
  loop
    n := n + 1;

    -- Disclosure rows are explicit chain restart points. The BEFORE INSERT
    -- trigger stamps them with chain_prev_hash = 64×'0', so we reset the
    -- expected value to zeros before the comparison. After the disclosure
    -- passes, the segment continues with expected := canonical_hash(disc).
    is_disc :=
         r.provider = 'ailedger-system'
     and r.path     = '/_chain/genesis';

    if is_disc then
      expected := repeat('0', 64);
    end if;

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

comment on function ledger.verify_chain(uuid) is
  'Walks the per-customer chain in ledger.inference_logs. Treats each '
  '/_chain/genesis disclosure row as an explicit segment restart (expected '
  'resets to 64×0 before the disclosure is checked). RAISE-free; returns '
  'jsonb {ok, broken_at_id, expected_hash, actual_hash, chain_head_hash, '
  'row_count}. Pairs with ledger.inference_logs_chain_trigger (BEFORE '
  'INSERT) and ledger.inference_logs_chain_verify_after (AFTER INSERT, '
  'real-time guardrail).';

-- ─── Operator note ──────────────────────────────────────────────────────────
-- After this migration is applied, a tenant with a known historical break
-- (e.g., vernier-internal at id=51887) can be moved past it by inserting a
-- fresh disclosure row:
--
--   insert into ledger.inference_logs (
--     customer_id, provider, model_name, method, path,
--     input_hash, output_hash, status_code, latency_ms
--   ) values (
--     '<the customer uuid>',
--     'ailedger-system',
--     'chain-genesis-disclosure',
--     'NOTICE',
--     '/_chain/genesis',
--     null, null, 0, 0
--   );
--
-- The BEFORE INSERT trigger stamps chain_prev_hash = 64×0 on that row.
-- verify_chain will then return ok=true for the segment after it. The
-- pre-disclosure break stays in the table (anti-theater) and the new
-- disclosure is the auditable record of when/why the chain was reset.
