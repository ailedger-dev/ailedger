import { describe, it, expect } from "vitest";
import { filterHeaders, sha256jcs } from "../src";

// ─── T14: performance regression baseline ───────────────────────────────────
//
// Authority: docs/ailedger-test-plan.md §T14.
//
// Loose bounds, not absolute — these are guards against the regressions
// guzzle's performance leg flagged. A failure here means a hot path got
// asymptotically worse, not that the worker missed an SLO. Bounds are
// generous to absorb CI noise; tighten only if proven stable.
//
// Scope notes:
//   • #1 ("single inference, stubbed upstream") measures the CPU-bound work
//     the worker does per inference — apiKey hash, header filter, request
//     and response JCS hashes.  The upstream fetch and Supabase round-trips
//     are excluded by construction (we never call them).  Anything end-to-end
//     dominated by network I/O isn't a CPU regression and isn't this test's
//     job to catch.
//   • #2 (filterHeaders) catches the O(H × D) regression where each dropped
//     header was scanned against the full drop-list inside a non-trivial loop.
//   • #3 (HMAC verify with cached key) catches re-import regressions in the
//     primitive: the verifyStripeSignature / verifyStandardWebhook helpers
//     re-import per-call today, but if either is refactored to memoize the
//     key, the steady-state cost per verification must stay under this bound.
//
// CI noise floor: vitest-workers pool runs on a single isolate; perf is
// reproducible enough for asymptotic checks but not for absolute SLOs. If a
// run flakes, raise the bound rather than retry.

function toAB(s: string): ArrayBuffer {
	const u8 = new TextEncoder().encode(s);
	const ab = new ArrayBuffer(u8.byteLength);
	new Uint8Array(ab).set(u8);
	return ab;
}

async function sha256hex(input: string | Uint8Array): Promise<string> {
	const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
	const h = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(h))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// Median-of-N: drops single-shot warmup and GC outliers without inflating the
// bound across the board.  Reports the median for the assertion and includes
// max in the failure message so a real regression is attributable.
async function medianMs(runs: number, fn: () => Promise<unknown> | unknown): Promise<{ median: number; max: number }> {
	// Warmup: JIT + caches.
	for (let i = 0; i < 3; i++) await fn();
	const samples: number[] = [];
	for (let i = 0; i < runs; i++) {
		const t0 = performance.now();
		await fn();
		samples.push(performance.now() - t0);
	}
	samples.sort((a, b) => a - b);
	return {
		median: samples[Math.floor(samples.length / 2)],
		max: samples[samples.length - 1],
	};
}

// ─── #1: single inference hot path, stubbed upstream ────────────────────────

describe("T14.1: single inference hot-path CPU < 50ms (stubbed upstream)", () => {
	it("apiKey hash + filterHeaders + request/response JCS hashes complete under 50ms", async () => {
		const apiKey = "agl_sk_" + "a".repeat(32);
		const reqBody = JSON.stringify({
			model: "gpt-4o-mini",
			messages: [
				{ role: "system", content: "You are a helpful assistant." },
				{ role: "user", content: "Hello, can you summarize this paragraph?" },
			],
			temperature: 0.7,
			max_tokens: 256,
		});
		const respBody = JSON.stringify({
			id: "chatcmpl-abc123",
			object: "chat.completion",
			created: 1_700_000_000,
			model: "gpt-4o-mini-2024-07-18",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "Sure — here is a summary..." },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 42, completion_tokens: 18, total_tokens: 60 },
		});

		// Realistic header set the worker actually filters in production.
		const headers = new Headers({
			host: "ailedger.dev",
			"cf-connecting-ip": "203.0.113.7",
			"cf-ray": "8a1b2c3d4e5f6789",
			"x-forwarded-for": "203.0.113.7",
			"x-ailedger-key": apiKey,
			"user-agent": "OpenAI/Python 1.40.0",
			"x-stainless-lang": "python",
			"x-stainless-package-version": "1.40.0",
			"x-stainless-runtime": "CPython",
			"x-stainless-runtime-version": "3.11.4",
			"x-stainless-os": "Linux",
			"x-stainless-arch": "x64",
			"content-type": "application/json",
			authorization: "Bearer sk-real-openai-key",
			accept: "application/json",
		});
		const drop = [
			"host",
			"cf-connecting-ip",
			"cf-ray",
			"x-forwarded-for",
			"x-ailedger-key",
			"user-agent",
			"x-stainless-lang",
			"x-stainless-package-version",
			"x-stainless-runtime",
			"x-stainless-runtime-version",
			"x-stainless-os",
			"x-stainless-arch",
		];

		const { median, max } = await medianMs(11, async () => {
			// Mirrors the CPU-bound steps in worker.fetch for the proxy path.
			await sha256hex(apiKey);
			filterHeaders(headers, drop);
			await sha256jcs(toAB(reqBody), "application/json");
			await sha256jcs(toAB(respBody), "application/json");
		});

		expect(median, `median ${median.toFixed(2)}ms / max ${max.toFixed(2)}ms`).toBeLessThan(50);
	});
});

// ─── #2: filterHeaders with 30 input headers ────────────────────────────────

describe("T14.2: filterHeaders (30 headers) < 1ms", () => {
	it("filters 30 headers under 1ms median", () => {
		const headers = new Headers();
		for (let i = 0; i < 30; i++) headers.set(`x-test-header-${i}`, `value-${i}`);
		// Plus the production drop-list candidates so the path is fully exercised.
		headers.set("host", "ailedger.dev");
		headers.set("user-agent", "ua");
		headers.set("x-stainless-lang", "python");
		const drop = [
			"host",
			"cf-connecting-ip",
			"cf-ray",
			"x-forwarded-for",
			"x-ailedger-key",
			"user-agent",
			"x-stainless-lang",
			"x-stainless-package-version",
			"x-stainless-runtime",
			"x-stainless-runtime-version",
			"x-stainless-os",
			"x-stainless-arch",
		];

		// Synchronous wrapper around medianMs.
		const samples: number[] = [];
		for (let i = 0; i < 3; i++) filterHeaders(headers, drop);
		for (let i = 0; i < 21; i++) {
			const t0 = performance.now();
			filterHeaders(headers, drop);
			samples.push(performance.now() - t0);
		}
		samples.sort((a, b) => a - b);
		const median = samples[Math.floor(samples.length / 2)];
		const max = samples[samples.length - 1];
		expect(median, `median ${median.toFixed(3)}ms / max ${max.toFixed(3)}ms`).toBeLessThan(1);
	});
});

// ─── #3: HMAC verification with cached key ──────────────────────────────────

describe("T14.3: HMAC verify with cached key < 0.5ms", () => {
	it("sign + hex-compare under 0.5ms median when key is pre-imported", async () => {
		// Simulate a Stripe-style signed payload: timestamp + body.
		const secret = "whsec_" + "k".repeat(32);
		const payload = JSON.stringify({
			id: "evt_test",
			type: "checkout.session.completed",
			data: { object: { id: "cs_test", customer: "cus_test" } },
		});
		const signed = `${Math.floor(Date.now() / 1000)}.${payload}`;

		// Pre-import once — this is the "cached key" precondition.
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const signedBytes = new TextEncoder().encode(signed);
		// Pre-compute expected MAC for the constant-time-ish hex compare.
		const expected = await crypto.subtle.sign("HMAC", key, signedBytes);
		const expectedHex = Array.from(new Uint8Array(expected))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");

		const { median, max } = await medianMs(21, async () => {
			const mac = await crypto.subtle.sign("HMAC", key, signedBytes);
			const computed = Array.from(new Uint8Array(mac))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
			if (computed !== expectedHex) throw new Error("mac mismatch");
		});

		expect(median, `median ${median.toFixed(3)}ms / max ${max.toFixed(3)}ms`).toBeLessThan(0.5);
	});
});
