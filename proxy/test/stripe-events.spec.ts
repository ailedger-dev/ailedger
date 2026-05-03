/**
 * T6 + T8: Stripe webhook event dispatch (processStripeEvent) and the
 * post-cancellation cache invalidation contract.
 *
 * Authority: docs/ailedger-test-plan.md §T6, §T8; convoy correctness M2.
 *
 * Bead ai-wd8: tests-only; do NOT fix cache-invalidation-on-cancel here.
 * The cancellation-cache test is wrapped with `.fails` because today's
 * processStripeEvent (proxy/src/index.ts ~L430) calls upsertSubscription
 * but does NOT delete the `paid:${supabaseUserId}` KV entry. Result:
 * a customer who cancels still gets free-tier-bypass for up to 5 minutes
 * (the cache TTL) — this is convoy correctness M2.  The follow-up bead
 * will land the cache-bust and drop `.fails`.
 *
 * Strategy: drive processStripeEvent through the public webhook endpoint
 * (matches the existing webhook-stripe.spec.ts approach — keeps the seam
 * at the verified-event boundary). Stub global fetch so the Supabase
 * upsert is observable without a real DB.
 */

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src';

const SECRET = 'whsec_test_secret_for_T6';
const TEST_ENV = { ...env, STRIPE_WEBHOOK_SECRET: SECRET } as typeof env;

async function hmacHex(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	return Array.from(new Uint8Array(mac))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

async function postWebhook(payload: unknown): Promise<Response> {
	const body = JSON.stringify(payload);
	const ts = Math.floor(Date.now() / 1000);
	const sig = await hmacHex(SECRET, `${ts}.${body}`);
	const request = new Request<unknown, IncomingRequestCfProperties>('http://example.com/webhook/stripe', {
		method: 'POST',
		body,
		headers: {
			'Content-Type': 'application/json',
			'stripe-signature': `t=${ts},v1=${sig}`,
		},
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, TEST_ENV, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

interface CapturedFetch {
	url: string;
	method: string;
	body: string | null;
}

function urlOf(input: RequestInfo | URL): string {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.toString();
	return (input as Request).url;
}

// stubFetch routes all outbound fetches into `captured`. Supabase upserts
// reply 201 (PostgREST default for resolution=merge-duplicates,return=minimal);
// every other URL gets a benign 200 so unrelated background work in the
// worker does not leak into assertions.
function stubFetch(captured: CapturedFetch[], supabaseStatus = 201): void {
	vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = urlOf(input);
		const method = (init?.method ?? 'GET').toUpperCase();
		const body = typeof init?.body === 'string' ? init.body : null;
		if (url.includes('/rest/v1/subscriptions')) {
			captured.push({ url, method, body });
			return new Response(supabaseStatus >= 400 ? 'upstream error' : null, {
				status: supabaseStatus,
			});
		}
		return new Response(null, { status: 200 });
	});
}

beforeEach(() => {
	// Ensure no leakage between tests for the cache-invalidation assertion.
	// Each test that writes to AILEDGER_CACHE uses a unique user id.
});

afterEach(() => {
	vi.unstubAllGlobals();
});

// ─── T6: processStripeEvent dispatch ────────────────────────────────────────

describe('T6: processStripeEvent dispatch', () => {
	it("checkout.session.completed → upserts subscription with status='active'", async () => {
		const captured: CapturedFetch[] = [];
		stubFetch(captured);

		const res = await postWebhook({
			id: 'evt_t6_checkout',
			type: 'checkout.session.completed',
			data: {
				object: {
					customer: 'cus_t6_a',
					subscription: 'sub_t6_a',
					metadata: {
						supabase_user_id: '00000000-0000-4000-8000-00000000a001',
						plan: 'pro',
					},
				},
			},
		});

		expect(res.status).toBe(200);
		expect(captured).toHaveLength(1);
		expect(captured[0].method).toBe('POST');
		const payload = JSON.parse(captured[0].body!) as Record<string, unknown>;
		expect(payload).toMatchObject({
			stripe_customer_id: 'cus_t6_a',
			stripe_subscription_id: 'sub_t6_a',
			status: 'active',
			supabase_user_id: '00000000-0000-4000-8000-00000000a001',
			plan: 'pro',
		});
	});

	it('customer.subscription.updated → upserts with status copied from event', async () => {
		const captured: CapturedFetch[] = [];
		stubFetch(captured);

		const res = await postWebhook({
			id: 'evt_t6_updated',
			type: 'customer.subscription.updated',
			data: {
				object: {
					id: 'sub_t6_b',
					customer: 'cus_t6_b',
					status: 'past_due',
					metadata: {
						supabase_user_id: '00000000-0000-4000-8000-00000000b001',
						plan: 'pro',
					},
				},
			},
		});

		expect(res.status).toBe(200);
		expect(captured).toHaveLength(1);
		const payload = JSON.parse(captured[0].body!) as Record<string, unknown>;
		expect(payload).toMatchObject({
			stripe_customer_id: 'cus_t6_b',
			stripe_subscription_id: 'sub_t6_b',
			status: 'past_due',
		});
	});

	it("customer.subscription.deleted → upserts with status='canceled'", async () => {
		const captured: CapturedFetch[] = [];
		stubFetch(captured);

		const res = await postWebhook({
			id: 'evt_t6_deleted',
			type: 'customer.subscription.deleted',
			data: {
				object: {
					id: 'sub_t6_c',
					customer: 'cus_t6_c',
					metadata: {
						supabase_user_id: '00000000-0000-4000-8000-00000000c001',
					},
				},
			},
		});

		expect(res.status).toBe(200);
		expect(captured).toHaveLength(1);
		const payload = JSON.parse(captured[0].body!) as Record<string, unknown>;
		expect(payload).toMatchObject({
			stripe_customer_id: 'cus_t6_c',
			stripe_subscription_id: 'sub_t6_c',
			status: 'canceled',
		});
	});

	it('unknown event type → silent no-op (200, no Supabase upsert)', async () => {
		const captured: CapturedFetch[] = [];
		stubFetch(captured);

		const res = await postWebhook({
			id: 'evt_t6_unknown',
			type: 'invoice.payment_succeeded',
			data: { object: { id: 'in_t6_x', customer: 'cus_t6_x' } },
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ received: true });
		expect(captured).toHaveLength(0);
	});

	it('checkout.session.completed missing customer → graceful no-upsert', async () => {
		const captured: CapturedFetch[] = [];
		stubFetch(captured);

		const res = await postWebhook({
			id: 'evt_t6_no_customer',
			type: 'checkout.session.completed',
			data: {
				object: {
					customer: null,
					subscription: 'sub_t6_d',
					metadata: { supabase_user_id: '00000000-0000-4000-8000-00000000d001' },
				},
			},
		});

		expect(res.status).toBe(200);
		expect(captured).toHaveLength(0);
	});

	it('customer.subscription.updated missing subscription id → graceful no-upsert', async () => {
		const captured: CapturedFetch[] = [];
		stubFetch(captured);

		const res = await postWebhook({
			id: 'evt_t6_no_sub',
			type: 'customer.subscription.updated',
			data: {
				object: {
					id: null,
					customer: 'cus_t6_e',
					status: 'active',
				},
			},
		});

		expect(res.status).toBe(200);
		expect(captured).toHaveLength(0);
	});
});

// ─── T8: cancellation cache invalidation (FAILS today — drives M2 fix) ──────

describe('T8: customer.subscription.deleted invalidates paid:* KV cache', () => {
	it.fails('after cancellation webhook, paid:${supabaseUserId} KV key MUST be deleted', async () => {
		const supabaseUserId = '00000000-0000-4000-8000-00000000d8e8';
		const cacheKey = `paid:${supabaseUserId}`;

		// Seed the cache as if checkUsageLimit had cached a paid status
		// for this user during their active subscription.
		await env.AILEDGER_CACHE.put(cacheKey, 'true');
		expect(await env.AILEDGER_CACHE.get(cacheKey)).toBe('true');

		const captured: CapturedFetch[] = [];
		stubFetch(captured);

		const res = await postWebhook({
			id: 'evt_t8_cancel',
			type: 'customer.subscription.deleted',
			data: {
				object: {
					id: 'sub_t8_cancel',
					customer: 'cus_t8_cancel',
					metadata: { supabase_user_id: supabaseUserId },
				},
			},
		});

		// Webhook still has to be acknowledged (Supabase upsert ran).
		expect(res.status).toBe(200);
		expect(captured).toHaveLength(1);

		// THE INVARIANT: the cached "paid: true" verdict must NOT survive
		// the cancellation event. Today this fails — processStripeEvent
		// doesn't bust the cache, so a cancelled customer keeps free-tier
		// bypass for the remaining cache TTL (up to 5 minutes). That's
		// convoy correctness M2.
		expect(await env.AILEDGER_CACHE.get(cacheKey)).toBeNull();
	});
});
