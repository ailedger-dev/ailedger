// Fetch wrappers for the desktop FastAPI (contractor-webui-api) via the
// per-contractor Cloudflare tunnel. Session cookies are first-party on the
// contractor's dash domain.
//
// 401 auto-refresh: the access-token cookie has a short TTL (900s). The
// refresh-token cookie lives 1 week. On a 401 we call refreshSession() once
// and retry; if refresh fails the caller gets a `session_expired` error which
// App.tsx routes back to /login.

import { config } from "../config";
import { refreshSessionShared } from "./auth";

export interface InboxEntry {
  id: string;
  from: string;
  subject: string;
  date: string;
  unread: boolean;
  path: string;
}

export interface DocEntry {
  id: string;
  title: string;
  path: string;
}

// Shared 401-refresh dedupe lives in auth.ts (refreshSessionShared) so
// api.ts + jo.ts race against the SAME in-flight promise. Prior per-module
// dedupe allowed concurrent refresh calls, the second of which would hit
// the Worker with a just-rotated refresh token and fail → logout loop.
const _refreshOnce = refreshSessionShared;

async function _fetchWithRefresh(input: RequestInfo, init: RequestInit): Promise<Response> {
  const first = await fetch(input, init);
  if (first.status !== 401) return first;
  const ok = await _refreshOnce();
  if (ok) return fetch(input, init);
  // Refresh failed → permanent unauth. Send user back to /login unless we're
  // already there. `location.assign` is idempotent and safe here.
  if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    window.location.assign("/login");
  }
  return first;
}

export async function apiGet<T>(path: string): Promise<T> {
  const r = await _fetchWithRefresh(`${config.apiBaseUrl}${path}`, {
    credentials: "include",
  });
  if (!r.ok) throw new Error(r.status === 401 ? "session_expired" : `api_${r.status}`);
  return (await r.json()) as T;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  };
  const r = await _fetchWithRefresh(`${config.apiBaseUrl}${path}`, init);
  if (!r.ok) throw new Error(r.status === 401 ? "session_expired" : `api_${r.status}`);
  // Some POSTs (markRead → 204) return empty body; guard.
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const listInbox = () => apiGet<{ items: InboxEntry[] }>("/inbox");
export const readMessage = (id: string) => apiGet<{ name: string; html: string; subject: string; from: string; date: string }>(`/message/${encodeURIComponent(id)}`);
export const markRead = (id: string) => apiPost(`/read/${encodeURIComponent(id)}`);
export const listDocs = () => apiGet<{ items: DocEntry[] }>("/docs");
export const readDoc = (id: string) => apiGet<{ name: string; html: string; title: string }>(`/doc/${encodeURIComponent(id)}`);
export const apiHealth = () => apiGet<{ ok: boolean }>("/health");
