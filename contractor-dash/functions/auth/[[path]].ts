// Cloudflare Pages Function: proxy /auth/* on the contractor's dash domain to
// the contractor-auth Worker. Having this proxy lets the auth cookies land on
// the SAME origin as the SPA — so `document.cookie` and fetch credentials work
// without cross-site cookie quirks.
//
// The upstream Worker URL is baked in at build time via the AUTH_WORKER_URL
// environment variable (set in the Pages project settings per contractor).

interface Env {
  AUTH_WORKER_URL?: string;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env, params } = context;
  const upstream = env.AUTH_WORKER_URL;
  if (!upstream) {
    return new Response(
      JSON.stringify({ error: "auth_worker_url_unset" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  // params.path is the matched [[path]] segments.
  const parts = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  const subPath = "/" + parts.join("/");
  const srcUrl = new URL(request.url);

  const upstreamUrl = new URL(upstream);
  upstreamUrl.pathname = subPath === "/" ? "/" : subPath;
  upstreamUrl.search = srcUrl.search;

  const fwdHeaders = new Headers();
  for (const [k, v] of request.headers.entries()) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    fwdHeaders.set(k, v);
  }
  // Pass the original client IP so the Worker's rate-limit sees real IPs.
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) fwdHeaders.set("x-forwarded-for", cf);

  const init: RequestInit = {
    method: request.method,
    headers: fwdHeaders,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  const upstreamResp = await fetch(upstreamUrl.toString(), init);

  // Forward body + headers. Set-Cookie passes through as-is: the Worker emits
  // cookies without a Domain attribute, so the browser scopes them to the
  // request origin (i.e., the contractor's dash domain). That's what we want.
  const respHeaders = new Headers();
  for (const [k, v] of upstreamResp.headers.entries()) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    respHeaders.append(k, v);
  }
  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    statusText: upstreamResp.statusText,
    headers: respHeaders,
  });
};
