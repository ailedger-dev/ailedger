// Client-side auth helpers. All calls go to the Pages Function proxy at /auth/*.
//
// Session state: whether the user has a valid session JWT cookie. We don't
// read the JWT from JS (it's httpOnly) — we ask the auth worker via /auth/session.

import { AUTH_BASE } from "../config";

export interface SessionState {
  authenticated: boolean;
  userId?: string;
  email?: string;
  exp?: number;
}

function getCsrfToken(): string | null {
  const m = /(?:^|;\s*)csrf=([^;]+)/.exec(document.cookie || "");
  return m ? decodeURIComponent(m[1]) : null;
}

function csrfHeaders(): HeadersInit {
  const t = getCsrfToken();
  return t ? { "x-csrf-token": t } : {};
}

export async function fetchSession(): Promise<SessionState> {
  const r = await fetch(`${AUTH_BASE}/session`, { credentials: "include" });
  if (!r.ok) return { authenticated: false };
  return (await r.json()) as SessionState;
}

export async function logout(): Promise<void> {
  await fetch(`${AUTH_BASE}/logout`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", ...csrfHeaders() },
    body: "{}",
  });
}

export async function refreshSession(): Promise<boolean> {
  const r = await fetch(`${AUTH_BASE}/session/refresh`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", ...csrfHeaders() },
    body: "{}",
  });
  return r.ok;
}

export { csrfHeaders };
