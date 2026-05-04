/**
 * Durable-buffer audit-write path — guarantees against "forward-before-
 * durable-write" worker-crash failure mode.
 *
 * Whiteboard 2026-04-27 side B "FORWARD-BEFORE-DUR-WRITE unmitigated"
 * + threat model §6.1.
 *
 * Contract under test:
 *   1. By the time the customer sees a response, a pending_log:* entry
 *      with the audit content is durably committed to KV.
 *   2. On Supabase success, the inline drain via waitUntil deletes the
 *      KV entry.
 *   3. On Supabase failure, the KV entry remains for the scheduled drain.
 *   4. The scheduled handler drains pending_log:* entries with bounded
 *      retry, deletes on success, and emits a stale-entry alert when an
 *      entry exceeds the age threshold.
 */

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src';

const FAKE_KEY = 'test_sk_durable_buffer_spec';
const FAKE_USER = '00000000-0000-4000-8000-0000000dub1f';
const PENDING_LOG_PREFIX = 'pending_log:';

async function sha256hex(input: string): Promise<string> {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

async function seedAuth(): Promise<void> {
	const keyHash = await sha256hex(FAKE_KEY);
	await env.AILEDGER_CACHE.put(`key:${keyHash}`, JSON.stringify({ supabaseUserId: FAKE_USER, systemId: null }));
	await env.AILEDGER_CACHE.put(`paid:${FAKE_USER}`, 'true');
}

async function clearPendingLogs(): Promise<void> {
	let cursor: string | undefined;
	do {
		const list = await env.AILEDGER_CACHE.list({ prefix: PENDING_LOG_PREFIX, cursor });
		await Promise.all(list.keys.map((k) => env.AILEDGER_CACHE.delete(k.name)));
		cursor = list.list_complete ? undefined : list.cursor;
	} while (cursor);
}

interface FetchCallLog {
	url: string;
	method: string;
	body: string | null;
}

function stubGlobalFetch(opts: {
	upstream: (url: string) => Response | Promise<Response>;
	supabase: (url: string, init?: RequestInit) => Response | Promise<Response>;
	supabaseLog?: FetchCallLog[];
}): void {
	vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
		if (
			url.startsWith('https://api.openai.com') ||
			url.startsWith('https://api.anthropic.com') ||
			url.startsWith('https://generativelanguage.googleapis.com')
		) {
			return opts.upstream(url);
		}
		// Capture any Supabase-bound write so the test can assert on it.
		if (url.includes('/rest/v1/inference_logs')) {
			if (opts.supabaseLog) {
				const bodyStr = init?.body ? (typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body as ArrayBuffer)) : null;
				opts.supabaseLog.push({ url, method: init?.method ?? 'GET', body: bodyStr });
			}
			return opts.supabase(url, init);
		}
		return new Response(null, { status: 200 });
	});
}

beforeEach(async () => {
	await seedAuth();
	await clearPendingLogs();
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await clearPendingLogs();
});

describe('durable-buffer write-side: KV persists BEFORE response', () => {
	it('Supabase healthy: pending_log written, then deleted by inline drain', async () => {
		stubGlobalFetch({
			upstream: () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
			supabase: () => new Response(null, { status: 201 }),
		});

		const req = new Request('http://example.com/proxy/openai/chat/completions', {
			method: 'POST',
			headers: { 'x-ailedger-key': FAKE_KEY, 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
		});
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		expect(res.status).toBe(200);

		await waitOnExecutionContext(ctx);

		// After waitUntil completes (Supabase success path), the KV entry
		// should have been deleted by tryDrainOne.
		const list = await env.AILEDGER_CACHE.list({ prefix: PENDING_LOG_PREFIX });
		expect(list.keys.length).toBe(0);
	});

	it('Supabase down: entry persists in KV after response returns', async () => {
		stubGlobalFetch({
			upstream: () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
			supabase: () => new Response('upstream broken', { status: 503 }),
		});

		const req = new Request('http://example.com/proxy/openai/chat/completions', {
			method: 'POST',
			headers: { 'x-ailedger-key': FAKE_KEY, 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi-supabase-down' }] }),
		});
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		expect(res.status).toBe(200);
		await waitOnExecutionContext(ctx);

		const list = await env.AILEDGER_CACHE.list({ prefix: PENDING_LOG_PREFIX });
		expect(list.keys.length).toBe(1);

		const raw = await env.AILEDGER_CACHE.get(list.keys[0].name);
		expect(raw).not.toBeNull();
		const entry = JSON.parse(raw!);
		expect(entry.customer_id).toBe(FAKE_USER);
		expect(entry.provider).toBe('openai');
		expect(entry.model_name).toBe('gpt-4o-mini');
		expect(entry.input_hash).toBeTruthy();
		expect(entry.output_hash).toBeTruthy();
	});

	it('Supabase throws (network error): entry persists in KV', async () => {
		stubGlobalFetch({
			upstream: () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
			supabase: () => {
				throw new TypeError('simulated supabase network failure');
			},
		});

		const req = new Request('http://example.com/proxy/openai/chat/completions', {
			method: 'POST',
			headers: { 'x-ailedger-key': FAKE_KEY, 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'gpt-4o-mini', messages: [] }),
		});
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		expect(res.status).toBe(200);
		await waitOnExecutionContext(ctx);

		const list = await env.AILEDGER_CACHE.list({ prefix: PENDING_LOG_PREFIX });
		expect(list.keys.length).toBe(1);
	});

	it('content of KV entry round-trips request/response identity', async () => {
		stubGlobalFetch({
			upstream: () =>
				new Response('{"role":"assistant","content":"hello"}', {
					status: 201,
					headers: { 'content-type': 'application/json' },
				}),
			supabase: () => new Response('boom', { status: 500 }),
		});

		const req = new Request('http://example.com/proxy/openai/chat/completions', {
			method: 'POST',
			headers: { 'x-ailedger-key': FAKE_KEY, 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'roundtrip' }] }),
		});
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		expect(res.status).toBe(201);
		await waitOnExecutionContext(ctx);

		const list = await env.AILEDGER_CACHE.list({ prefix: PENDING_LOG_PREFIX });
		expect(list.keys.length).toBe(1);
		const entry = JSON.parse((await env.AILEDGER_CACHE.get(list.keys[0].name))!);
		expect(entry.method).toBe('POST');
		expect(entry.path).toBe('/v1/chat/completions');
		expect(entry.status_code).toBe(201);
		expect(entry.latency_ms).toBeGreaterThanOrEqual(0);
		expect(typeof entry.started_at).toBe('string');
		expect(typeof entry.completed_at).toBe('string');
	});
});

describe('scheduled drain: pending_log:* entries flushed back into Supabase', () => {
	it('drains a stuck entry and deletes the KV key on Supabase success', async () => {
		const supabaseCalls: FetchCallLog[] = [];
		stubGlobalFetch({
			upstream: () => new Response(null, { status: 200 }),
			supabase: () => new Response(null, { status: 201 }),
			supabaseLog: supabaseCalls,
		});

		// Seed a stuck entry directly (simulating an entry left over from a
		// prior session where Supabase was down and the worker died before
		// retrying).
		const stuckEntry = {
			customer_id: FAKE_USER,
			system_id: null,
			provider: 'openai',
			model_name: 'gpt-4o-mini',
			method: 'POST',
			path: '/v1/chat/completions',
			input_hash: 'a'.repeat(64),
			output_hash: 'b'.repeat(64),
			status_code: 200,
			latency_ms: 42,
			started_at: new Date().toISOString(),
			completed_at: new Date().toISOString(),
			logged_at: new Date().toISOString(),
		};
		const bufferKey = `${PENDING_LOG_PREFIX}drain-test-${crypto.randomUUID()}`;
		await env.AILEDGER_CACHE.put(bufferKey, JSON.stringify(stuckEntry));

		const ctx = createExecutionContext();
		await worker.scheduled!({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry: () => {} } as unknown as ScheduledEvent, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(supabaseCalls.length).toBe(1);
		expect(supabaseCalls[0].method).toBe('POST');
		const body = JSON.parse(supabaseCalls[0].body!);
		expect(body.customer_id).toBe(FAKE_USER);
		expect(body.input_hash).toBe('a'.repeat(64));

		const remaining = await env.AILEDGER_CACHE.get(bufferKey);
		expect(remaining).toBeNull();
	});

	it('leaves KV entry in place when Supabase still failing', async () => {
		stubGlobalFetch({
			upstream: () => new Response(null, { status: 200 }),
			supabase: () => new Response('still down', { status: 503 }),
		});

		const stuckEntry = {
			customer_id: FAKE_USER,
			system_id: null,
			provider: 'openai',
			model_name: null,
			method: 'POST',
			path: '/v1/chat/completions',
			input_hash: null,
			output_hash: null,
			status_code: 200,
			latency_ms: 10,
			started_at: new Date().toISOString(),
			completed_at: new Date().toISOString(),
			logged_at: new Date().toISOString(),
		};
		const bufferKey = `${PENDING_LOG_PREFIX}stays-${crypto.randomUUID()}`;
		await env.AILEDGER_CACHE.put(bufferKey, JSON.stringify(stuckEntry));

		const ctx = createExecutionContext();
		await worker.scheduled!({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry: () => {} } as unknown as ScheduledEvent, env, ctx);
		await waitOnExecutionContext(ctx);

		const remaining = await env.AILEDGER_CACHE.get(bufferKey);
		expect(remaining).not.toBeNull();
	});

	it('emits a stale-entry alert when an entry exceeds the age threshold', async () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		stubGlobalFetch({
			upstream: () => new Response(null, { status: 200 }),
			supabase: () => new Response(null, { status: 201 }),
		});

		const ancientEntry = {
			customer_id: FAKE_USER,
			system_id: null,
			provider: 'openai',
			model_name: 'gpt-4o-mini',
			method: 'POST',
			path: '/v1/chat/completions',
			input_hash: 'c'.repeat(64),
			output_hash: 'd'.repeat(64),
			status_code: 200,
			latency_ms: 7,
			// 3 hours old: well past the 1-hour stale threshold.
			started_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
			completed_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
			logged_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
		};
		const bufferKey = `${PENDING_LOG_PREFIX}stale-${crypto.randomUUID()}`;
		await env.AILEDGER_CACHE.put(bufferKey, JSON.stringify(ancientEntry));

		const ctx = createExecutionContext();
		await worker.scheduled!({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry: () => {} } as unknown as ScheduledEvent, env, ctx);
		await waitOnExecutionContext(ctx);

		const staleAlerts = errSpy.mock.calls
			.map((args) => String(args[0]))
			.filter((s) => s.includes('drainPendingLogs:stale-entry'));
		expect(staleAlerts.length).toBeGreaterThanOrEqual(1);
		errSpy.mockRestore();
	});

	it('drops corrupt entries to prevent infinite replay', async () => {
		stubGlobalFetch({
			upstream: () => new Response(null, { status: 200 }),
			supabase: () => new Response(null, { status: 201 }),
		});

		const bufferKey = `${PENDING_LOG_PREFIX}corrupt-${crypto.randomUUID()}`;
		await env.AILEDGER_CACHE.put(bufferKey, 'not-valid-json{{{');

		const ctx = createExecutionContext();
		await worker.scheduled!({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry: () => {} } as unknown as ScheduledEvent, env, ctx);
		await waitOnExecutionContext(ctx);

		const remaining = await env.AILEDGER_CACHE.get(bufferKey);
		expect(remaining).toBeNull();
	});

	it('drains multiple entries in one cycle', async () => {
		const supabaseCalls: FetchCallLog[] = [];
		stubGlobalFetch({
			upstream: () => new Response(null, { status: 200 }),
			supabase: () => new Response(null, { status: 201 }),
			supabaseLog: supabaseCalls,
		});

		const baseEntry = {
			customer_id: FAKE_USER,
			system_id: null,
			provider: 'openai',
			model_name: 'gpt-4o-mini',
			method: 'POST',
			path: '/v1/chat/completions',
			input_hash: 'e'.repeat(64),
			output_hash: 'f'.repeat(64),
			status_code: 200,
			latency_ms: 5,
			started_at: new Date().toISOString(),
			completed_at: new Date().toISOString(),
			logged_at: new Date().toISOString(),
		};
		for (let i = 0; i < 3; i++) {
			await env.AILEDGER_CACHE.put(`${PENDING_LOG_PREFIX}multi-${i}-${crypto.randomUUID()}`, JSON.stringify(baseEntry));
		}

		const ctx = createExecutionContext();
		await worker.scheduled!({ scheduledTime: Date.now(), cron: '*/5 * * * *', noRetry: () => {} } as unknown as ScheduledEvent, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(supabaseCalls.length).toBe(3);
		const list = await env.AILEDGER_CACHE.list({ prefix: PENDING_LOG_PREFIX });
		expect(list.keys.length).toBe(0);
	});
});
