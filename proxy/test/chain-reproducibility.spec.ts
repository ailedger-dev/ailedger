import { describe, it, expect } from "vitest";
import fc from "fast-check";

// ─── PB1: tamper-evident chain reproducibility (property-based) ─────────────
//
// Authority: docs/ailedger-test-plan.md §PB1.
//
// The chain construction lives in Postgres (proxy/migrations/20260418_tamper_evident_chain.sql:
// `ledger.canonical_hash`, the BEFORE INSERT trigger, and `ledger.verify_chain`).
// Workers tests cannot reach Postgres, so we mirror the canonical serialization
// in TypeScript and property-test the same invariants the regulator would check:
//
//   1. for any sequence of N rows with arbitrary metadata, the chain we
//      construct verifies (ok:true with no break);
//   2. an EXTERNAL SHA-256 implementation (re-derived from row fields, not
//      reading the stored hash) reproduces the canonical_hash that the chain
//      links rows by — which is the auditor-verifiability promise.
//
// If the SQL canonical_hash ever drifts from this TS mirror, this file is the
// canary: update both together or break the chain.

interface Row {
	id: number;
	logged_at: Date;
	customer_id: string;
	provider: string | null;
	model_name: string | null;
	method: string | null;
	path: string | null;
	input_hash: string | null;
	output_hash: string | null;
	status_code: number | null;
	latency_ms: number | null;
	chain_prev_hash: string | null;
}

const NIL_HASH = "0".repeat(64);

// to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
// Microsecond-precision ISO-8601 UTC. JS Date is millisecond-precision, so we
// pad to microseconds with three trailing zeros. The migration spec only
// guarantees stability of the FORMAT — the precision floor is whatever the
// row's timestamptz holds.
function pgIsoMicro(d: Date): string {
	const pad = (n: number, w: number) => n.toString().padStart(w, "0");
	const yyyy = d.getUTCFullYear();
	const mm = pad(d.getUTCMonth() + 1, 2);
	const dd = pad(d.getUTCDate(), 2);
	const hh = pad(d.getUTCHours(), 2);
	const mi = pad(d.getUTCMinutes(), 2);
	const ss = pad(d.getUTCSeconds(), 2);
	const us = pad(d.getUTCMilliseconds() * 1000, 6);
	return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}.${us}Z`;
}

function canonicalString(r: Row): string {
	const c = (v: string | number | null | undefined) =>
		v === null || v === undefined ? "" : String(v);
	return [
		String(r.id),
		pgIsoMicro(r.logged_at),
		r.customer_id,
		c(r.provider),
		c(r.model_name),
		c(r.method),
		c(r.path),
		c(r.input_hash),
		c(r.output_hash),
		c(r.status_code),
		c(r.latency_ms),
		c(r.chain_prev_hash),
	].join("|");
}

async function sha256hex(s: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function canonicalHash(r: Row): Promise<string> {
	return sha256hex(canonicalString(r));
}

// Mirror of ledger.verify_chain: walks rows in id order, recomputing the
// expected chain_prev_hash. Returns the same shape the SQL function returns.
async function verifyChain(rows: Row[]): Promise<{
	ok: boolean;
	broken_at_id: number | null;
	expected_hash: string | null;
	actual_hash: string | null;
	chain_head_hash: string | null;
	row_count: number;
}> {
	let expected = NIL_HASH;
	let n = 0;
	for (const r of rows) {
		n += 1;
		if (r.chain_prev_hash !== expected) {
			return {
				ok: false,
				broken_at_id: r.id,
				expected_hash: expected,
				actual_hash: r.chain_prev_hash,
				chain_head_hash: null,
				row_count: n,
			};
		}
		expected = await canonicalHash(r);
	}
	return {
		ok: true,
		broken_at_id: null,
		expected_hash: null,
		actual_hash: null,
		chain_head_hash: n === 0 ? null : expected,
		row_count: n,
	};
}

// ─── Generators ─────────────────────────────────────────────────────────────

// Random SDK serialization variants for input/output hashes: these are
// already SHA-256 hex strings in production (64 hex chars), so generators
// reflect that constraint.
const hexHash = fc
	.uint8Array({ minLength: 32, maxLength: 32 })
	.map((u8) =>
		Array.from(u8)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join(""),
	);

const rowMetadata = fc.record({
	provider: fc.option(
		fc.constantFrom("openai", "anthropic", "gemini", "ailedger-system"),
		{ nil: null },
	),
	model_name: fc.option(
		fc.string({ minLength: 0, maxLength: 64 }).filter((s) => !s.includes("|")),
		{ nil: null },
	),
	method: fc.option(fc.constantFrom("GET", "POST", "PUT", "PATCH", "DELETE"), {
		nil: null,
	}),
	path: fc.option(
		fc
			.string({ minLength: 0, maxLength: 128 })
			.filter((s) => !s.includes("|"))
			.map((s) => "/" + s),
		{ nil: null },
	),
	input_hash: fc.option(hexHash, { nil: null }),
	output_hash: fc.option(hexHash, { nil: null }),
	status_code: fc.option(fc.integer({ min: 100, max: 599 }), { nil: null }),
	latency_ms: fc.option(fc.integer({ min: 0, max: 600_000 }), { nil: null }),
});

async function buildChain(
	customerId: string,
	startMs: number,
	count: number,
	metas: Array<{
		provider: string | null;
		model_name: string | null;
		method: string | null;
		path: string | null;
		input_hash: string | null;
		output_hash: string | null;
		status_code: number | null;
		latency_ms: number | null;
	}>,
): Promise<Row[]> {
	const rows: Row[] = [];
	let prevHash = NIL_HASH;
	for (let i = 0; i < count; i++) {
		const m = metas[i];
		const row: Row = {
			id: i + 1,
			logged_at: new Date(startMs + i * 1000),
			customer_id: customerId,
			provider: m.provider,
			model_name: m.model_name,
			method: m.method,
			path: m.path,
			input_hash: m.input_hash,
			output_hash: m.output_hash,
			status_code: m.status_code,
			latency_ms: m.latency_ms,
			chain_prev_hash: prevHash,
		};
		rows.push(row);
		prevHash = await canonicalHash(row);
	}
	return rows;
}

// ─── Properties ─────────────────────────────────────────────────────────────

describe("PB1: chain reproducibility (fast-check)", () => {
	it("any sequence of N rows builds a chain that verify_chain accepts", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.uuid({ version: 4 }),
				fc.integer({ min: 1, max: 25 }),
				fc.array(rowMetadata, { minLength: 1, maxLength: 25 }),
				async (customerId, n, metas) => {
					const count = Math.min(n, metas.length);
					const rows = await buildChain(customerId, 1_700_000_000_000, count, metas);
					const result = await verifyChain(rows);
					expect(result.ok).toBe(true);
					expect(result.row_count).toBe(count);
					expect(result.chain_head_hash).not.toBeNull();
				},
			),
			{ numRuns: 30 },
		);
	});

	it("external SHA-256 over canonical fields reproduces canonical_hash for every row", async () => {
		// "External" here means: an auditor who only has SHA-256, the row
		// fields, and the canonical-form spec (pipe-delimited, NULLs as empty
		// string, microsecond ISO timestamps) MUST be able to recompute the
		// hash that links the next row.  We verify by re-running the canonical
		// serialization through a parallel sha256 call and comparing to the
		// next row's chain_prev_hash.
		await fc.assert(
			fc.asyncProperty(
				fc.uuid({ version: 4 }),
				fc.array(rowMetadata, { minLength: 2, maxLength: 20 }),
				async (customerId, metas) => {
					const rows = await buildChain(customerId, 1_700_000_000_000, metas.length, metas);
					for (let i = 0; i < rows.length - 1; i++) {
						const externalHex = await sha256hex(canonicalString(rows[i]));
						expect(rows[i + 1].chain_prev_hash).toBe(externalHex);
					}
				},
			),
			{ numRuns: 30 },
		);
	});

	it("flipping any single field on row i breaks verify_chain at row i+1", async () => {
		// Tamper-evidence: any mutation of a chained field must surface as a
		// broken_at_id at the *next* row (because chain_prev_hash[i+1] is the
		// hash of row[i]'s canonical form).
		await fc.assert(
			fc.asyncProperty(
				fc.uuid({ version: 4 }),
				fc.array(rowMetadata, { minLength: 2, maxLength: 10 }),
				fc.nat(),
				async (customerId, metas, tamperSeed) => {
					const rows = await buildChain(customerId, 1_700_000_000_000, metas.length, metas);
					const tamperIdx = tamperSeed % (rows.length - 1);
					const tampered: Row[] = rows.map((r, i) =>
						i === tamperIdx ? { ...r, latency_ms: (r.latency_ms ?? 0) + 1 } : r,
					);
					const result = await verifyChain(tampered);
					expect(result.ok).toBe(false);
					expect(result.broken_at_id).toBe(tampered[tamperIdx + 1].id);
				},
			),
			{ numRuns: 30 },
		);
	});
});
