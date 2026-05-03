/**
 * AILedger Proxy Worker
 *
 * Intercepts AI provider API calls, logs input/output hashes as immutable
 * audit records to Supabase, then forwards the request transparently.
 *
 * Integration for the customer — one env var change:
 *   OPENAI_BASE_URL=https://ailedger.dev/proxy/openai
 *
 * Authentication: pass API key in x-ailedger-key header
 *   x-ailedger-key: agl_sk_xxxx...
 */

import canonicalize from 'canonicalize';

export interface Env {
	SUPABASE_URL: string;
	SUPABASE_SERVICE_KEY: string;
	STRIPE_SECRET_KEY: string;
	STRIPE_WEBHOOK_SECRET: string;
	SUPABASE_HOOK_SECRET: string;
	AILEDGER_CACHE: KVNamespace;
}

// Supported upstream providers
const PROVIDERS: Record<string, string> = {
	openai: 'https://api.openai.com',
	anthropic: 'https://api.anthropic.com',
	gemini: 'https://generativelanguage.googleapis.com',
};

export default {
	async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext): Promise<void> {
		// Drip email sequences removed 2026-04-30 (Jake universal directive — Google-only email stack).
		// Will be reintroduced via Gmail API once Google Workspace is provisioned for ailedger.dev.
		// See memory/feedback_email_stack_google_only.md.
	},

	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Health check
		if (url.pathname === '/health') {
			return new Response(JSON.stringify({ status: 'ok' }), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// Route: /webhook/stripe
		if (url.pathname === '/webhook/stripe') {
			return handleStripeWebhook(request, env, ctx);
		}

		// Route: /checkout/create-session
		if (url.pathname === '/checkout/create-session') {
			return handleCreateCheckoutSession(request, env);
		}

		// Route: POST /billing/portal
		if (url.pathname === '/billing/portal') {
			return handleBillingPortal(request, env);
		}

		// Route: POST /auth/signup-hook
		if (url.pathname === '/auth/signup-hook') {
			return handleSignupHook(request, env);
		}

		// Route: /proxy/<provider>/<...path>
		const match = url.pathname.match(/^\/proxy\/([^\/]+)(\/.*)?$/);
		if (!match) {
			return new Response('Not Found', { status: 404 });
		}

		const providerKey = match[1].toLowerCase();
		const upstreamBase = PROVIDERS[providerKey];
		if (!upstreamBase) {
			return new Response(`Unknown provider: ${providerKey}`, { status: 400 });
		}

		// ─── Authenticate API key ────────────────────────────────────────────
		const apiKey = request.headers.get('x-ailedger-key');
		if (!apiKey) {
			return new Response(JSON.stringify({ error: 'Missing x-ailedger-key header' }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		const resolved = await resolveApiKey(env, apiKey, ctx);
		if (!resolved) {
			return new Response(JSON.stringify({ error: 'Invalid API key' }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		const { supabaseUserId, systemId } = resolved;

		// ─── Usage limit check (free tier: 10k/month) ───────────────────────
		const limitHit = await checkUsageLimit(env, supabaseUserId);
		if (limitHit) {
			return new Response(JSON.stringify({ error: 'Monthly inference limit reached. Upgrade at https://dash.ailedger.dev/billing' }), {
				status: 429,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		let upstreamPath = match[2] ?? '/';
		// OpenAI SDK omits /v1 from the path when a custom base_url is set.
		// Normalize so both SDK clients and raw curl calls (which include /v1) work.
		if (providerKey === 'openai' && !upstreamPath.startsWith('/v1')) {
			upstreamPath = '/v1' + upstreamPath;
		}
		const upstreamUrl = `${upstreamBase}${upstreamPath}${url.search}`;

		// Clone request body once so we can read it and still forward it
		const requestBody = request.body ? await request.arrayBuffer() : null;
		const requestContentType = request.headers.get('content-type');

		// Strip our auth header and SDK telemetry headers before forwarding.
		// OpenAI's abuse detection blocks requests that carry the Python/Node SDK
		// user-agent and x-stainless-* headers from datacenter IPs.
		const forwardHeaders = filterHeaders(request.headers, [
			'host',
			'cf-connecting-ip',
			'cf-ray',
			'x-forwarded-for',
			'x-ailedger-key',
			'user-agent',
			'x-stainless-lang',
			'x-stainless-package-version',
			'x-stainless-runtime',
			'x-stainless-runtime-version',
			'x-stainless-os',
			'x-stainless-arch',
		]);

		const upstreamRequest = new Request(upstreamUrl, {
			method: request.method,
			headers: forwardHeaders,
			body: requestBody,
		});

		const startedAt = new Date().toISOString();
		const startMs = Date.now();
		const upstreamResponse = await fetch(upstreamRequest);
		const latencyMs = Date.now() - startMs;
		const completedAt = new Date().toISOString();

		const responseBody = await upstreamResponse.arrayBuffer();
		const responseContentType = upstreamResponse.headers.get('content-type');

		// Log async — never block the response
		ctx.waitUntil(
			logInference({
				env,
				provider: providerKey,
				method: request.method,
				path: upstreamPath,
				requestBody,
				requestContentType,
				responseBody,
				responseContentType,
				statusCode: upstreamResponse.status,
				latencyMs,
				startedAt,
				completedAt,
				supabaseUserId,
				systemId,
			}),
		);

		return new Response(responseBody, {
			status: upstreamResponse.status,
			statusText: upstreamResponse.statusText,
			headers: upstreamResponse.headers,
		});
	},
} satisfies ExportedHandler<Env>;

// ─── Stripe Checkout ─────────────────────────────────────────────────────────

const PRICE_IDS: Record<string, string> = {
	pro_monthly: 'price_1TKu0LD6WkAFuxKjcrRG4LvD',
	pro_annual: 'price_1TKu0LD6WkAFuxKjH1QU0ffp',
	scale_monthly: 'price_1TKu1zD6WkAFuxKjmywsCCkc',
	scale_annual: 'price_1TKu1zD6WkAFuxKjQPimVlB8',
};

async function handleCreateCheckoutSession(request: Request, env: Env): Promise<Response> {
	const cors = {
		'Access-Control-Allow-Origin': 'https://dash.ailedger.dev',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
	};

	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: cors });
	}

	// Verify Supabase JWT
	const authHeader = request.headers.get('Authorization');
	if (!authHeader?.startsWith('Bearer ')) {
		return new Response(JSON.stringify({ error: 'Unauthorized' }), {
			status: 401,
			headers: { ...cors, 'Content-Type': 'application/json' },
		});
	}
	const token = authHeader.slice(7);

	const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
		headers: {
			apikey: env.SUPABASE_SERVICE_KEY,
			Authorization: `Bearer ${token}`,
		},
	});
	if (!userRes.ok) {
		return new Response(JSON.stringify({ error: 'Unauthorized' }), {
			status: 401,
			headers: { ...cors, 'Content-Type': 'application/json' },
		});
	}
	const user = (await userRes.json()) as { id: string; email: string };

	const body = (await request.json()) as { price_key: string };
	const priceId = PRICE_IDS[body.price_key];
	if (!priceId) {
		return new Response(JSON.stringify({ error: 'Invalid price' }), {
			status: 400,
			headers: { ...cors, 'Content-Type': 'application/json' },
		});
	}

	// Create Stripe Checkout session
	const params = new URLSearchParams({
		'line_items[0][price]': priceId,
		'line_items[0][quantity]': '1',
		mode: 'subscription',
		success_url: `https://dash.ailedger.dev?checkout=success&plan=${body.price_key}`,
		cancel_url: 'https://dash.ailedger.dev?checkout=cancel',
		customer_email: user.email,
		'metadata[supabase_user_id]': user.id,
		'metadata[plan]': body.price_key,
		'subscription_data[metadata][supabase_user_id]': user.id,
		'subscription_data[metadata][plan]': body.price_key,
	});

	const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: params.toString(),
	});

	if (!stripeRes.ok) {
		const err = await stripeRes.text();
		console.error(`Stripe checkout error: ${stripeRes.status} ${err}`);
		return new Response(JSON.stringify({ error: 'Failed to create checkout session' }), {
			status: 500,
			headers: { ...cors, 'Content-Type': 'application/json' },
		});
	}

	const session = (await stripeRes.json()) as { url: string };
	return new Response(JSON.stringify({ url: session.url }), {
		headers: { ...cors, 'Content-Type': 'application/json' },
	});
}

async function handleBillingPortal(request: Request, env: Env): Promise<Response> {
	const cors = {
		'Access-Control-Allow-Origin': 'https://dash.ailedger.dev',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
	};

	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: cors });
	}

	const authHeader = request.headers.get('Authorization');
	if (!authHeader?.startsWith('Bearer ')) {
		return new Response(JSON.stringify({ error: 'Unauthorized' }), {
			status: 401,
			headers: { ...cors, 'Content-Type': 'application/json' },
		});
	}
	const token = authHeader.slice(7);

	const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
		headers: {
			apikey: env.SUPABASE_SERVICE_KEY,
			Authorization: `Bearer ${token}`,
		},
	});
	if (!userRes.ok) {
		return new Response(JSON.stringify({ error: 'Unauthorized' }), {
			status: 401,
			headers: { ...cors, 'Content-Type': 'application/json' },
		});
	}
	const user = (await userRes.json()) as { id: string };

	// Look up stripe_customer_id from subscriptions table
	const subRes = await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions?supabase_user_id=eq.${user.id}&select=stripe_customer_id`, {
		headers: {
			apikey: env.SUPABASE_SERVICE_KEY,
			Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
			'Accept-Profile': 'ledger',
		},
	});

	const rows = (await subRes.json()) as { stripe_customer_id: string }[];
	if (!rows.length) {
		return new Response(JSON.stringify({ error: 'No subscription found' }), {
			status: 404,
			headers: { ...cors, 'Content-Type': 'application/json' },
		});
	}

	const params = new URLSearchParams({
		customer: rows[0].stripe_customer_id,
		return_url: 'https://dash.ailedger.dev?billing=returned',
	});

	const portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: params.toString(),
	});

	if (!portalRes.ok) {
		const err = await portalRes.text();
		console.error(`Stripe portal error: ${portalRes.status} ${err}`);
		return new Response(JSON.stringify({ error: 'Failed to create portal session' }), {
			status: 500,
			headers: { ...cors, 'Content-Type': 'application/json' },
		});
	}

	const session = (await portalRes.json()) as { url: string };
	return new Response(JSON.stringify({ url: session.url }), {
		headers: { ...cors, 'Content-Type': 'application/json' },
	});
}

// ─── Stripe Webhook ─────────────────────────────────────────────────────────

async function handleStripeWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const sig = request.headers.get('stripe-signature');
	if (!sig) return new Response('Missing stripe-signature', { status: 400 });

	const body = await request.text();

	// Verify webhook signature
	const event = await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET);
	if (!event) return new Response('Invalid signature', { status: 400 });

	// Synchronous persist BEFORE 200. Stripe takes 200 as "delivered" and does NOT retry —
	// returning 5xx triggers Stripe's exponential-backoff retry, which is what we want when
	// our DB is transiently down. Closes threat model §6.5 (correctness C2 / resilience C1).
	void ctx;
	try {
		await processStripeEvent(event, env);
		return new Response(JSON.stringify({ received: true }), {
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (err) {
		console.error('stripe-webhook:processStripeEvent-failed', { eventId: event['id'], eventType: event['type'], error: String(err) });
		return new Response(JSON.stringify({ error: 'processing failed; please retry' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}
}

async function verifyStripeSignature(payload: string, sig: string, secret: string): Promise<Record<string, unknown> | null> {
	try {
		const parts = Object.fromEntries(sig.split(',').map((p) => p.split('=')));
		const timestamp = parts['t'];
		const v1 = parts['v1'];
		if (!timestamp || !v1) return null;
		// Guard against NaN bypass — Number('abc') is NaN, NaN > 300 is false,
		// so a malformed t= would slip past the freshness check below. Closes
		// correctness M5 from convoy review 2026-05-03.
		if (!/^\d+$/.test(timestamp)) return null;

		const signed = `${timestamp}.${payload}`;
		const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
		const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));

		const v1Bytes = hexToBytes(v1);
		if (!v1Bytes || !timingSafeEqual(new Uint8Array(mac), v1Bytes)) return null;

		// Reject events older than 5 minutes
		if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return null;

		return JSON.parse(payload) as Record<string, unknown>;
	} catch {
		return null;
	}
}

async function processStripeEvent(event: Record<string, unknown>, env: Env): Promise<void> {
	const type = event['type'] as string;
	const data = (event['data'] as Record<string, unknown>)['object'] as Record<string, unknown>;

	if (type === 'checkout.session.completed') {
		const customerId = data['customer'] as string | null;
		const subscriptionId = data['subscription'] as string | null;
		const metadata = data['metadata'] as Record<string, string> | null;
		const supabaseUserId = metadata?.['supabase_user_id'] ?? null;
		const plan = metadata?.['plan'] ?? null;
		if (customerId && subscriptionId) {
			await upsertSubscription(env, customerId, subscriptionId, 'active', supabaseUserId, plan);
		}
	} else if (type === 'customer.subscription.updated') {
		const customerId = data['customer'] as string | null;
		const subscriptionId = data['id'] as string | null;
		const status = data['status'] as string | null;
		const metadata = data['metadata'] as Record<string, string> | null;
		const supabaseUserId = metadata?.['supabase_user_id'] ?? null;
		const plan = metadata?.['plan'] ?? null;
		if (customerId && subscriptionId && status) {
			await upsertSubscription(env, customerId, subscriptionId, status, supabaseUserId, plan);
		}
	} else if (type === 'customer.subscription.deleted') {
		const customerId = data['customer'] as string | null;
		const subscriptionId = data['id'] as string | null;
		const metadata = data['metadata'] as Record<string, string> | null;
		const supabaseUserId = metadata?.['supabase_user_id'] ?? null;
		const plan = metadata?.['plan'] ?? null;
		if (customerId && subscriptionId) {
			await upsertSubscription(env, customerId, subscriptionId, 'canceled', supabaseUserId, plan);
		}
	}
}

async function upsertSubscription(
	env: Env,
	stripeCustomerId: string,
	stripeSubscriptionId: string,
	status: string,
	supabaseUserId: string | null,
	plan: string | null,
): Promise<void> {
	const res = await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions`, {
		method: 'POST',
		headers: {
			apikey: env.SUPABASE_SERVICE_KEY,
			Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
			'Content-Type': 'application/json',
			'Content-Profile': 'ledger',
			Prefer: 'resolution=merge-duplicates,return=minimal',
		},
		body: JSON.stringify({
			stripe_customer_id: stripeCustomerId,
			stripe_subscription_id: stripeSubscriptionId,
			status,
			...(supabaseUserId && { supabase_user_id: supabaseUserId }),
			...(plan && { plan }),
			updated_at: new Date().toISOString(),
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		// Throw so handleStripeWebhook returns 5xx and Stripe retries.
		// Closes threat model §6.5 / correctness C2.
		throw new Error(`Subscription upsert failed: ${res.status} ${body}`);
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// Constant-time byte comparison for HMAC signatures. Closes threat model §6.7.
// Returns false on length mismatch first (no information leak — length is
// already public from the signature header). XOR-accumulates over equal-length
// arrays so total time is independent of where bytes diverge.
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

function hexToBytes(hex: string): Uint8Array | null {
	if (hex.length % 2 !== 0) return null;
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		const byte = parseInt(hex.substr(i * 2, 2), 16);
		if (Number.isNaN(byte)) return null;
		out[i] = byte;
	}
	return out;
}

// Exported so tests (see proxy/test/perf-regression.spec.ts) can measure
// filterHeaders perf directly. Wiring is unchanged.
export function filterHeaders(headers: Headers, drop: string[]): Headers {
	const out = new Headers();
	headers.forEach((value, key) => {
		const k = key.toLowerCase();
		if (!drop.includes(k) && !k.startsWith('x-stainless-')) {
			out.set(key, value);
		}
	});
	return out;
}

async function sha256hex(data: ArrayBuffer | null | string): Promise<string | null> {
	if (!data) return null;
	const buf = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
	if (buf.byteLength === 0) return null;
	const hashBuffer = await crypto.subtle.digest('SHA-256', buf);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

// ─── RFC 8785 JCS canonical hashing ─────────────────────────────────────────
// Cross-SDK JSON hash stability: the same logical object must produce the
// same hash regardless of which SDK serialized it. Raw-byte SHA-256 fails
// this (key order, whitespace, number format vary), so for JSON bodies we
// canonicalize per RFC 8785 first and hash the canonical form.
//
// JCS library: `canonicalize` (erdtman/canonicalize), Apache-2.0, ~1.3 KB,
// co-authored by Anders Rundgren (RFC 8785 primary author) and Samuel
// Erdtman. Chosen over `json-canonicalize` for authorship provenance and
// smaller bundle footprint (Workers: every KB matters).
//
// Content branching (HARD CONTRACT — changing these rules invalidates the
// chain going forward, not retroactively):
//   • content-type matches `application/json` (or `+json`) AND body parses
//     as valid JSON  → hash = SHA-256(JCS(parsed))
//   • anything else (binary, multipart/form-data, text/event-stream SSE,
//     malformed JSON, compressed encodings) → hash = SHA-256(raw-bytes)
//
// JSON with embedded base64 binary is hashed via the JCS path; the base64
// string is treated as an opaque value. Base64 expected to be standard
// RFC 4648 form (no line-wrapping); providers that emit line-wrapped
// base64 will get a stable hash only if wrapping is stable across calls.
export function isJsonContentType(contentType: string | null | undefined): boolean {
	if (!contentType) return false;
	const ct = contentType.toLowerCase().split(';')[0].trim();
	return ct === 'application/json' || ct.endsWith('+json');
}

export async function sha256jcs(data: ArrayBuffer | null, contentType: string | null): Promise<string | null> {
	if (!data) return null;
	const buf = new Uint8Array(data);
	if (buf.byteLength === 0) return null;

	if (isJsonContentType(contentType)) {
		try {
			const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf);
			const parsed = JSON.parse(text);
			const canonical = canonicalize(parsed);
			if (canonical !== undefined) {
				return sha256hex(canonical);
			}
		} catch {
			// Fall through to raw-byte hashing. Examples: invalid UTF-8,
			// malformed JSON, values JCS rejects (NaN, Infinity, symbols).
			// Staying raw keeps the hash stable and ties it to what was
			// actually on the wire.
		}
	}

	return sha256hex(data);
}

// api_keys.customer_id IS auth.users.id by schema invariant; renamed local var for clarity.
//
// Revocation tombstone convention (threat model §6.3): when a key is revoked, the
// revocation path writes `revoked:${keyHash} = '1'` to KV with a long TTL (≥7 days)
// BEFORE deleting the api_keys row. The tombstone outlives the positive cache
// (60s expirationTtl below), so a revoked key is rejected at every PoP even if a
// stale `key:${keyHash}` entry hasn't expired yet.
//
// Exported so tests (see proxy/test/key-rotation.spec.ts) can exercise the
// cache-vs-DB path directly. Wiring is unchanged.
export async function resolveApiKey(
	env: Env,
	apiKey: string,
	ctx: ExecutionContext,
): Promise<{ supabaseUserId: string; systemId: string | null } | null> {
	const keyHash = await sha256hex(apiKey);
	if (!keyHash) return null;

	const tombstone = await env.AILEDGER_CACHE.get(`revoked:${keyHash}`);
	if (tombstone) return null;

	// Check KV cache first (~5ms) before hitting Supabase (~150ms)
	const cacheKey = `key:${keyHash}`;
	const cached = (await env.AILEDGER_CACHE.get(cacheKey, 'json')) as { supabaseUserId: string; systemId: string | null } | null;
	if (cached) return cached;

	const res = await fetch(`${env.SUPABASE_URL}/rest/v1/api_keys?key_hash=eq.${keyHash}&select=customer_id,system_id`, {
		headers: {
			apikey: env.SUPABASE_SERVICE_KEY,
			Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
			'Accept-Profile': 'ledger',
		},
	});

	if (!res.ok) return null;

	const rows = (await res.json()) as { customer_id: string; system_id: string | null }[];
	if (!rows.length) return null;

	const result = { supabaseUserId: rows[0].customer_id, systemId: rows[0].system_id ?? null };

	// Cache for 60s (defense-in-depth: faster invalidation than 300s) and update
	// last_used_at — both fire-and-forget. Revocation tombstone above covers the
	// window where a key is revoked but a positive cache entry hasn't expired.
	ctx.waitUntil(env.AILEDGER_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 60 }));
	ctx.waitUntil(
		fetch(`${env.SUPABASE_URL}/rest/v1/api_keys?key_hash=eq.${keyHash}`, {
			method: 'PATCH',
			headers: {
				apikey: env.SUPABASE_SERVICE_KEY,
				Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
				'Content-Type': 'application/json',
				'Content-Profile': 'ledger',
				Prefer: 'return=minimal',
			},
			body: JSON.stringify({ last_used_at: new Date().toISOString() }),
		}),
	);

	return result;
}

async function verifyStandardWebhook(request: Request, secret: string, bodyText: string): Promise<boolean> {
	try {
		const msgId = request.headers.get('webhook-id') ?? '';
		const msgTimestamp = request.headers.get('webhook-timestamp') ?? '';
		const msgSignature = request.headers.get('webhook-signature') ?? '';

		const signedContent = `${msgId}.${msgTimestamp}.${bodyText}`;

		// Secret is "v1,whsec_<base64>" — extract the base64 part
		const base64Secret = secret.replace(/^v1,whsec_/, '');
		const secretBytes = Uint8Array.from(atob(base64Secret), (c) => c.charCodeAt(0));

		const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
		const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedContent));
		const computedSig = 'v1,' + btoa(String.fromCharCode(...new Uint8Array(sig)));

		const enc = new TextEncoder();
		const computedBytes = enc.encode(computedSig);
		for (const s of msgSignature.split(' ')) {
			if (timingSafeEqual(enc.encode(s), computedBytes)) return true;
		}
		return false;
	} catch {
		return false;
	}
}

async function handleSignupHook(request: Request, env: Env): Promise<Response> {
	const bodyText = await request.text();

	const valid = await verifyStandardWebhook(request, env.SUPABASE_HOOK_SECRET, bodyText);
	if (!valid) {
		console.error('Signup hook: invalid signature');
		return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
	}

	const body = JSON.parse(bodyText) as Record<string, any>;

	const email: string | null = body?.user?.email ?? body?.record?.email ?? body?.email ?? null;
	const meta = body?.user?.user_metadata ?? body?.record?.raw_user_meta_data ?? {};
	const name: string | null = meta?.full_name ?? meta?.name ?? null;

	// If this is a Send Email hook, Supabase includes email_data with a token
	const emailData = body?.email_data as Record<string, string> | null;
	const actionType = emailData?.email_action_type ?? null;
	const tokenHash = emailData?.token_hash ?? null;
	const redirectTo = emailData?.redirect_to ?? 'https://dash.ailedger.dev/logs';

	// Build the magic link if we have a token
	const magicLink = tokenHash
		? `${env.SUPABASE_URL}/auth/v1/verify?token=${tokenHash}&type=${actionType ?? 'signup'}&redirect_to=${encodeURIComponent(redirectTo)}`
		: 'https://dash.ailedger.dev/logs';

	if (!email) {
		console.error('Signup hook: no email found in payload');
		return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
	}

	// Email send paths (welcome / password-reset) removed 2026-04-30 per Jake universal directive
	// — Google-only email stack. Will be reintroduced via Gmail API once Workspace lands.
	// See memory/feedback_email_stack_google_only.md.
	// NOTE: do NOT log the magic-link URL or token_hash — workers logs flow to Logpush sinks
	// and capturing a verification token in logs == account-takeover-via-log-access. Closes
	// threat model §6.6. Log only non-secret derived fields.
	void magicLink;
	console.log('signup-hook', { actionType, hasEmail: !!email, hasToken: !!tokenHash });

	return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function checkUsageLimit(env: Env, supabaseUserId: string): Promise<boolean> {
	// Paid customers: cache "no limit" for 5 minutes
	const paidCacheKey = `paid:${supabaseUserId}`;
	const isPaidCached = await env.AILEDGER_CACHE.get(paidCacheKey);
	if (isPaidCached === 'true') return false;

	// Check subscription plan
	const subRes = await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions?supabase_user_id=eq.${supabaseUserId}&select=status,plan`, {
		headers: {
			apikey: env.SUPABASE_SERVICE_KEY,
			Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
			'Accept-Profile': 'ledger',
		},
	});
	if (subRes.ok) {
		const subs = (await subRes.json()) as { status: string; plan: string }[];
		const active = subs.find((s) => s.status === 'active');
		if (active) {
			// Cache paid status for 5 minutes — fire-and-forget
			env.AILEDGER_CACHE.put(paidCacheKey, 'true', { expirationTtl: 300 });
			return false;
		}
	} else {
		// Paid-status query failed (Supabase 5xx). Closes threat model §6.4.
		// Honor last-known-good cache if present; otherwise fall through to free-tier counting.
		console.error('checkUsageLimit:paid-status-query-failed', { supabaseUserId, status: subRes.status });
		if ((await env.AILEDGER_CACHE.get(paidCacheKey)) === 'true') return false;
	}

	// Free tier: count this month's inferences
	const monthStart = new Date();
	monthStart.setDate(1);
	monthStart.setHours(0, 0, 0, 0);

	const countRes = await fetch(
		`${env.SUPABASE_URL}/rest/v1/inference_logs?customer_id=eq.${supabaseUserId}&logged_at=gte.${monthStart.toISOString()}&select=id`,
		{
			headers: {
				apikey: env.SUPABASE_SERVICE_KEY,
				Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
				'Accept-Profile': 'ledger',
				Prefer: 'count=exact',
				'Range-Unit': 'items',
				Range: '0-0',
			},
		},
	);

	if (!countRes.ok) {
		// Closes threat model §6.4. Still fail-open in customer favor; signal degradation
		// to ops via console.error + a short-lived KV breaker (`usage_limit_degraded`)
		// that an external monitor can scrape via /health.
		console.error('checkUsageLimit:count-query-failed', { supabaseUserId, status: countRes.status });
		env.AILEDGER_CACHE.put('usage_limit_degraded', '1', { expirationTtl: 60 });
		return false;
	}

	const contentRange = countRes.headers.get('content-range');
	const total = contentRange ? parseInt(contentRange.split('/')[1] ?? '0', 10) : 0;
	return total >= 10_000;
}

// Drip email sequences removed 2026-04-30 per Jake universal directive (Google-only stack).
// Will be reintroduced via Gmail API once Google Workspace is provisioned for ailedger.dev.
// Prior implementation: runDripEmails (paginated user fetch + day-3/day-7 windowing + Resend send).
// See memory/feedback_email_stack_google_only.md and feedback_jake_ailedger_send_as_broken.md.

async function logInference({
	env,
	provider,
	method,
	path,
	requestBody,
	requestContentType,
	responseBody,
	responseContentType,
	statusCode,
	latencyMs,
	startedAt,
	completedAt,
	supabaseUserId,
	systemId,
}: {
	env: Env;
	provider: string;
	method: string;
	path: string;
	requestBody: ArrayBuffer | null;
	requestContentType: string | null;
	responseBody: ArrayBuffer;
	responseContentType: string | null;
	statusCode: number;
	latencyMs: number;
	startedAt: string;
	completedAt: string;
	supabaseUserId: string;
	systemId: string | null;
}): Promise<void> {
	const [inputHash, outputHash] = await Promise.all([
		sha256jcs(requestBody, requestContentType),
		sha256jcs(responseBody, responseContentType),
	]);

	let modelName: string | null = null;
	if (requestBody && requestBody.byteLength > 0) {
		try {
			const parsed = JSON.parse(new TextDecoder().decode(requestBody));
			modelName = parsed?.model ?? null;
		} catch {
			// not JSON — skip
		}
	}
	// Gemini: model is in the URL path, e.g. /models/gemini-2.5-flash:generateContent
	if (!modelName && provider === 'gemini') {
		const match = path.match(/\/models\/([^:\/]+)/);
		if (match) modelName = match[1];
	}

	// chain_prev_hash and chain_genesis_at are filled in by the BEFORE INSERT
	// trigger (migrations/20260418_tamper_evident_chain.sql). Computing the
	// hash worker-side would race under concurrent inserts for the same
	// customer; the trigger serializes via a per-customer advisory lock.
	const entry = {
		customer_id: supabaseUserId,
		system_id: systemId,
		provider,
		model_name: modelName,
		method,
		path,
		input_hash: inputHash,
		output_hash: outputHash,
		status_code: statusCode,
		latency_ms: latencyMs,
		started_at: startedAt,
		completed_at: completedAt,
		logged_at: new Date().toISOString(),
	};

	const res = await fetch(`${env.SUPABASE_URL}/rest/v1/inference_logs`, {
		method: 'POST',
		headers: {
			apikey: env.SUPABASE_SERVICE_KEY,
			Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
			'Content-Type': 'application/json',
			'Content-Profile': 'ledger',
			Prefer: 'return=minimal',
		},
		body: JSON.stringify(entry),
	});

	if (!res.ok) {
		const body = await res.text();
		console.error(`Supabase insert failed: ${res.status} ${body}`);
	}
}
