// onboard-auth worker entrypoint.
//
// Routes:
//   GET    /                              — serves login.html
//   POST   /register-passkey/options      — begin WebAuthn registration
//   POST   /register-passkey/verify       — finish WebAuthn registration (issues session)
//   POST   /login-passkey/options         — begin WebAuthn authentication
//   POST   /login-passkey/verify          — finish WebAuthn authentication (issues session)
//   POST   /magic-link/request            — email a magic link
//   POST   /magic-link/verify             — redeem a magic link (issues session)
//   GET    /session                       — introspect the current session JWT
//   POST   /session/refresh               — rotate refresh → new session JWT
//   POST   /logout                        — revoke refresh + clear cookies
//   POST   /admin/project/grant           — grant project membership (admin-only)
//   POST   /admin/project/revoke          — revoke project membership (admin-only)
//   GET    /.well-known/jwks.json         — (reserved; HS256 has no public key,
//                                            so this returns 404 for now. A future
//                                            RS256 migration would populate this.)
//
// Downstream projects verify session JWTs themselves using SESSION_JWT_SECRET.
// See README.md §Integration.

import {
  getUserById,
  getUserByEmail,
  listProjectsForUser,
  listPasskeysForUser,
  insertSession,
  getSessionByRefreshHash,
  rotateSession,
  revokeSession,
  userHasProjectRole,
  grantProjectMembership,
  revokeProjectMembership,
  getProjectBySlug,
  recordLogin,
  recordFailedAttempt,
  isLockedOut,
} from "./db.js";
import {
  base64url,
  randomToken,
  sha256Hex,
  issueSessionJwt,
  verifySessionJwt,
  parseCookies,
  sessionCookie,
  refreshCookie,
  clearAuthCookies,
} from "./auth/session.js";
import { beginRegistration, finishRegistration, beginLogin, finishLogin } from "./auth/passkey.js";
import { requestMagicLink, verifyMagicLink } from "./auth/magic.js";
import { checkIpLimit, checkAccountLimit, tooManyResponse } from "./ratelimit.js";
import { verifyCsrf, csrfFailResponse, issueCsrfCookie } from "./csrf.js";
import { audit } from "./audit.js";

const JSON_HEADERS = { "content-type": "application/json" };

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
  });
}

function security_headers() {
  // Applied to every response. CSP is tight: inline script/style only where the
  // login page needs it; no third-party origins.
  return {
    "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "publickey-credentials-get=(self), publickey-credentials-create=(self)",
    "cross-origin-opener-policy": "same-origin",
  };
}

function addHeaders(res, extra) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function appendSetCookie(res, cookie) {
  if (!cookie) return res;
  const headers = new Headers(res.headers);
  const arr = Array.isArray(cookie) ? cookie : [cookie];
  for (const c of arr) headers.append("set-cookie", c);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || null;
}

async function requireJson(request) {
  const ctype = request.headers.get("content-type") || "";
  if (!ctype.toLowerCase().includes("application/json")) {
    throw new Response(JSON.stringify({ error: "expected_json" }), { status: 415, headers: JSON_HEADERS });
  }
  try {
    return await request.json();
  } catch {
    throw new Response(JSON.stringify({ error: "invalid_json" }), { status: 400, headers: JSON_HEADERS });
  }
}

function parseAllowlist(env) {
  const raw = env.CONTRACTOR_ALLOWED_EMAILS || "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function isEmailAllowed(env, email) {
  if (!email) return false;
  const allowed = parseAllowlist(env);
  if (allowed.length === 0) return false;
  return allowed.includes(email.toLowerCase().trim());
}

async function userHasPasskey(db, userId) {
  const list = await listPasskeysForUser(db, userId);
  return Array.isArray(list) && list.length > 0;
}

async function issueSessionForUser({ env, userId, request }) {
  const user = await getUserById(env.DB, userId);
  if (!user) throw new Error("user_missing");
  const projects = await listProjectsForUser(env.DB, userId);
  const sessionTtl = Number(env.SESSION_TTL_SECONDS ?? 900);
  const refreshTtl = Number(env.REFRESH_TTL_SECONDS ?? 604800);
  const sessionJwt = await issueSessionJwt({
    secret: env.SESSION_JWT_SECRET,
    userId,
    email: user.email,
    projects: projects.map((p) => ({ id: p.id, slug: p.slug, role: p.role })),
    ttl: sessionTtl,
    contractorSlug: env.CONTRACTOR_SLUG,
  });
  const refresh = randomToken(32);
  const refreshHash = await sha256Hex(refresh);
  await insertSession(env.DB, {
    userId,
    refreshHash,
    ttlSeconds: refreshTtl,
    ip: clientIp(request),
    userAgent: request.headers.get("user-agent"),
  });
  await recordLogin(env.DB, userId);
  return {
    cookies: [sessionCookie(sessionJwt, sessionTtl), refreshCookie(refresh, refreshTtl)],
    user,
    projects,
  };
}

async function currentUser({ env, request }) {
  const cookies = parseCookies(request);
  const token = cookies.session;
  if (!token) return null;
  const payload = await verifySessionJwt(token, env.SESSION_JWT_SECRET);
  if (!payload) return null;
  return payload;
}

// ----- handlers -----

async function handleRoot(env) {
  // Login page — served from the bundled assets (see wrangler.jsonc if you wire
  // the public dir; for now we inline-fetch the static HTML via env.ASSETS or
  // fall back to a minimal page).
  try {
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(new Request("https://x/login.html"));
      if (res.ok) return res;
    }
  } catch {}
  return new Response(FALLBACK_LOGIN_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function handleRegisterOptions(request, env) {
  const body = await requireJson(request);
  const email = body.email;
  if (!email || typeof email !== "string") return json({ error: "email_required" }, { status: 400 });
  if (!isEmailAllowed(env, email)) {
    await audit(env.DB, {
      event: "register.denied.not_allowlisted",
      ip: clientIp(request),
      userAgent: request.headers.get("user-agent"),
      detail: { emailHash: await sha256Hex(email.toLowerCase().trim()) },
    });
    return json({ error: "email_not_allowed" }, { status: 403 });
  }
  const ip = clientIp(request);
  const ipLim = await checkIpLimit(env.AUTH_KV, ip);
  if (ipLim.exceeded) return tooManyResponse(ipLim);
  const acctLim = await checkAccountLimit(env.AUTH_KV, email.toLowerCase().trim());
  if (acctLim.exceeded) return tooManyResponse(acctLim);
  const { options, userId } = await beginRegistration({ env, email, displayName: body.displayName });
  await audit(env.DB, { event: "register.options", userId, ip, userAgent: request.headers.get("user-agent") });
  return json({ options, userId });
}

async function handleRegisterVerify(request, env) {
  const body = await requireJson(request);
  if (!body.userId || !body.response) return json({ error: "invalid_body" }, { status: 400 });
  const result = await finishRegistration({ env, userId: body.userId, response: body.response, deviceLabel: body.deviceLabel });
  const ip = clientIp(request);
  if (!result.ok) {
    await audit(env.DB, {
      event: "register.verify.fail",
      userId: body.userId,
      ip,
      userAgent: request.headers.get("user-agent"),
      detail: { reason: result.reason },
    });
    return json({ error: result.reason }, { status: 400 });
  }
  await audit(env.DB, { event: "register.verify.ok", userId: body.userId, ip, userAgent: request.headers.get("user-agent") });
  const { cookies } = await issueSessionForUser({ env, userId: body.userId, request });
  return appendSetCookie(json({ ok: true }), cookies);
}

async function handleLoginOptions(request, env) {
  const body = await requireJson(request);
  const ip = clientIp(request);
  const ipLim = await checkIpLimit(env.AUTH_KV, ip);
  if (ipLim.exceeded) return tooManyResponse(ipLim);
  if (body.email) {
    const acctLim = await checkAccountLimit(env.AUTH_KV, body.email.toLowerCase().trim());
    if (acctLim.exceeded) return tooManyResponse(acctLim);
  }
  const { options, handle } = await beginLogin({ env, email: body.email });
  await audit(env.DB, { event: "login.options", ip, userAgent: request.headers.get("user-agent"), detail: { hasEmail: !!body.email } });
  return json({ options, handle });
}

async function handleLoginVerify(request, env) {
  const body = await requireJson(request);
  if (!body.handle || !body.response) return json({ error: "invalid_body" }, { status: 400 });
  const ip = clientIp(request);
  const result = await finishLogin({ env, handle: body.handle, response: body.response });
  if (!result.ok) {
    await audit(env.DB, {
      event: "login.passkey.fail",
      ip,
      userAgent: request.headers.get("user-agent"),
      detail: { reason: result.reason },
    });
    return json({ error: result.reason }, { status: 401 });
  }
  const locked = await isLockedOut(env.DB, result.userId);
  if (locked) {
    await audit(env.DB, { event: "login.locked", userId: result.userId, ip });
    return json({ error: "account_locked" }, { status: 423 });
  }
  await audit(env.DB, { event: "login.passkey.ok", userId: result.userId, ip, userAgent: request.headers.get("user-agent") });
  const { cookies } = await issueSessionForUser({ env, userId: result.userId, request });
  return appendSetCookie(json({ ok: true }), cookies);
}

async function handleMagicRequest(request, env) {
  const body = await requireJson(request);
  if (!body.email || typeof body.email !== "string") return json({ error: "email_required" }, { status: 400 });
  if (!isEmailAllowed(env, body.email)) {
    await audit(env.DB, {
      event: "magic.denied.not_allowlisted",
      ip: clientIp(request),
      userAgent: request.headers.get("user-agent"),
      detail: { emailHash: await sha256Hex(body.email.toLowerCase().trim()) },
    });
    return json({ ok: true });
  }
  // Downgrade-attack prevention: once the user has any registered passkey,
  // magic-link is disabled. Enrolled users must use their passkey.
  const existing = await getUserByEmail(env.DB, body.email);
  if (existing && await userHasPasskey(env.DB, existing.id)) {
    await audit(env.DB, {
      event: "magic.denied.passkey_present",
      userId: existing.id,
      ip: clientIp(request),
      userAgent: request.headers.get("user-agent"),
    });
    // Identical success response shape — don't leak enrollment state.
    return json({ ok: true });
  }
  const ip = clientIp(request);
  const ipLim = await checkIpLimit(env.AUTH_KV, ip);
  if (ipLim.exceeded) return tooManyResponse(ipLim);
  const acctLim = await checkAccountLimit(env.AUTH_KV, body.email.toLowerCase().trim());
  if (acctLim.exceeded) return tooManyResponse(acctLim);
  try {
    await requestMagicLink({ env, email: body.email, ip });
    await audit(env.DB, {
      event: "magic.sent",
      ip,
      userAgent: request.headers.get("user-agent"),
      detail: { emailHash: await sha256Hex(body.email.toLowerCase().trim()) },
    });
  } catch (err) {
    await audit(env.DB, {
      event: "magic.send.fail",
      ip,
      userAgent: request.headers.get("user-agent"),
      detail: { reason: err?.message },
    });
    // Still respond 200 to avoid enumerating config failures to the caller.
  }
  // Identical response regardless of whether the email existed or delivery succeeded.
  return json({ ok: true });
}

async function handleMagicVerify(request, env) {
  const body = await requireJson(request);
  const ip = clientIp(request);
  const result = await verifyMagicLink({ env, token: body.token });
  if (!result.ok) {
    await audit(env.DB, { event: "magic.verify.fail", ip, userAgent: request.headers.get("user-agent"), detail: { reason: result.reason } });
    return json({ error: result.reason }, { status: 400 });
  }
  const locked = await isLockedOut(env.DB, result.userId);
  if (locked) {
    await audit(env.DB, { event: "login.locked", userId: result.userId, ip });
    return json({ error: "account_locked" }, { status: 423 });
  }
  await audit(env.DB, { event: "magic.verify.ok", userId: result.userId, ip, userAgent: request.headers.get("user-agent") });
  const { cookies } = await issueSessionForUser({ env, userId: result.userId, request });
  return appendSetCookie(json({ ok: true }), cookies);
}

async function handleSessionIntrospect(request, env) {
  const payload = await currentUser({ env, request });
  if (!payload) return json({ authenticated: false }, { status: 200 });
  return json({
    authenticated: true,
    userId: payload.sub,
    email: payload.email,
    projects: payload.projects,
    exp: payload.exp,
  });
}

async function handleSessionRefresh(request, env) {
  const cookies = parseCookies(request);
  const refresh = cookies.refresh;
  if (!refresh) return json({ error: "no_refresh" }, { status: 401 });
  const refreshHash = await sha256Hex(refresh);
  const row = await getSessionByRefreshHash(env.DB, refreshHash);
  if (!row) return json({ error: "invalid_refresh" }, { status: 401 });
  if (row.revoked_at) return json({ error: "revoked" }, { status: 401 });
  if (row.expires_at < Math.floor(Date.now() / 1000)) return json({ error: "expired" }, { status: 401 });
  // Rotate.
  const newRefresh = randomToken(32);
  const newHash = await sha256Hex(newRefresh);
  const refreshTtl = Number(env.REFRESH_TTL_SECONDS ?? 2592000);
  await rotateSession(env.DB, row.id, newHash, refreshTtl);
  const user = await getUserById(env.DB, row.user_id);
  const projects = await listProjectsForUser(env.DB, row.user_id);
  const sessionTtl = Number(env.SESSION_TTL_SECONDS ?? 900);
  const sessionJwt = await issueSessionJwt({
    secret: env.SESSION_JWT_SECRET,
    userId: row.user_id,
    email: user.email,
    projects: projects.map((p) => ({ id: p.id, slug: p.slug, role: p.role })),
    ttl: sessionTtl,
    contractorSlug: env.CONTRACTOR_SLUG,
  });
  await audit(env.DB, { event: "session.refresh", userId: row.user_id, ip: clientIp(request) });
  return appendSetCookie(json({ ok: true }), [
    sessionCookie(sessionJwt, sessionTtl),
    refreshCookie(newRefresh, refreshTtl),
  ]);
}

async function handleLogout(request, env) {
  const cookies = parseCookies(request);
  const refresh = cookies.refresh;
  if (refresh) {
    const refreshHash = await sha256Hex(refresh);
    const row = await getSessionByRefreshHash(env.DB, refreshHash);
    if (row) await revokeSession(env.DB, row.id);
  }
  const payload = await currentUser({ env, request });
  await audit(env.DB, { event: "logout", userId: payload?.sub, ip: clientIp(request) });
  return appendSetCookie(json({ ok: true }), clearAuthCookies());
}

// ----- admin -----
//
// Admin grants are authorized by EITHER:
//   (a) the caller's session JWT containing a project-membership with role
//       ∈ {owner, admin} for the target project — normal path once the first
//       admin exists, OR
//   (b) the ADMIN_BOOTSTRAP_TOKEN secret, used ONCE to plant the first owner.
//       After the first owner exists, operational procedure is to rotate the
//       secret to a placeholder value. Bootstrap exists because WebAuthn has
//       a chicken-and-egg: nobody has an account yet, so nobody can be admin.

async function handleAdminGrant(request, env) {
  const body = await requireJson(request);
  const { projectSlug, email, role } = body;
  if (!projectSlug || !email || !["owner", "admin", "member"].includes(role)) {
    return json({ error: "invalid_body" }, { status: 400 });
  }
  const project = await getProjectBySlug(env.DB, projectSlug);
  if (!project) return json({ error: "unknown_project" }, { status: 404 });

  const bootstrap = request.headers.get("x-admin-bootstrap");
  const payload = await currentUser({ env, request });
  const ip = clientIp(request);

  let grantedBy = null;

  if (bootstrap && env.ADMIN_BOOTSTRAP_TOKEN && constantEq(bootstrap, env.ADMIN_BOOTSTRAP_TOKEN)) {
    // Bootstrap path. Only permitted when the project has zero members.
    const existing = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?")
      .bind(project.id)
      .first();
    if ((existing?.n ?? 0) > 0) {
      return json({ error: "bootstrap_consumed" }, { status: 403 });
    }
    if (role !== "owner") {
      return json({ error: "bootstrap_must_be_owner" }, { status: 400 });
    }
    await audit(env.DB, {
      event: "admin.grant.bootstrap",
      ip,
      userAgent: request.headers.get("user-agent"),
      projectId: project.id,
      detail: { projectSlug, role },
    });
  } else {
    if (!payload) return json({ error: "unauthenticated" }, { status: 401 });
    const callerRole = await userHasProjectRole(env.DB, payload.sub, project.id, ["owner", "admin"]);
    if (!callerRole) return json({ error: "forbidden" }, { status: 403 });
    // Only owners may grant owner/admin.
    if (role !== "member" && callerRole !== "owner") {
      return json({ error: "owner_required_for_elevated_grant" }, { status: 403 });
    }
    grantedBy = payload.sub;
  }

  const target = await getUserByEmail(env.DB, email);
  if (!target) return json({ error: "unknown_user" }, { status: 404 });
  await grantProjectMembership(env.DB, { projectId: project.id, userId: target.id, role, grantedBy });
  await audit(env.DB, {
    event: "admin.grant.ok",
    userId: grantedBy,
    projectId: project.id,
    ip,
    userAgent: request.headers.get("user-agent"),
    detail: { targetUserId: target.id, role, projectSlug },
  });
  return json({ ok: true });
}

async function handleAdminRevoke(request, env) {
  const body = await requireJson(request);
  const { projectSlug, email } = body;
  if (!projectSlug || !email) return json({ error: "invalid_body" }, { status: 400 });
  const project = await getProjectBySlug(env.DB, projectSlug);
  if (!project) return json({ error: "unknown_project" }, { status: 404 });
  const payload = await currentUser({ env, request });
  if (!payload) return json({ error: "unauthenticated" }, { status: 401 });
  const callerRole = await userHasProjectRole(env.DB, payload.sub, project.id, ["owner", "admin"]);
  if (!callerRole) return json({ error: "forbidden" }, { status: 403 });
  const target = await getUserByEmail(env.DB, email);
  if (!target) return json({ error: "unknown_user" }, { status: 404 });
  const targetRole = await userHasProjectRole(env.DB, target.id, project.id, ["owner", "admin", "member"]);
  if (targetRole === "owner" && callerRole !== "owner") {
    return json({ error: "owner_required_to_revoke_owner" }, { status: 403 });
  }
  await revokeProjectMembership(env.DB, { projectId: project.id, userId: target.id });
  await audit(env.DB, {
    event: "admin.revoke.ok",
    userId: payload.sub,
    projectId: project.id,
    ip: clientIp(request),
    userAgent: request.headers.get("user-agent"),
    detail: { targetUserId: target.id, projectSlug },
  });
  return json({ ok: true });
}

function constantEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ----- fallback login page (tiny; full UI served from /public/login.html) -----

const FALLBACK_LOGIN_HTML = `<!doctype html><meta charset="utf-8"><title>Sign in</title>
<h1>onboard-auth</h1><p>The full login page should be served from <code>public/login.html</code>.</p>`;

// ----- router -----

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname;

    // Preflight.
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...security_headers(),
          "access-control-allow-origin": env.RP_ORIGIN,
          "access-control-allow-credentials": "true",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, x-csrf-token, x-admin-bootstrap",
        },
      });
    }

    // CSRF check for all state-changing requests EXCEPT the bootstrap/admin path
    // (which uses a header-token + is one-shot) and magic-link redemption from a
    // fresh browser (which comes in with no prior cookie). We gate CSRF on whether
    // a session cookie is present: if the user has a session, CSRF applies.
    if (method === "POST" || method === "PUT" || method === "DELETE") {
      const cookies = parseCookies(request);
      const hasSession = !!cookies.session;
      const isBootstrap = path === "/admin/project/grant" && request.headers.get("x-admin-bootstrap");
      if (hasSession && !isBootstrap && !verifyCsrf(request)) {
        return addHeaders(csrfFailResponse(), security_headers());
      }
    }

    let res;
    try {
      if (method === "GET" && (path === "/" || path === "/index.html")) {
        res = await handleRoot(env);
      } else if (method === "GET" && path === "/magic-link/land") {
        // Serves a tiny page that reads `#token=` and POSTs /magic-link/verify.
        res = new Response(MAGIC_LANDING_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      } else if (method === "POST" && path === "/register-passkey/options") {
        res = await handleRegisterOptions(request, env);
      } else if (method === "POST" && path === "/register-passkey/verify") {
        res = await handleRegisterVerify(request, env);
      } else if (method === "POST" && path === "/login-passkey/options") {
        res = await handleLoginOptions(request, env);
      } else if (method === "POST" && path === "/login-passkey/verify") {
        res = await handleLoginVerify(request, env);
      } else if (method === "POST" && path === "/magic-link/request") {
        res = await handleMagicRequest(request, env);
      } else if (method === "POST" && path === "/magic-link/verify") {
        res = await handleMagicVerify(request, env);
      } else if (method === "GET" && path === "/session") {
        res = await handleSessionIntrospect(request, env);
      } else if (method === "POST" && path === "/session/refresh") {
        res = await handleSessionRefresh(request, env);
      } else if (method === "POST" && path === "/logout") {
        res = await handleLogout(request, env);
      } else if (method === "POST" && path === "/admin/project/grant") {
        res = await handleAdminGrant(request, env);
      } else if (method === "POST" && path === "/admin/project/revoke") {
        res = await handleAdminRevoke(request, env);
      } else if (method === "GET" && path === "/health") {
        res = json({ ok: true });
      } else {
        res = json({ error: "not_found" }, { status: 404 });
      }
    } catch (err) {
      if (err instanceof Response) {
        res = err;
      } else {
        console.error("worker.error", err?.stack || err?.message);
        res = json({ error: "internal" }, { status: 500 });
      }
    }

    // Issue CSRF cookie on first visit if not present.
    const cookies = parseCookies(request);
    const csrf = await issueCsrfCookie(cookies.csrf);
    if (csrf.setCookie) res = appendSetCookie(res, csrf.setCookie);

    return addHeaders(res, security_headers());
  },
};

const MAGIC_LANDING_HTML = `<!doctype html>
<meta charset="utf-8"><title>Signing in…</title>
<p id="s">Signing in…</p>
<script>
(async () => {
  const h = location.hash.slice(1);
  const params = new URLSearchParams(h);
  const token = params.get("token");
  if (!token) { document.getElementById("s").textContent = "No token."; return; }
  const r = await fetch("/magic-link/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (r.ok) {
    const ret = sessionStorage.getItem("return") || "/";
    location.replace(ret);
  } else {
    const j = await r.json().catch(() => ({}));
    document.getElementById("s").textContent = "Sign-in failed: " + (j.error || r.status);
  }
})();
</script>`;
