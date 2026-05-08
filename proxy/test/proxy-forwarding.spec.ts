/**
 * T11–T13: top-level fetch handler error handling, body size limits,
 * streaming pass-through.
 *
 * Authority: docs/ailedger-test-plan.md §T11–§T13.
 *
 * Scope: each describe pins the post-fix contract for the corresponding fix
 * bead. The fixes have NOT landed yet, so the assertions are wrapped with
 * `it.fails` — they currently fail (which is the expected state), and vitest
 * will flag them as "unexpectedly passing" the moment the fix lands. That's
 * the signal for the follow-up bead to drop `.fails` and let the test run as
 * a normal regression guard.
 *
 * Off-limits per bead ai-u7j: do NOT implement the fixes here. This file is
 * tests-only.
 *
 * Pre-fix surface (proxy/src/index.ts top-level fetch handler):
 *   • No try/catch wraps `await fetch(upstreamRequest)` or
 *     `await request.arrayBuffer()` — a network blip becomes an uncaught
 *     500 with no correlation id (T11).
 *   • Request bodies are read unconditionally and upstream responses are
 *     fully buffered via `await upstreamResponse.arrayBuffer()` — no
 *     size guards on either edge (T12).
 *   • `arrayBuffer()` on the upstream response defeats SSE / chunked
 *     pass-through; customers wait for the full body before seeing the
 *     first byte (T13).
 */

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src';

// ─── Auth seeding helpers ───────────────────────────────────────────────────
//
// The forwarding path runs after resolveApiKey + checkUsageLimit. We bypass
// both by pre-seeding the AILEDGER_CACHE KV namespace so neither helper
// dispatches a Supabase fetch — the only fetches we then care about are the
// upstream provider call and the (fire-and-forget) inference_logs insert.

const FAKE_KEY = 'test_sk_t11_t13_forwarding';
const FAKE_USER = '00000000-0000-4000-8000-0000000fa11d';

async function sha256hex(input: string): Promise<string> {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

async function seedAuth(): Promise<void> {
	const keyHash = await sha256hex(FAKE_KEY);
	await env.AILEDGER_CACHE.put(`key:${keyHash}`, JSON.stringify({ supabaseUserId: FAKE_USER, systemId: null }));
	// Paid status short-circuits the inference-count query so checkUsageLimit
	// returns false without any Supabase round-trip.
	await env.AILEDGER_CACHE.put(`paid:${FAKE_USER}`, 'true');
}

// stubGlobalFetch installs a fetch stub that:
//   • routes upstream provider calls (api.openai.com etc.) to `provider(url)`,
//   • silently absorbs Supabase REST calls so logInference's waitUntil work
//     doesn't surface as unhandled rejections in test output.
function stubGlobalFetch(provider: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
	vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
		if (
			url.startsWith('https://api.openai.com') ||
			url.startsWith('https://api.anthropic.com') ||
			url.startsWith('https://generativelanguage.googleapis.com')
		) {
			return provider(url, init);
		}
		// Swallow Supabase REST traffic (logInference waitUntil insert).
		return new Response(null, { status: 200 });
	});
}

beforeEach(async () => {
	await seedAuth();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

// ─── T11: top-level fetch handler error handling ────────────────────────────

describe('T11: top-level fetch handler error handling', () => {
	it.fails('upstream fetch throws -> 502 with x-ailedger-error-id correlation header', async () => {
		stubGlobalFetch(() => {
			throw new TypeError('simulated upstream connection reset');
		});

		const req = new Request('http://example.com/proxy/openai/chat/completions', {
			method: 'POST',
			headers: {
				'x-ailedger-key': FAKE_KEY,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ model: 'gpt-4o-mini', messages: [] }),
		});
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(res.status).toBe(502);
		// Correlation id is required: ops + customer support need a single
		// token to pivot from a customer's screenshot into Logpush.
		const errorId = res.headers.get('x-ailedger-error-id');
		expect(errorId).toBeTruthy();
		expect(errorId!.length).toBeGreaterThanOrEqual(8);
	});

	it.fails('request body stream errors -> 400 with x-ailedger-error-id', async () => {
		// We never reach the upstream — but stub fetch anyway so a
		// pre-fix accidental call is observable as a fetchMock miss.
		let upstreamCalled = false;
		stubGlobalFetch(() => {
			upstreamCalled = true;
			return new Response('{}', {
				headers: { 'content-type': 'application/json' },
			});
		});

		// A ReadableStream that errors immediately models a half-closed
		// upload (e.g., customer's network died mid-POST). Pre-fix the
		// uncaught arrayBuffer() rejection becomes a 500; post-fix the
		// handler returns a structured 400.
		const errorStream = new ReadableStream({
			start(controller) {
				controller.error(new Error('simulated body stream broken'));
			},
		});

		const req = new Request('http://example.com/proxy/openai/chat/completions', {
			method: 'POST',
			headers: {
				'x-ailedger-key': FAKE_KEY,
				'content-type': 'application/json',
			},
			body: errorStream,
			// Workers Request requires duplex when body is a stream.
			duplex: 'half',
		} as RequestInit & { duplex: 'half' });
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(res.status).toBe(400);
		expect(res.headers.get('x-ailedger-error-id')).toBeTruthy();
		expect(upstreamCalled).toBe(false);
	});

	it.fails('correlation id appears in console.error log line for ops pivot', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		stubGlobalFetch(() => {
			throw new TypeError('simulated upstream connection reset');
		});

		const req = new Request('http://example.com/proxy/openai/chat/completions', {
			method: 'POST',
			headers: {
				'x-ailedger-key': FAKE_KEY,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ model: 'gpt-4o-mini', messages: [] }),
		});
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);

		const errorId = res.headers.get('x-ailedger-error-id');
		expect(errorId).toBeTruthy();
		// Post-fix: the same id is emitted to console.error so a Logpush
		// query on `ailedger_error_id == "<id>"` returns the offending log.
		const logged = errorSpy.mock.calls.flat().some((arg) => String(arg).includes(errorId!));
		expect(logged).toBe(true);

		errorSpy.mockRestore();
	});
});

// ─── T12: body size limits ──────────────────────────────────────────────────

describe('T12: body size limits', () => {
	const REQ_LIMIT_BYTES = 25 * 1024 * 1024;
	const RESP_LIMIT_BYTES = 100 * 1024 * 1024;

	it.fails('content-length > 25MB -> 413 (no body read, no upstream fetch)', async () => {
		let upstreamCalled = false;
		stubGlobalFetch(() => {
			upstreamCalled = true;
			return new Response('{}', {
				headers: { 'content-type': 'application/json' },
			});
		});

		const req = new Request('http://example.com/proxy/openai/chat/completions', {
			method: 'POST',
			headers: {
				'x-ailedger-key': FAKE_KEY,
				'content-type': 'application/json',
				// Header-only check: post-fix code must reject before reading
				// the body, so the actual body is allowed to be small.
				'content-length': String(REQ_LIMIT_BYTES + 1024),
			},
			body: JSON.stringify({ model: 'gpt-4o-mini', messages: [] }),
		});
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(res.status).toBe(413);
		expect(upstreamCalled).toBe(false);
	});

	// Plain `it` — passes pre-fix (no limit check exists) and must keep
	// passing post-fix (boundary discipline: strict `>` check, not `>=`).
	// Regression guard against an off-by-one in the limit fix.
	it('content-length exactly 25MB -> still allowed (boundary inclusive)', async () => {
		// A customer streaming an exact-25MB transcript should not get
		// rate-limited just because the limit is described as a 25MB ceiling.
		stubGlobalFetch(
			() =>
				new Response('{"ok":true}', {
					headers: { 'content-type': 'application/json' },
				}),
		);

		const req = new Request('http://example.com/proxy/openai/chat/completions', {
			method: 'POST',
			headers: {
				'x-ailedger-key': FAKE_KEY,
				'content-type': 'application/json',
				'content-length': String(REQ_LIMIT_BYTES),
			},
			body: JSON.stringify({ model: 'gpt-4o-mini', messages: [] }),
		});
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(res.status).not.toBe(413);
	});

	it.fails('upstream response > 100MB -> handler aborts cleanly (no buffering, terminal non-2xx)', async () => {
		// Provider claims a 200MB body via content-length but emits only a
		// trickle. Pre-fix: arrayBuffer() drains the whole stream,
		// allocating up to 100s-of-MB in the isolate (Workers OOM at
		// 128MB). Post-fix: handler observes the announced length and
		// aborts before allocating.
		stubGlobalFetch(
			() =>
				new Response('ignored', {
					status: 200,
					headers: {
						'content-type': 'application/json',
						'content-length': String(RESP_LIMIT_BYTES + 1),
					},
				}),
		);

		const req = new Request('http://example.com/proxy/openai/chat/completions', {
			method: 'POST',
			headers: {
				'x-ailedger-key': FAKE_KEY,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ model: 'gpt-4o-mini', messages: [] }),
		});
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);

		// The fix bead picks the exact code (502 "upstream too large" is
		// the natural choice; 413 is plausible if framed as "request too
		// large to log"). Either signals: the proxy refused to buffer the
		// payload. Tighten once the fix lands.
		expect([413, 502, 504]).toContain(res.status);
	});
});

// ─── T13: streaming pass-through (SSE) ──────────────────────────────────────

describe('T13: streaming pass-through (SSE)', () => {
	// Pre-fix proxy fully buffers the upstream body. To distinguish "buffered
	// then re-emitted" from "actually streaming", we time how long it takes
	// the first chunk to surface relative to a deliberate stall in the
	// upstream stream.
	const STALL_MS = 1000;
	const FIRST_CHUNK_BUDGET_MS = STALL_MS / 4;

	function makeStallStream(firstChunk: Uint8Array, secondChunk: Uint8Array, stallMs: number): ReadableStream<Uint8Array> {
		return new ReadableStream({
			start(controller) {
				controller.enqueue(firstChunk);
				setTimeout(() => {
					controller.enqueue(secondChunk);
					controller.close();
				}, stallMs);
			},
		});
	}

	it.fails(
		'SSE upstream chunks are forwarded as they arrive (not buffered)',
		async () => {
			const FIRST = new TextEncoder().encode('data: {"v":1}\n\n');
			const SECOND = new TextEncoder().encode('data: {"v":2}\n\n');

			stubGlobalFetch(
				() =>
					new Response(makeStallStream(FIRST, SECOND, STALL_MS), {
						status: 200,
						headers: { 'content-type': 'text/event-stream' },
					}),
			);

			const req = new Request('http://example.com/proxy/openai/chat/completions', {
				method: 'POST',
				headers: {
					'x-ailedger-key': FAKE_KEY,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					model: 'gpt-4o-mini',
					messages: [],
					stream: true,
				}),
			});
			const ctx = createExecutionContext();

			const t0 = performance.now();
			const res = await worker.fetch(req, env, ctx);
			const headersAt = performance.now() - t0;

			expect(res.status).toBe(200);
			expect(res.headers.get('content-type')).toBe('text/event-stream');
			expect(res.body).not.toBeNull();

			const reader = res.body!.getReader();
			const { value: firstValue, done } = await reader.read();
			const firstChunkAt = performance.now() - t0;

			expect(done).toBe(false);
			expect(firstValue).toBeDefined();
			// Pre-fix: ~STALL_MS (proxy buffered the full body before returning).
			// Post-fix: well under the budget — the chunk is forwarded as-is.
			expect(headersAt, `headers arrived at ${headersAt.toFixed(0)}ms (budget ${FIRST_CHUNK_BUDGET_MS}ms)`).toBeLessThan(
				FIRST_CHUNK_BUDGET_MS,
			);
			expect(firstChunkAt, `first chunk arrived at ${firstChunkAt.toFixed(0)}ms (budget ${FIRST_CHUNK_BUDGET_MS}ms)`).toBeLessThan(
				FIRST_CHUNK_BUDGET_MS,
			);

			// Drain the rest so waitUntil's logger can complete.
			while (true) {
				const r = await reader.read();
				if (r.done) break;
			}
			await waitOnExecutionContext(ctx);
		},
		STALL_MS * 4,
	);

	// Plain `it` — round-trip byte correctness already holds today (the
	// pre-fix code buffers and re-emits, which is still byte-correct). This
	// guards against a fix-bead regression where the tee()-style fork drops
	// or reorders bytes.
	it('SSE round-trip preserves payload bytes (regression guard for tee fork)', async () => {
		const SSE_PAYLOAD = 'data: {"v":1}\n\ndata: {"v":2}\n\ndata: [DONE]\n\n';
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(SSE_PAYLOAD));
				controller.close();
			},
		});

		stubGlobalFetch(
			() =>
				new Response(stream, {
					status: 200,
					headers: { 'content-type': 'text/event-stream' },
				}),
		);

		const req = new Request('http://example.com/proxy/openai/chat/completions', {
			method: 'POST',
			headers: {
				'x-ailedger-key': FAKE_KEY,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				model: 'gpt-4o-mini',
				messages: [],
				stream: true,
			}),
		});
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		const text = await res.text();
		await waitOnExecutionContext(ctx);

		expect(text).toBe(SSE_PAYLOAD);
		expect(res.headers.get('content-type')).toBe('text/event-stream');
	});

	// Plain `it` — passes pre-fix (arrayBuffer + sha256jcs path) and must
	// keep passing post-fix (tee()-fork path). This is a regression guard
	// that the streaming refactor doesn't drop hash logging on the floor.
	it('hash logging still fires for streaming response (tee-style fork)', async () => {
		// Post-fix contract: the proxy tee()s the upstream body so the
		// customer receives the original stream and logInference receives
		// an in-memory copy. We assert by counting Supabase inference_logs
		// inserts: exactly one row, with non-null output_hash, after the
		// stream finishes.
		const SSE_PAYLOAD = 'data: {"v":1}\n\ndata: [DONE]\n\n';
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(SSE_PAYLOAD));
				controller.close();
			},
		});

		let logInsertBody: string | null = null;
		vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url.startsWith('https://api.openai.com')) {
				return new Response(stream, {
					status: 200,
					headers: { 'content-type': 'text/event-stream' },
				});
			}
			if (url.includes('/rest/v1/inference_logs')) {
				logInsertBody = typeof init?.body === 'string' ? init.body : null;
			}
			return new Response(null, { status: 200 });
		});

		const req = new Request('http://example.com/proxy/openai/chat/completions', {
			method: 'POST',
			headers: {
				'x-ailedger-key': FAKE_KEY,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				model: 'gpt-4o-mini',
				messages: [],
				stream: true,
			}),
		});
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		// Drain customer-facing stream so the tee fork reaches the logger.
		await res.text();
		await waitOnExecutionContext(ctx);

		expect(logInsertBody).not.toBeNull();
		const parsed = JSON.parse(logInsertBody!) as { output_hash: string | null };
		expect(parsed.output_hash).toBeTruthy();
		expect(typeof parsed.output_hash).toBe('string');
		expect(parsed.output_hash!.length).toBe(64); // sha256 hex
	});
});
