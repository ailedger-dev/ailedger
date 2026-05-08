// Cloudflare Pages Function: proxy /api/* on the contractor's dash domain to
// the contractor-webui-api FastAPI via CF Tunnel. Browser talks to same-origin
// /api/* (no CORS, session cookies travel cleanly) while the tunnel terminates
// on a 1-level subdomain covered by Universal SSL.

interface Env {
  API_WORKER_URL?: string;
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
  const upstream = env.API_WORKER_URL;
  if (!upstream) {
    return new Response(
      JSON.stringify({ error: "api_worker_url_unset" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

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
