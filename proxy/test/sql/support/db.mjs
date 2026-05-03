import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../../..");

export const FIXTURES_SQL = resolve(here, "fixtures.sql");
export const CHAIN_MIGRATION_SQL = resolve(
  REPO,
  "proxy/migrations/20260418_tamper_evident_chain.sql",
);

// One pool per test process. Tests create their own per-test schema via
// fresh customer UUIDs so concurrent test files don't trample each other.
let _pool;
export function pool() {
  if (_pool) return _pool;
  const url = process.env.AILEDGER_TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "AILEDGER_TEST_DATABASE_URL is not set. SQL tests require a real " +
        "Postgres (>=15) — see proxy/test/sql/README.md for setup.",
    );
  }
  _pool = new pg.Pool({ connectionString: url, max: 16 });
  return _pool;
}

export async function endPool() {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
  }
}

// Apply fixtures + the chain migration. Idempotent — safe to call from every
// test file's beforeAll. The migration itself is `create or replace` for
// functions and `if not exists` for columns, so re-running is a no-op.
let _bootstrapped;
export async function bootstrap() {
  if (_bootstrapped) return _bootstrapped;
  _bootstrapped = (async () => {
    const fixtures = await readFile(FIXTURES_SQL, "utf8");
    const migration = await readFile(CHAIN_MIGRATION_SQL, "utf8");
    const client = await pool().connect();
    try {
      await client.query(fixtures);
      await client.query(migration);
    } finally {
      client.release();
    }
  })();
  return _bootstrapped;
}

// Run a callback with a dedicated client that has `auth.uid()` pinned to the
// given user via `set local`. Always inside an explicit transaction so the
// GUC is scoped and never leaks to the next checkout.
export async function asUser(userId, fn, { role = "authenticated" } = {}) {
  const client = await pool().connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`);
    // set_config(..., is_local := true) is the parameterized form of
    // `set local "test.uid" = $1` — Postgres has no parameterized SET.
    await client.query("select set_config('test.uid', $1, true)", [userId]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Service-role helper for setup and teardown work that must bypass RLS
// (e.g. seeding auth.users, deleting fixture rows).
export async function asService(fn) {
  const client = await pool().connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Ensure an auth.users row exists for the given uuid. Returns the uuid for
// chaining. Idempotent.
export async function ensureUser(client, userId) {
  await client.query(
    "insert into auth.users(id) values ($1) on conflict do nothing",
    [userId],
  );
  return userId;
}

// Insert a chained log row as the given user. Returns the new id.
export async function insertLog(client, customerId, overrides = {}) {
  const row = {
    provider: "openai",
    model_name: "gpt-4",
    method: "POST",
    path: "/chat/completions",
    input_hash: "a".repeat(64),
    output_hash: "b".repeat(64),
    status_code: 200,
    latency_ms: 42,
    ...overrides,
  };
  const result = await client.query(
    `insert into ledger.inference_logs
       (customer_id, provider, model_name, method, path,
        input_hash, output_hash, status_code, latency_ms)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning id, chain_prev_hash`,
    [
      customerId,
      row.provider,
      row.model_name,
      row.method,
      row.path,
      row.input_hash,
      row.output_hash,
      row.status_code,
      row.latency_ms,
    ],
  );
  return result.rows[0];
}

export const NIL_HASH = "0".repeat(64);

// Quick UUID v4 helper so tests don't need to import a UUID lib for what is
// effectively `crypto.randomUUID()` with a slight readability tweak.
export function newCustomerId() {
  return crypto.randomUUID();
}
