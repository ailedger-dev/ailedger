import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

const SECRET = "whsec_test_secret_for_T1";

const TEST_ENV = { ...env, STRIPE_WEBHOOK_SECRET: SECRET } as typeof env;

async function hmacHex(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(data),
	);
	return Array.from(new Uint8Array(mac))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function postWebhook(body: string, sigHeader: string | null) {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (sigHeader !== null) headers["stripe-signature"] = sigHeader;
	const request = new Request<unknown, IncomingRequestCfProperties>(
		"http://example.com/webhook/stripe",
		{ method: "POST", body, headers },
	);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, TEST_ENV, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

// Event whose `type` doesn't match any branch in processStripeEvent — keeps
// the waitUntil side-effect a no-op so we only assert on the verification path.
const SAFE_EVENT = JSON.stringify({ type: "ping", data: { object: {} } });

describe("POST /webhook/stripe — verifyStripeSignature (T1)", () => {
	it("valid signature + fresh timestamp → 200 received", async () => {
		const ts = Math.floor(Date.now() / 1000);
		const sig = await hmacHex(SECRET, `${ts}.${SAFE_EVENT}`);
		const res = await postWebhook(SAFE_EVENT, `t=${ts},v1=${sig}`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ received: true });
	});

	it("valid signature + stale timestamp (>300s old) → 400 (replay rejected)", async () => {
		const ts = Math.floor(Date.now() / 1000) - 301;
		const sig = await hmacHex(SECRET, `${ts}.${SAFE_EVENT}`);
		const res = await postWebhook(SAFE_EVENT, `t=${ts},v1=${sig}`);
		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Invalid signature");
	});

	it("tampered payload (signature was for original) → 400", async () => {
		const ts = Math.floor(Date.now() / 1000);
		const original = JSON.stringify({
			type: "ping",
			data: { object: { v: 1 } },
		});
		const tampered = JSON.stringify({
			type: "ping",
			data: { object: { v: 2 } },
		});
		const sig = await hmacHex(SECRET, `${ts}.${original}`);
		const res = await postWebhook(tampered, `t=${ts},v1=${sig}`);
		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Invalid signature");
	});

	it("missing stripe-signature header → handler returns 400", async () => {
		const res = await postWebhook(SAFE_EVENT, null);
		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Missing stripe-signature");
	});

	it("malformed signature header (no t=, no v1=) → 400", async () => {
		const res = await postWebhook(SAFE_EVENT, "foo=bar,baz=qux");
		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Invalid signature");
	});

	it("malformed signature header (only t=, no v1=) → 400", async () => {
		const ts = Math.floor(Date.now() / 1000);
		const res = await postWebhook(SAFE_EVENT, `t=${ts}`);
		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Invalid signature");
	});

	it("unparseable JSON payload after valid signature → 400 (catch branch)", async () => {
		const ts = Math.floor(Date.now() / 1000);
		const garbage = "this is not json {{{";
		const sig = await hmacHex(SECRET, `${ts}.${garbage}`);
		const res = await postWebhook(garbage, `t=${ts},v1=${sig}`);
		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Invalid signature");
	});

	// Latent-bug-discovery test (drives subsequent fix bead).
	// Today: Number('abc') → NaN; `Math.abs(NaN - now) > 300` is false, so the
	// freshness check is bypassed and a non-numeric timestamp is accepted as
	// fresh. This assertion is EXPECTED TO FAIL until the fix lands —
	// that's the point.
	it("non-numeric timestamp (t=abc) → 400 (latent NaN-bypass)", async () => {
		const ts = "abc";
		const sig = await hmacHex(SECRET, `${ts}.${SAFE_EVENT}`);
		const res = await postWebhook(SAFE_EVENT, `t=${ts},v1=${sig}`);
		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Invalid signature");
	});
});
