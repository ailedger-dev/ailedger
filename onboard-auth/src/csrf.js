// Double-submit CSRF:
//   - on first GET, set a non-httpOnly cookie `csrf` = random 32 bytes (base64url).
//   - every state-changing request (POST/PUT/DELETE) must send that value in the
//     `x-csrf-token` header. The worker verifies cookie === header.
//   - SameSite=Lax on the session cookie would already block most CSRF; double-submit
//     is belt-and-suspenders against downstream-project iframes and sub-domain issues.

import { base64url } from "./auth/session.js";

export async function issueCsrfCookie(existing) {
  if (existing) return { token: existing, setCookie: null };
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = base64url(bytes);
  const setCookie = `csrf=${token}; Path=/; Secure; SameSite=Lax; Max-Age=86400`;
  return { token, setCookie };
}

export function verifyCsrf(request) {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const m = /(?:^|;\s*)csrf=([^;]+)/.exec(cookieHeader);
  const cookie = m?.[1];
  const header = request.headers.get("x-csrf-token");
  if (!cookie || !header) return false;
  // Constant-time compare.
  if (cookie.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < cookie.length; i++) diff |= cookie.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

export function csrfFailResponse() {
  return new Response(JSON.stringify({ error: "csrf_invalid" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}
