// Session & refresh token handling.
//
// Two tokens:
//   - session JWT: HS256, TTL 15 min, stateless, sent as `session` httpOnly cookie.
//                  Also verifiable by downstream projects with SESSION_JWT_SECRET.
//   - refresh token: opaque 32-byte random, stored HASHED in sessions table.
//                    Sent as `refresh` httpOnly cookie, Path=/session, rotated on every use.
//
// Downstream projects verify the session JWT themselves; they do NOT talk to this
// worker on every request. See README.md §Integration.

import jwt from "@tsndr/cloudflare-worker-jwt";

export function base64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return base64url(arr);
}

export async function sha256Hex(input) {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function issueSessionJwt({ secret, userId, email, projects, ttl }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: userId,
    email,
    projects: projects ?? [], // [{id, slug, role}]
    iat: now,
    exp: now + ttl,
    // aud / iss help downstream verifiers pin the token origin.
    iss: "onboard-auth",
  };
  return jwt.sign(payload, secret, { algorithm: "HS256" });
}

export async function verifySessionJwt(token, secret) {
  try {
    const valid = await jwt.verify(token, secret, { algorithm: "HS256" });
    if (!valid) return null;
    const { payload } = jwt.decode(token);
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(request) {
  const out = {};
  const raw = request.headers.get("cookie");
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = v;
  }
  return out;
}

export function sessionCookie(value, ttl) {
  // SameSite=Lax: balances CSRF protection with cross-site top-level redirects
  // from downstream project (user clicks link on sales.ailedger.dev, auth worker
  // verifies, redirects back — Lax allows the cookie through).
  // Domain is intentionally NOT set: the cookie stays scoped to the auth worker's
  // origin. Downstream projects receive a session JWT via a different mechanism
  // (URL fragment or postMessage) — see README §Integration.
  return `session=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttl}`;
}

export function refreshCookie(value, ttl) {
  // Path=/session narrows where the refresh cookie is ever sent.
  return `refresh=${value}; Path=/session; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttl}`;
}

export function clearAuthCookies() {
  return [
    "session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    "refresh=; Path=/session; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
  ];
}
