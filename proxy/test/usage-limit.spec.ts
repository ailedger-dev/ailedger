/**
 * T7: checkUsageLimit — paid/trialing bypass, free-tier 10k cap, fail-open
 * behavior on Supabase outages.
 *
 * Authority: docs/ailedger-test-plan.md §T7; convoy correctness M1.
 *
 * Bead ai-wd8: tests-only; do NOT modify checkUsageLimit logic here.
 *
 * Strategy: drive checkUsageLimit through the public /proxy/<provider>
 * surface. limitHit=true surfaces as HTTP 429 (proxy/src/index.ts ~L101),
 * limitHit=false lets the request flow to upstream which we stub for a
 * benign 200. Stubbing global fetch lets us model Supabase responses
 * without a real DB.
 *
 * Auth path is shortcut by pre-seeding `key:${keyHash}` in AILEDGER_CACHE
 * — resolveApiKey returns from cache and never hits Supabase, so the only
 * Supabase calls in the trace are checkUsageLimit's own.
 *
 * Notes on the trialing-status case:
 *   The original bead description ("trialing→false (FAILS today — drives
 *   correctness M1 fix)") was authored before commit 12d79c7 landed the
 *   M1 fix. The test now stands as a regression guard: trialing users
 *   keep paid-tier bypass.
 *
 * Notes on the past_due case:
 *   per the policy comment in checkUsageLimit, past_due is intentionally
 *   excluded from the active-set so the grace period flips to free-tier
 *   counting (and eventually limit-hit) — this surfaces payment failure
 *   to the customer rather than silently extending paid service. The
 *   test below documents that decision.
 *
 * Notes on the Supabase-5xx case:
 *   The handler fails OPEN (returns false / no limit). This is the
 *   currently-shipped behavior and is a known cost-amp risk: a Supabase
 *   outage can be exploited to skip quota enforcement. The test pins the
 *   current behavior so any change to fail-closed becomes a deliberate,
 *   diff-visible decision.
 */

import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const PROXY_URL = 'http://example.com/proxy/openai/v1/chat/completions';

async function sha256hex(input: string): Promise<string> {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

interface SeedOptions {
	apiKey: string;
	supabaseUserId: string;
}

async function seedKey({ apiKey, supabaseUserId }: SeedOptions): Promise<void> {
	const keyHash = await sha256hex(apiKey);
	await env.AILEDGER_CACHE.put(`key:${keyHash}`, JSON.stringify({ supabaseUserId, systemId: null }));
}

interface UsageLimitFetchPlan {
	// Response for GET /rest/v1/subscriptions?supabase_user_id=eq...
	paidStatus: { ok: true; subs: Array<{ status: string; plan: string }> } | { ok: false; status: number };
	// Response for GET /rest/v1/inference_logs?... (Range header drives count).
	// Only consulted on the free-tier path; ignored when paidStatus has an
	// active|trialing match.
	freeCount?: { ok: true; count: number } | { ok: false; status: number };
}

function stubGlobalFetchForUsage(plan: UsageLimitFetchPlan): void {
	vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
		const method = (init?.method ?? 'GET').toUpperCase();

		// Paid-status probe — first Supabase call in checkUsageLimit.
		if (url.includes('/rest/v1/subscriptions') && method === 'GET') {
			if (plan.paidStatus.ok) {
				return new Response(JSON.stringify(plan.paidStatus.subs), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			return new Response('simulated supabase error', {
				status: plan.paidStatus.status,
			});
		}

		// Free-tier inference count — second Supabase call (only on miss).
		if (url.includes('/rest/v1/inference_logs') && method === 'GET') {
			const fc = plan.freeCount;
			if (!fc) {
				// Unconfigured: behave as zero rows so tests that don't set it
				// don't accidentally trip the cap.
				return new Response('[]', {
					status: 200,
					headers: {
						'content-type': 'application/json',
						'content-range': '0-0/0',
					},
				});
			}
			if (fc.ok) {
				return new Response('[]', {
					status: 200,
					headers: {
						'content-type': 'application/json',
						'content-range': `0-0/${fc.count}`,
					},
				});
			}
			return new Response('simulated supabase error', { status: fc.status });
		}

		// Upstream provider call (proxy forwarding) and the fire-and-forget
		// inference_logs INSERT done by logInference's waitUntil.
		if (
			url.startsWith('https://api.openai.com') ||
			url.startsWith('https://api.anthropic.com') ||
			url.startsWith('https://generativelanguage.googleapis.com')
		) {
			return new Response(JSON.stringify({ choices: [] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}

		// Swallow everything else (PATCH last_used_at, inference_logs INSERT,
		// usage_limit_degraded breaker, etc.) so background work doesn't
		// surface as unhandled rejections in test output.
		return new Response(null, { status: 200 });
	});
}

async function callProxy(apiKey: string): Promise<Response> {
	const req = new Request(PROXY_URL, {
		method: 'POST',
		headers: {
			'x-ailedger-key': apiKey,
			'content-type': 'application/json',
		},
		body: JSON.stringify({ model: 'gpt-4o-mini', messages: [] }),
	});
	// Use SELF for the integration-style path so logInference's
	// waitUntil work is allowed to settle without yanking the executionContext.
	const { SELF } = await import('cloudflare:test');
	return SELF.fetch(req);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

// Each test uses a unique user id so KV state doesn't bleed across tests.

describe('T7: checkUsageLimit — paid-tier bypass', () => {
	it('active subscription → no limit (request reaches upstream)', async () => {
		const apiKey = 'agl_sk_t7_active';
		const supabaseUserId = '00000000-0000-4000-8000-00000000a7e1';
		await seedKey({ apiKey, supabaseUserId });
		stubGlobalFetchForUsage({
			paidStatus: { ok: true, subs: [{ status: 'active', plan: 'pro' }] },
		});

		const res = await callProxy(apiKey);
		expect(res.status).toBe(200);
	});

	it('trialing subscription → no limit (regression guard for M1 fix in 12d79c7)', async () => {
		const apiKey = 'agl_sk_t7_trialing';
		const supabaseUserId = '00000000-0000-4000-8000-00000000a7e2';
		await seedKey({ apiKey, supabaseUserId });
		stubGlobalFetchForUsage({
			paidStatus: { ok: true, subs: [{ status: 'trialing', plan: 'pro' }] },
		});

		const res = await callProxy(apiKey);
		expect(res.status).toBe(200);
	});
});

describe('T7: checkUsageLimit — past_due policy (documented decision)', () => {
	it('past_due subscription with under-10k usage → no limit (free-tier counting kicks in until count cap is hit)', async () => {
		// Documents the policy comment in checkUsageLimit: past_due is
		// intentionally excluded from the active-set so the grace period
		// flips to free-tier counting. With count < 10k, the customer keeps
		// service; once they cross 10k the next test path takes over and
		// they get a 429, which surfaces the payment failure.
		const apiKey = 'agl_sk_t7_past_due';
		const supabaseUserId = '00000000-0000-4000-8000-00000000a7e3';
		await seedKey({ apiKey, supabaseUserId });
		stubGlobalFetchForUsage({
			paidStatus: { ok: true, subs: [{ status: 'past_due', plan: 'pro' }] },
			freeCount: { ok: true, count: 3 },
		});

		const res = await callProxy(apiKey);
		expect(res.status).toBe(200);
	});
});

describe('T7: checkUsageLimit — free-tier 10k cap', () => {
	it('free user with usage < 10k → no limit', async () => {
		const apiKey = 'agl_sk_t7_free_under';
		const supabaseUserId = '00000000-0000-4000-8000-00000000a7e4';
		await seedKey({ apiKey, supabaseUserId });
		stubGlobalFetchForUsage({
			paidStatus: { ok: true, subs: [] },
			freeCount: { ok: true, count: 9_999 },
		});

		const res = await callProxy(apiKey);
		expect(res.status).toBe(200);
	});

	it('free user with usage ≥ 10k → 429 limit hit', async () => {
		const apiKey = 'agl_sk_t7_free_at';
		const supabaseUserId = '00000000-0000-4000-8000-00000000a7e5';
		await seedKey({ apiKey, supabaseUserId });
		stubGlobalFetchForUsage({
			paidStatus: { ok: true, subs: [] },
			freeCount: { ok: true, count: 10_000 },
		});

		const res = await callProxy(apiKey);
		expect(res.status).toBe(429);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toMatch(/limit reached/i);
	});

	it('free user with usage well over 10k → 429 limit hit', async () => {
		const apiKey = 'agl_sk_t7_free_over';
		const supabaseUserId = '00000000-0000-4000-8000-00000000a7e6';
		await seedKey({ apiKey, supabaseUserId });
		stubGlobalFetchForUsage({
			paidStatus: { ok: true, subs: [] },
			freeCount: { ok: true, count: 25_000 },
		});

		const res = await callProxy(apiKey);
		expect(res.status).toBe(429);
	});
});

describe('T7: checkUsageLimit — Supabase outage fail-open (cost-amp risk)', () => {
	it('paid-status query 503 + count query 503 → fail open (200) — known cost-amp risk', async () => {
		// Pins the currently-shipped fail-open behavior. If a future bead
		// flips this to fail-closed (return true on Supabase outage), this
		// assertion will start failing on purpose — that's the signal to
		// re-baseline the test alongside the policy change.
		const apiKey = 'agl_sk_t7_supa_5xx';
		const supabaseUserId = '00000000-0000-4000-8000-00000000a7e7';
		await seedKey({ apiKey, supabaseUserId });
		stubGlobalFetchForUsage({
			paidStatus: { ok: false, status: 503 },
			freeCount: { ok: false, status: 503 },
		});

		const res = await callProxy(apiKey);
		expect(res.status).toBe(200);
	});

	it('paid-status query 503 + count query 200 with low count → fail open (200)', async () => {
		const apiKey = 'agl_sk_t7_supa_paid_5xx';
		const supabaseUserId = '00000000-0000-4000-8000-00000000a7e8';
		await seedKey({ apiKey, supabaseUserId });
		stubGlobalFetchForUsage({
			paidStatus: { ok: false, status: 503 },
			freeCount: { ok: true, count: 5 },
		});

		const res = await callProxy(apiKey);
		expect(res.status).toBe(200);
	});
});

beforeEach(() => {
	// no-op; left for symmetry / future fixture work.
});
