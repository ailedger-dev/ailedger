/**
 * T9 — KV cache invalidation on key revocation.
 *
 * Authority: docs/ailedger-test-plan.md §T9; threat model §6.3 (tombstone
 * pattern); convoy security M4.
 *
 * Failure today: resolveApiKey() consults the AILEDGER_CACHE KV namespace
 * before Supabase (proxy/src/index.ts ~L546). When the operator revokes a key
 * by deleting the row in ledger.api_keys, the KV entry persists for up to its
 * 5-minute TTL, so resolveApiKey keeps returning the *old* mapping and the
 * proxy keeps authorizing requests with a revoked key. There is no
 * invalidation hook, no tombstone, no version probe.
 *
 * This spec encodes the desired post-fix invariant: after revocation, the
 * very next resolveApiKey() call MUST return null even when the KV cache is
 * pre-populated with the pre-revocation mapping. Today the assertion fails;
 * the fix described in threat model §6.3 will make it pass.
 *
 * Each `it` is wrapped with `.fails` so the suite stays green while the bug
 * is documented in code. When the tombstone fix lands and the assertion
 * starts succeeding, vitest will flag `.fails` as failing — that is the
 * signal for the follow-up bead to drop `.fails` and let the test run as a
 * normal regression guard.
 *
 * Off-limits per bead ai-6kp: do NOT implement the tombstone fix here.
 */

import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	fetchMock,
} from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { resolveApiKey } from "../src";

async function sha256hex(input: string): Promise<string> {
	const buf = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(input),
	);
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => {
	// Don't assert pending interceptors — today's cache-hit path skips the
	// Supabase fetch entirely, so the revocation interceptor is never
	// consumed. Once the tombstone fix lands and the cache hit triggers a
	// DB recheck, this can be tightened.
	fetchMock.assertNoPendingInterceptors = (() => {}) as typeof fetchMock.assertNoPendingInterceptors;
});

describe("T9: KV cache invalidation on api_keys revocation", () => {
	it.fails("returns null after revocation even when KV holds the pre-revocation mapping", async () => {
		const apiKey = "test_sk_t9_revocation_probe";
		const keyHash = await sha256hex(apiKey);
		const cacheKey = `key:${keyHash}`;

		// Stage 1 — key exists. Some prior request resolved it and seeded
		// the KV cache with the live mapping (the same shape resolveApiKey
		// writes on a DB hit; see proxy/src/index.ts ~L564).
		const preRevocationMapping = {
			supabaseUserId: "00000000-0000-4000-8000-00000000beef",
			systemId: null,
		};
		await env.AILEDGER_CACHE.put(
			cacheKey,
			JSON.stringify(preRevocationMapping),
		);

		// Stage 2 — operator revokes the key in the database. We model the
		// "direct DB call" by intercepting the PostgREST request that
		// resolveApiKey would make on a cache miss and returning [] (the
		// row no longer exists / no longer matches). Today this interceptor
		// is unused because the cache short-circuits the DB lookup; once
		// the tombstone/version fix lands, the lookup will fire and this
		// stub becomes load-bearing.
		const supabaseOrigin = (env.SUPABASE_URL ?? "https://supabase.test").replace(
			/\/$/,
			"",
		);
		fetchMock
			.get(supabaseOrigin)
			.intercept({
				method: "GET",
				path: `/rest/v1/api_keys?key_hash=eq.${keyHash}&select=customer_id,system_id`,
			})
			.reply(200, [], { headers: { "content-type": "application/json" } })
			.persist();

		// Stage 3 — caller hits the proxy again. The KV cache still holds
		// the pre-revocation mapping; the database is the source of truth
		// and now disagrees. The cache MUST defer to the database.
		const ctx = createExecutionContext();
		const result = await resolveApiKey(env, apiKey, ctx);
		await waitOnExecutionContext(ctx);

		expect(result).toBeNull();
	});

	it.fails("does not authorize a revoked key on the very next request (no TTL grace window)", async () => {
		// Same scenario but framed as the security invariant: revocation
		// must take effect immediately. A 5-minute grace window during
		// which a stolen-and-revoked key still works is not acceptable for
		// EU AI Act audit-grade guarantees (threat model §6.3).
		const apiKey = "test_sk_t9_no_grace_window";
		const keyHash = await sha256hex(apiKey);
		const cacheKey = `key:${keyHash}`;

		await env.AILEDGER_CACHE.put(
			cacheKey,
			JSON.stringify({
				supabaseUserId: "11111111-1111-4111-8111-111111111111",
				systemId: "22222222-2222-4222-8222-222222222222",
			}),
		);

		const supabaseOrigin = (env.SUPABASE_URL ?? "https://supabase.test").replace(
			/\/$/,
			"",
		);
		fetchMock
			.get(supabaseOrigin)
			.intercept({
				method: "GET",
				path: `/rest/v1/api_keys?key_hash=eq.${keyHash}&select=customer_id,system_id`,
			})
			.reply(200, [], { headers: { "content-type": "application/json" } })
			.persist();

		const ctx = createExecutionContext();
		const result = await resolveApiKey(env, apiKey, ctx);
		await waitOnExecutionContext(ctx);

		// resolveApiKey → null is the contract the proxy's auth gate
		// (proxy/src/index.ts ~L91) relies on to emit 401 Invalid API key.
		expect(result).toBeNull();
	});
});
