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

export interface Env {
	SUPABASE_URL: string;
	SUPABASE_SERVICE_KEY: string;
	STRIPE_SECRET_KEY: string;
	STRIPE_WEBHOOK_SECRET: string;
	RESEND_API_KEY: string;
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
	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(runDripEmails(env));
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
		const { customerId, systemId } = resolved;

		// ─── Usage limit check (free tier: 10k/month) ───────────────────────
		const limitHit = await checkUsageLimit(env, customerId);
		if (limitHit) {
			return new Response(
				JSON.stringify({ error: 'Monthly inference limit reached. Upgrade at https://dash.ailedger.dev/billing' }),
				{ status: 429, headers: { 'Content-Type': 'application/json' } }
			);
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

		// Strip our auth header and SDK telemetry headers before forwarding.
		// OpenAI's abuse detection blocks requests that carry the Python/Node SDK
		// user-agent and x-stainless-* headers from datacenter IPs.
		const forwardHeaders = filterHeaders(request.headers, [
			'host', 'cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-ailedger-key',
			'user-agent', 'x-stainless-lang', 'x-stainless-package-version',
			'x-stainless-runtime', 'x-stainless-runtime-version', 'x-stainless-os', 'x-stainless-arch',
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

		// Log async — never block the response
		ctx.waitUntil(
			logInference({
				env,
				provider: providerKey,
				method: request.method,
				path: upstreamPath,
				requestBody,
				responseBody,
				statusCode: upstreamResponse.status,
				latencyMs,
				startedAt,
				completedAt,
				customerId,
				systemId,
			})
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
		return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });
	}
	const token = authHeader.slice(7);

	const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
		headers: {
			apikey: env.SUPABASE_SERVICE_KEY,
			Authorization: `Bearer ${token}`,
		},
	});
	if (!userRes.ok) {
		return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });
	}
	const user = await userRes.json() as { id: string; email: string };

	const body = await request.json() as { price_key: string };
	const priceId = PRICE_IDS[body.price_key];
	if (!priceId) {
		return new Response(JSON.stringify({ error: 'Invalid price' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
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
		return new Response(JSON.stringify({ error: 'Failed to create checkout session' }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
	}

	const session = await stripeRes.json() as { url: string };
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
		return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });
	}
	const token = authHeader.slice(7);

	const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
		headers: {
			apikey: env.SUPABASE_SERVICE_KEY,
			Authorization: `Bearer ${token}`,
		},
	});
	if (!userRes.ok) {
		return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });
	}
	const user = await userRes.json() as { id: string };

	// Look up stripe_customer_id from subscriptions table
	const subRes = await fetch(
		`${env.SUPABASE_URL}/rest/v1/subscriptions?supabase_user_id=eq.${user.id}&select=stripe_customer_id`,
		{
			headers: {
				apikey: env.SUPABASE_SERVICE_KEY,
				Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
				'Accept-Profile': 'ledger',
			},
		}
	);

	const rows = await subRes.json() as { stripe_customer_id: string }[];
	if (!rows.length) {
		return new Response(JSON.stringify({ error: 'No subscription found' }), { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } });
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
		return new Response(JSON.stringify({ error: 'Failed to create portal session' }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
	}

	const session = await portalRes.json() as { url: string };
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

	ctx.waitUntil(processStripeEvent(event, env));

	return new Response(JSON.stringify({ received: true }), {
		headers: { 'Content-Type': 'application/json' },
	});
}

async function verifyStripeSignature(
	payload: string,
	sig: string,
	secret: string,
): Promise<Record<string, unknown> | null> {
	try {
		const parts = Object.fromEntries(sig.split(',').map((p) => p.split('=')));
		const timestamp = parts['t'];
		const v1 = parts['v1'];
		if (!timestamp || !v1) return null;

		const signed = `${timestamp}.${payload}`;
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		);
		const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));
		const computed = Array.from(new Uint8Array(mac))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');

		if (computed !== v1) return null;

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
		console.error(`Subscription upsert failed: ${res.status} ${body}`);
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function filterHeaders(headers: Headers, drop: string[]): Headers {
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
	const buf = typeof data === 'string'
		? new TextEncoder().encode(data)
		: new Uint8Array(data);
	if (buf.byteLength === 0) return null;
	const hashBuffer = await crypto.subtle.digest('SHA-256', buf);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

async function resolveApiKey(env: Env, apiKey: string, ctx: ExecutionContext): Promise<{ customerId: string; systemId: string | null } | null> {
	const keyHash = await sha256hex(apiKey);
	if (!keyHash) return null;

	// Check KV cache first (~5ms) before hitting Supabase (~150ms)
	const cacheKey = `key:${keyHash}`;
	const cached = await env.AILEDGER_CACHE.get(cacheKey, 'json') as { customerId: string; systemId: string | null } | null;
	if (cached) return cached;

	const res = await fetch(
		`${env.SUPABASE_URL}/rest/v1/api_keys?key_hash=eq.${keyHash}&select=customer_id,system_id`,
		{
			headers: {
				apikey: env.SUPABASE_SERVICE_KEY,
				Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
				'Accept-Profile': 'ledger',
			},
		}
	);

	if (!res.ok) return null;

	const rows = await res.json() as { customer_id: string; system_id: string | null }[];
	if (!rows.length) return null;

	const result = { customerId: rows[0].customer_id, systemId: rows[0].system_id ?? null };

	// Cache for 5 minutes and update last_used_at — both fire-and-forget
	ctx.waitUntil(env.AILEDGER_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 300 }));
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
		})
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
		const secretBytes = Uint8Array.from(atob(base64Secret), c => c.charCodeAt(0));

		const key = await crypto.subtle.importKey(
			'raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
		);
		const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedContent));
		const computedSig = 'v1,' + btoa(String.fromCharCode(...new Uint8Array(sig)));

		return msgSignature.split(' ').some(s => s === computedSig);
	} catch {
		return false;
	}
}

async function handleSignupHook(request: Request, env: Env): Promise<Response> {
	const bodyText = await request.text();
	console.log('Signup hook payload:', bodyText);

	const valid = await verifyStandardWebhook(request, env.SUPABASE_HOOK_SECRET, bodyText);
	if (!valid) {
		console.error('Signup hook: invalid signature');
		return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
	}

	const body = JSON.parse(bodyText) as Record<string, any>;
	console.log('Signup hook parsed body:', JSON.stringify(body));

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

	if (actionType === 'recovery') {
		await sendPasswordResetEmail(env, email, magicLink);
	} else {
		// signup, magiclink, email_change, etc.
		await sendWelcomeEmail(env, email, null, name, magicLink);
	}

	return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function sendWelcomeEmail(env: Env, to: string, plan: string | null = null, name: string | null = null, dashboardLink = 'https://dash.ailedger.dev/logs'): Promise<void> {
	if (!env.RESEND_API_KEY) { console.error('sendWelcomeEmail: no RESEND_API_KEY'); return; }
	const firstName = name ? name.split(' ')[0] : null;
	const resendRes = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			from: 'AILedger <team@ailedger.dev>',
			to,
			subject: `Thanks for choosing us to support you.`,
			html: `
				<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:40px 24px;color:#1e293b">
					<h1 style="font-size:24px;font-weight:700;margin-bottom:8px;color:#4f46e5">Welcome to AILedger</h1>
					<p style="font-size:15px;color:#475569;line-height:1.7;margin-bottom:32px">
						Your account is ready. Start logging AI inferences in under 60 seconds — grab an API key from your dashboard and point your OpenAI client at our proxy.
					</p>
					<a href="${dashboardLink}" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#fff;font-weight:600;font-size:14px;border-radius:8px;text-decoration:none">
						Go to dashboard →
					</a>
						<p style="font-size:14px;color:#475569;line-height:1.7;margin-top:32px">
							We're excited to have you on board. If you have any questions or feedback, reply to this email - we read everything.
						</p>
						<p style="font-size:14px;color:#334155;font-weight:500;margin-top:8px">
							- The AILedger Team
						</p>
					<p style="font-size:13px;color:#94a3b8;margin-top:40px;border-top:1px solid #e2e8f0;padding-top:16px">AILedger · ailedger.dev</p>
				</div>
			`,
		}),
	});
	if (!resendRes.ok) {
		const body = await resendRes.text();
		console.error(`Resend error: ${resendRes.status} ${body}`);
	} else {
		console.log(`Welcome email sent to ${to}`);
	}
}

async function sendPasswordResetEmail(env: Env, to: string, resetLink: string): Promise<void> {
	if (!env.RESEND_API_KEY) { console.error('sendPasswordResetEmail: no RESEND_API_KEY'); return; }
	const resendRes = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			from: 'AILedger <team@ailedger.dev>',
			to,
			subject: 'Reset your AILedger password',
			html: `
				<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:40px 24px;color:#1e293b">
					<h1 style="font-size:24px;font-weight:700;margin-bottom:8px;color:#4f46e5">Reset your password</h1>
					<p style="font-size:15px;color:#475569;line-height:1.7;margin-bottom:32px">
						Click the button below to set a new password for your AILedger account. This link expires in 1 hour.
					</p>
					<a href="${resetLink}" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#fff;font-weight:600;font-size:14px;border-radius:8px;text-decoration:none">
						Reset password →
					</a>
					<p style="font-size:13px;color:#94a3b8;margin-top:32px">If you didn't request this, you can safely ignore this email.</p>
					<p style="font-size:13px;color:#94a3b8;margin-top:16px;border-top:1px solid #e2e8f0;padding-top:16px">AILedger · ailedger.dev</p>
				</div>
			`,
		}),
	});
	if (!resendRes.ok) {
		const body = await resendRes.text();
		console.error(`Resend error (reset): ${resendRes.status} ${body}`);
	} else {
		console.log(`Password reset email sent to ${to}`);
	}
}

async function checkUsageLimit(env: Env, customerId: string): Promise<boolean> {
	// Paid customers: cache "no limit" for 5 minutes
	const paidCacheKey = `paid:${customerId}`;
	const isPaidCached = await env.AILEDGER_CACHE.get(paidCacheKey);
	if (isPaidCached === 'true') return false;

	// Check subscription plan
	const subRes = await fetch(
		`${env.SUPABASE_URL}/rest/v1/subscriptions?supabase_user_id=eq.${customerId}&select=status,plan`,
		{
			headers: {
				apikey: env.SUPABASE_SERVICE_KEY,
				Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
				'Accept-Profile': 'ledger',
			},
		}
	);
	if (subRes.ok) {
		const subs = await subRes.json() as { status: string; plan: string }[];
		const active = subs.find((s) => s.status === 'active');
		if (active) {
			// Cache paid status for 5 minutes — fire-and-forget
			env.AILEDGER_CACHE.put(paidCacheKey, 'true', { expirationTtl: 300 });
			return false;
		}
	}

	// Free tier: count this month's inferences
	const monthStart = new Date();
	monthStart.setDate(1);
	monthStart.setHours(0, 0, 0, 0);

	const countRes = await fetch(
		`${env.SUPABASE_URL}/rest/v1/inference_logs?customer_id=eq.${customerId}&logged_at=gte.${monthStart.toISOString()}&select=id`,
		{
			headers: {
				apikey: env.SUPABASE_SERVICE_KEY,
				Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
				'Accept-Profile': 'ledger',
				Prefer: 'count=exact',
				'Range-Unit': 'items',
				Range: '0-0',
			},
		}
	);

	if (!countRes.ok) return false; // fail open

	const contentRange = countRes.headers.get('content-range');
	const total = contentRange ? parseInt(contentRange.split('/')[1] ?? '0', 10) : 0;
	return total >= 10_000;
}

// ─── Drip email sequences ─────────────────────────────────────────────────────

async function runDripEmails(env: Env): Promise<void> {
	const now = new Date();

	// Find free users who signed up exactly 3 or 7 days ago (±12h window)
	// and have zero inference logs — they haven't integrated yet.
	for (const day of [3, 7]) {
		const windowStart = new Date(now.getTime() - (day * 24 + 12) * 60 * 60 * 1000).toISOString();
		const windowEnd   = new Date(now.getTime() - (day * 24 - 12) * 60 * 60 * 1000).toISOString();

		// Fetch users created in the window (auth.users via service key)
		const usersRes = await fetch(
			`${env.SUPABASE_URL}/auth/v1/admin/users?created_after=${encodeURIComponent(windowStart)}&created_before=${encodeURIComponent(windowEnd)}`,
			{
				headers: {
					apikey: env.SUPABASE_SERVICE_KEY,
					Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
				},
			}
		);
		if (!usersRes.ok) {
			console.error(`Drip day ${day}: failed to fetch users`, await usersRes.text());
			continue;
		}
		const { users } = await usersRes.json() as { users: { id: string; email: string; user_metadata?: Record<string, string> }[] };

		for (const user of users ?? []) {
			// Skip if they have an active paid subscription
			const subRes = await fetch(
				`${env.SUPABASE_URL}/rest/v1/subscriptions?supabase_user_id=eq.${user.id}&status=eq.active&select=id`,
				{
					headers: {
						apikey: env.SUPABASE_SERVICE_KEY,
						Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
						'Accept-Profile': 'ledger',
						'Range-Unit': 'items', Range: '0-0', Prefer: 'count=exact',
					},
				}
			);
			if (subRes.ok) {
				const cr = subRes.headers.get('content-range');
				if (cr && parseInt(cr.split('/')[1] ?? '0', 10) > 0) continue;
			}

			// Skip if they already have at least one inference log
			const logRes = await fetch(
				`${env.SUPABASE_URL}/rest/v1/inference_logs?customer_id=eq.${user.id}&select=id`,
				{
					headers: {
						apikey: env.SUPABASE_SERVICE_KEY,
						Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
						'Accept-Profile': 'ledger',
						'Range-Unit': 'items', Range: '0-0', Prefer: 'count=exact',
					},
				}
			);
			if (logRes.ok) {
				const cr = logRes.headers.get('content-range');
				if (cr && parseInt(cr.split('/')[1] ?? '0', 10) > 0) continue;
			}

			const name: string | null = user.user_metadata?.full_name ?? user.user_metadata?.name ?? null;
			const firstName = name ? name.split(' ')[0] : null;
			await sendDripEmail(env, user.email, firstName, day);
			console.log(`Drip day ${day} sent to ${user.email}`);
		}
	}
}

async function sendDripEmail(env: Env, to: string, firstName: string | null, day: 3 | 7): Promise<void> {
	if (!env.RESEND_API_KEY) return;

	const dashboardLink = 'https://dash.ailedger.dev/keys';

	const subjects: Record<number, string> = {
		3: 'Still getting set up? Here\'s how to finish in 60 seconds.',
		7: 'Your EU AI Act logs are missing — here\'s a quick fix.',
	};

	const bodies: Record<number, string> = {
		3: `
			<p style="font-size:15px;color:#1e293b;line-height:1.8;margin-bottom:24px">
				${firstName ? `Hi ${firstName},` : 'Hi,'}
			</p>
			<p style="font-size:15px;color:#334155;line-height:1.8;margin-bottom:24px">
				You signed up for AILedger a few days ago but haven't logged your first inference yet. Integration takes under 60 seconds - here's all you need:
			</p>
			<ol style="font-size:15px;color:#334155;line-height:2.2;padding-left:20px;margin-bottom:28px">
				<li>Create an API key in your dashboard</li>
				<li>Set <code style="background:#f1f5f9;padding:3px 8px;border-radius:4px;font-size:13px;color:#1e293b">base_url=https://proxy.ailedger.dev/proxy/openai</code></li>
				<li>Add <code style="background:#f1f5f9;padding:3px 8px;border-radius:4px;font-size:13px;color:#1e293b">x-ailedger-key: your-key</code> to your headers</li>
			</ol>
			<p style="font-size:15px;color:#334155;line-height:1.8;margin-bottom:32px">
				That's it. Your code doesn't change. Every inference is automatically logged as a tamper-evident, GDPR-compatible record.
			</p>
		`,
		7: `
			<p style="font-size:15px;color:#1e293b;line-height:1.8;margin-bottom:24px">
				${firstName ? `Hi ${firstName},` : 'Hi,'}
			</p>
			<p style="font-size:15px;color:#334155;line-height:1.8;margin-bottom:24px">
				The EU AI Act enforcement deadline is August 2, 2026. If you're shipping AI in the EU and not logging inferences, you're exposed.
			</p>
			<p style="font-size:15px;color:#334155;line-height:1.8;margin-bottom:24px">
				AILedger logs every inference as an immutable, SHA-256 hashed record - exactly what Article 12 requires. Drop-in integration in under 60 seconds.
			</p>
			<p style="font-size:15px;color:#334155;line-height:1.8;margin-bottom:32px">
				You already have an account. All you need to do is create an API key and point your client at our proxy.
			</p>
		`,
	};

	const html = `
		<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:48px 32px;color:#1e293b;background:#ffffff">
			<h1 style="font-size:22px;font-weight:700;margin-bottom:28px;color:#4f46e5">AILedger</h1>
			${bodies[day]}
			<a href="${dashboardLink}" style="display:inline-block;padding:14px 28px;background:#4f46e5;color:#ffffff;font-weight:600;font-size:14px;border-radius:8px;text-decoration:none">
				Go to dashboard →
			</a>
			<p style="font-size:12px;color:#94a3b8;margin-top:48px;border-top:1px solid #e2e8f0;padding-top:16px;line-height:1.6">
				AILedger · ailedger.dev<br/>
				You're receiving this because you signed up for AILedger. <a href="https://dash.ailedger.dev" style="color:#94a3b8">Unsubscribe</a>
			</p>
		</div>
	`;

	const res = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			from: 'AILedger <team@ailedger.dev>',
			to,
			subject: subjects[day],
			html,
		}),
	});
	if (!res.ok) {
		console.error(`Drip email error: ${res.status}`, await res.text());
	}
}

async function logInference({
	env,
	provider,
	method,
	path,
	requestBody,
	responseBody,
	statusCode,
	latencyMs,
	startedAt,
	completedAt,
	customerId,
	systemId,
}: {
	env: Env;
	provider: string;
	method: string;
	path: string;
	requestBody: ArrayBuffer | null;
	responseBody: ArrayBuffer;
	statusCode: number;
	latencyMs: number;
	startedAt: string;
	completedAt: string;
	customerId: string;
	systemId: string | null;
}): Promise<void> {
	const [inputHash, outputHash] = await Promise.all([sha256hex(requestBody), sha256hex(responseBody)]);

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
		customer_id: customerId,
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
