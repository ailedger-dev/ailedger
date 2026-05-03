// T4 — verify_chain.
// Covers every branch of `ledger.verify_chain`: empty chain, singleton chain,
// long valid chain, tampered row detection, mid-chain genesis-disclosure
// reset, and the cross-tenant RLS boundary.
//
// Authority: docs/ailedger-test-plan.md §T4.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  asService,
  asUser,
  bootstrap,
  endPool,
  ensureUser,
  insertLog,
  newCustomerId,
} from "./support/db.mjs";

before(async () => {
  await bootstrap();
});

after(async () => {
  await endPool();
});

async function verify(client, customerId) {
  const r = await client.query("select ledger.verify_chain($1) as r", [customerId]);
  return r.rows[0].r;
}

async function canonicalHashOf(client, rowId) {
  const r = await client.query(
    "select ledger.canonical_hash(r) as h from ledger.inference_logs r where r.id = $1",
    [rowId],
  );
  return r.rows[0].h;
}

describe("T4 verify_chain", () => {
  it("empty chain returns ok:true, row_count:0, chain_head_hash:null", async () => {
    const customerId = newCustomerId();
    await asService(async (c) => {
      await ensureUser(c, customerId);
      const v = await verify(c, customerId);
      assert.equal(v.ok, true);
      assert.equal(v.row_count, 0);
      assert.equal(v.chain_head_hash, null);
      assert.equal(v.broken_at_id, null);
    });
  });

  it("single chained row returns ok:true, row_count:1, chain_head_hash matches canonical_hash of that row", async () => {
    const customerId = newCustomerId();
    let rowId;
    await asService(async (c) => {
      await ensureUser(c, customerId);
    });
    await asUser(customerId, async (c) => {
      const r = await insertLog(c, customerId);
      rowId = r.id;
    });
    await asService(async (c) => {
      const expectedHead = await canonicalHashOf(c, rowId);
      const v = await verify(c, customerId);
      assert.equal(v.ok, true);
      assert.equal(v.row_count, 1);
      assert.equal(v.chain_head_hash, expectedHead);
      assert.equal(v.broken_at_id, null);
    });
  });

  it("long valid chain (1000 rows) returns ok:true, row_count:1000", async () => {
    const customerId = newCustomerId();
    await asService(async (c) => {
      await ensureUser(c, customerId);
    });

    // Sequential here — concurrent variant lives in chain.spec.mjs (T3).
    // Bulk insert keeps wall time reasonable; correctness is the property
    // under test.
    await asUser(customerId, async (c) => {
      for (let i = 0; i < 1000; i++) {
        await insertLog(c, customerId, { latency_ms: i });
      }
    });

    await asService(async (c) => {
      const v = await verify(c, customerId);
      assert.equal(v.ok, true, `expected ok:true, got ${JSON.stringify(v)}`);
      assert.equal(v.row_count, 1000);
      assert.equal(v.broken_at_id, null);
      assert.notEqual(v.chain_head_hash, null);
      assert.equal(v.chain_head_hash.length, 64);
    });
  });

  it("tampered row at id N is reported as broken_at_id with expected/actual hashes", async () => {
    const customerId = newCustomerId();
    const ids = [];
    await asService(async (c) => {
      await ensureUser(c, customerId);
    });
    await asUser(customerId, async (c) => {
      for (let i = 0; i < 6; i++) {
        const r = await insertLog(c, customerId, { latency_ms: i });
        ids.push(r.id);
      }
    });

    // Tamper: rewrite row #2's input_hash. The chain entry on row #3 was
    // computed from the *original* row #2, so verify_chain should:
    //   - succeed through rows 1 and 2 (their stored chain_prev_hash values
    //     are still consistent with the rows that came before),
    //   - fail at row #3 because expected (canonical_hash of tampered row #2)
    //     no longer matches the stored chain_prev_hash on row #3.
    // We must use a ledger-specific UPDATE path: the production policy
    // revokes UPDATE from authenticated/anon. service_role still has it
    // (granted via "grant all" on the table) so we tamper via that role.
    await asService(async (c) => {
      // Re-grant UPDATE just for this test connection — the production
      // schema explicitly revokes it as a defensive measure, but we need to
      // simulate "an attacker with direct DB access tampered with a row".
      await c.query("grant update on ledger.inference_logs to service_role");
      await c.query(
        "update ledger.inference_logs set input_hash = $1 where id = $2",
        ["c".repeat(64), ids[1]],
      );
    });

    await asService(async (c) => {
      const v = await verify(c, customerId);
      assert.equal(v.ok, false, `expected ok:false, got ${JSON.stringify(v)}`);
      assert.equal(
        v.broken_at_id,
        ids[2],
        "verify_chain should report the first row whose stored prev_hash no longer matches",
      );
      // expected_hash = canonical_hash recomputed from the (now-tampered)
      // row #2; actual_hash = the unchanged stored chain_prev_hash on row #3.
      const expectedNow = await canonicalHashOf(c, ids[1]);
      assert.equal(v.expected_hash, expectedNow);
      // actual is whatever was stored on row #3 (computed before tamper).
      const stored = await c.query(
        "select chain_prev_hash from ledger.inference_logs where id = $1",
        [ids[2]],
      );
      assert.equal(v.actual_hash, stored.rows[0].chain_prev_hash);
      assert.notEqual(v.expected_hash, v.actual_hash);
      assert.equal(v.chain_head_hash, null, "chain_head_hash must be null when chain is broken");
      // row_count is the count up to and including the broken row.
      assert.equal(v.row_count, 3);
    });
  });

  it("chain with mid-chain redaction/genesis-disclosure rows reports correctly", async () => {
    // The chain trigger treats provider='ailedger-system', path='/_chain/genesis'
    // as a chain reset. verify_chain has to follow that reset — i.e., the
    // disclosure row's chain_prev_hash is the nil hash, and that's still
    // "expected" at the moment we get to it because the prior loop iteration
    // set `expected := canonical_hash(prev_row)`. So a disclosure row mid-
    // chain SHOULD make verify_chain report ok:false at the disclosure row
    // (its stored prev_hash is nil, not canonical_hash of the row before).
    //
    // This test pins that behavior so future migration changes can't silently
    // change it: the disclosure row is observable, and tampering produces a
    // distinguishable signal.
    const customerId = newCustomerId();
    await asService(async (c) => {
      await ensureUser(c, customerId);
    });

    await asUser(customerId, async (c) => {
      for (let i = 0; i < 3; i++) {
        await insertLog(c, customerId, { latency_ms: i });
      }
    });

    let disclosureId;
    await asService(async (c) => {
      const r = await c.query(
        `insert into ledger.inference_logs
           (customer_id, provider, model_name, method, path,
            input_hash, output_hash, status_code, latency_ms)
         values ($1, 'ailedger-system', 'chain-genesis-disclosure',
                 'NOTICE', '/_chain/genesis', null, null, 0, 0)
         returning id`,
        [customerId],
      );
      disclosureId = r.rows[0].id;
    });

    await asService(async (c) => {
      const v = await verify(c, customerId);
      // The disclosure row resets the chain, so verify_chain (which is a
      // single-pass linear walk) sees a discontinuity at the disclosure row.
      // This is the *intended* tamper-evident signal — auditors who see this
      // structure are expected to interpret a disclosure-row "break" as an
      // intentional reset and resume verification from there. The function
      // itself just reports the first discontinuity.
      assert.equal(v.ok, false, "linear walk must report the disclosure-row reset");
      assert.equal(v.broken_at_id, disclosureId);
      assert.equal(v.actual_hash, "0".repeat(64), "disclosure row's stored prev is nil");
      // row_count is the count up to and including the disclosure row.
      assert.equal(v.row_count, 4);
    });
  });

  it("customer A cannot run verify_chain against customer B (RLS / SECURITY INVOKER)", async () => {
    const A = newCustomerId();
    const B = newCustomerId();
    await asService(async (c) => {
      await ensureUser(c, A);
      await ensureUser(c, B);
    });
    // B has a 5-row chain; A has none.
    await asUser(B, async (c) => {
      for (let i = 0; i < 5; i++) {
        await insertLog(c, B, { latency_ms: i });
      }
    });

    // Sanity: as B, B's chain verifies with row_count:5.
    await asUser(B, async (c) => {
      const v = await verify(c, B);
      assert.equal(v.ok, true);
      assert.equal(v.row_count, 5);
    });

    // The probe: as A, ask verify_chain to inspect B's customer_id.
    // verify_chain runs SECURITY INVOKER, so the SELECT inside it is
    // filtered by the RLS policy `customer_id = auth.uid()` — and since
    // auth.uid() returns A here, no rows of B's are visible. The function
    // therefore reports an empty chain rather than leaking B's data.
    await asUser(A, async (c) => {
      const v = await verify(c, B);
      assert.equal(
        v.row_count,
        0,
        "RLS must hide B's rows from A — verify_chain seen by A must look empty",
      );
      assert.equal(v.ok, true, "an empty (RLS-filtered) chain still trivially verifies");
      assert.equal(v.chain_head_hash, null);
    });
  });
});
