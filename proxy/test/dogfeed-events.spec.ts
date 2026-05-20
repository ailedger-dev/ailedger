/**
 * Dogfeed sidecar receiver — POST /v1/events (ai-4vp / ADR-015).
 *
 * Mirrors the vitest workerd pattern from usage-limit.spec.ts: pre-seed the
 * api-key cache so resolveApiKey returns from KV, then stub global fetch to
 * model the Supabase REST surface. Each test uses unique tenant + event IDs
 * so KV state cannot bleed between tests.
 *
 * Bead acceptance scenarios:
 *   1. happy path (10 events accepted)
 *   2. oversized batch rejected (4xx)
 *   3. missing key rejected (401)
 *   4. duplicate event_id within window deduped
 *   5. storage failure → 5xx (client must retry)
 *   6. schema violation → per-event 4xx (other events in batch still accepted)
 */
import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ENDPOINT = 'http://example.com/v1/events';

async function sha256hex(input: string): Promise<string> {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

async function seedKey(apiKey: string, tenantId: string): Promise<void> {
	const keyHash = await sha256hex(apiKey);
	await env.AILEDGER_CACHE.put(`key:${keyHash}`, JSON.stringify({ supabaseUserId: tenantId, systemId: null }));
}

interface StubPlan {
	storageStatus?: number; // status returned by Supabase POST /rest/v1/dogfeed_events
}

function stubFetch(plan: StubPlan = {}): { calls: { url: string; body: unknown }[] } {
	const calls: { url: string; body: unknown }[] = [];
	vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
		const method = (init?.method ?? 'GET').toUpperCase();
		if (url.includes('/rest/v1/dogfeed_events') && method === 'POST') {
			let parsed: unknown = null;
			try {
				parsed = init?.body ? JSON.parse(String(init.body)) : null;
			} catch {
				/* leave null */
			}
			calls.push({ url, body: parsed });
			const status = plan.storageStatus ?? 201;
			return new Response(null, { status });
		}
		// Catch-all: empty JSON array. Covers the resolveApiKey lookup for
		// unknown keys (no cache entry → Supabase select → empty rows → null)
		// and background last_used_at PATCHes.
		return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
	});
	return { calls };
}

function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const id = (overrides.event_id as string | undefined) ?? crypto.randomUUID();
	return {
		event_id: id,
		ts: '2026-05-03T20:00:00.000Z',
		model: 'claude-opus-4-7',
		input_tokens: 100,
		output_tokens: 200,
		latency_ms: 350,
		source: 'claude-code',
		...overrides,
	};
}

async function postEvents(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return SELF.fetch(ENDPOINT, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('POST /v1/events — happy path', () => {
	it('accepts a batch of 10 valid events', async () => {
		const apiKey = 'test_sk_dogfeed_happy';
		const tenant = '00000000-0000-4000-8000-00000000df01';
		await seedKey(apiKey, tenant);
		const { calls } = stubFetch();

		const events = Array.from({ length: 10 }, () => makeEvent());
		const res = await postEvents(events, { 'x-ailedger-key': apiKey });

		expect(res.status).toBe(200);
		const body = (await res.json()) as { accepted: number; rejected: unknown[] };
		expect(body).toEqual({ accepted: 10, rejected: [] });
		expect(calls).toHaveLength(1);
		expect(Array.isArray(calls[0].body)).toBe(true);
		expect((calls[0].body as unknown[]).length).toBe(10);
	});
});

describe('POST /v1/events — auth', () => {
	it('rejects missing x-ailedger-key with 401', async () => {
		stubFetch();
		const res = await postEvents([makeEvent()]);
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/x-ailedger-key/i);
	});

	it('rejects an unknown api key with 401', async () => {
		stubFetch();
		const res = await postEvents([makeEvent()], { 'x-ailedger-key': 'test_sk_dogfeed_unknown' });
		expect(res.status).toBe(401);
	});
});

describe('POST /v1/events — oversized batch', () => {
	it('rejects a batch of 101 events with 413', async () => {
		const apiKey = 'test_sk_dogfeed_count';
		const tenant = '00000000-0000-4000-8000-00000000df02';
		await seedKey(apiKey, tenant);
		stubFetch();

		const events = Array.from({ length: 101 }, () => makeEvent());
		const res = await postEvents(events, { 'x-ailedger-key': apiKey });

		expect(res.status).toBe(413);
	});

	it('rejects a body over 256KB with 413', async () => {
		const apiKey = 'test_sk_dogfeed_bytes';
		const tenant = '00000000-0000-4000-8000-00000000df03';
		await seedKey(apiKey, tenant);
		stubFetch();

		// Build a body just over 256KB by stuffing tool_name with filler.
		const filler = 'x'.repeat(260 * 1024);
		const ev = makeEvent({ tool_name: filler });
		const res = await postEvents([ev], { 'x-ailedger-key': apiKey });

		expect(res.status).toBe(413);
	});
});

describe('POST /v1/events — idempotency', () => {
	it('dedupes duplicate event_id within the window (only one Supabase insert)', async () => {
		const apiKey = 'test_sk_dogfeed_dedup';
		const tenant = '00000000-0000-4000-8000-00000000df04';
		await seedKey(apiKey, tenant);
		const { calls } = stubFetch();

		const eventId = crypto.randomUUID();
		const ev = makeEvent({ event_id: eventId });

		const first = await postEvents([ev], { 'x-ailedger-key': apiKey });
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as { accepted: number };
		expect(firstBody.accepted).toBe(1);

		// The dedupe marker is written via ctx.waitUntil (fire-and-forget) and
		// SELF.fetch does NOT await waitUntil work before resolving, so poll
		// the KV namespace briefly until the marker lands.
		const key = `dogfeed_evt:${tenant}:${eventId}`;
		let marker: string | null = null;
		for (let i = 0; i < 50; i++) {
			marker = await env.AILEDGER_CACHE.get(key);
			if (marker === '1') break;
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(marker).toBe('1');

		const second = await postEvents([ev], { 'x-ailedger-key': apiKey });
		expect(second.status).toBe(200);
		const secondBody = (await second.json()) as { accepted: number; rejected: unknown[] };
		expect(secondBody.accepted).toBe(1);
		expect(secondBody.rejected).toEqual([]);

		// Only the first call should have made it to storage.
		expect(calls).toHaveLength(1);
		expect((calls[0].body as unknown[]).length).toBe(1);
	});
});

describe('POST /v1/events — storage failure', () => {
	it('returns 500 when Supabase insert fails so the client retries', async () => {
		const apiKey = 'test_sk_dogfeed_storage';
		const tenant = '00000000-0000-4000-8000-00000000df05';
		await seedKey(apiKey, tenant);
		stubFetch({ storageStatus: 503 });

		const res = await postEvents([makeEvent()], { 'x-ailedger-key': apiKey });
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/storage failed/i);
	});
});

describe('POST /v1/events — partial schema violation', () => {
	it('accepts good events and reports per-event reasons for bad ones', async () => {
		const apiKey = 'test_sk_dogfeed_schema';
		const tenant = '00000000-0000-4000-8000-00000000df06';
		await seedKey(apiKey, tenant);
		const { calls } = stubFetch();

		const goodA = makeEvent();
		const goodB = makeEvent();
		const badMissingModel = { ...makeEvent(), model: undefined };
		const badNegativeTokens = { ...makeEvent(), input_tokens: -5 };
		const badNonUuid = { ...makeEvent(), event_id: 'not-a-uuid' };

		const res = await postEvents([goodA, badMissingModel, goodB, badNegativeTokens, badNonUuid], { 'x-ailedger-key': apiKey });

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			accepted: number;
			rejected: { event_id: string | null; reason: string }[];
		};
		expect(body.accepted).toBe(2);
		expect(body.rejected).toHaveLength(3);
		const reasons = body.rejected.map((r) => r.reason).join('|');
		expect(reasons).toMatch(/model/);
		expect(reasons).toMatch(/input_tokens/);
		expect(reasons).toMatch(/uuid/);

		// Only the two valid events should have hit Supabase.
		expect(calls).toHaveLength(1);
		expect((calls[0].body as unknown[]).length).toBe(2);
	});
});
