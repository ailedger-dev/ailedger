// Fetch wrappers for the desktop FastAPI (contractor-webui-api) via the
// per-contractor Cloudflare tunnel. Session cookies are first-party on the
// contractor's dash domain; the API subdomain (e.g., api.pasha.jvholdings.co)
// must be configured to accept CORS credentials from the dash origin.

import { config } from "../config";

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

export async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(`${config.apiBaseUrl}${path}`, {
    credentials: "include",
  });
  if (!r.ok) throw new Error(`api_${r.status}`);
  return (await r.json()) as T;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${config.apiBaseUrl}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(`api_${r.status}`);
  return (await r.json()) as T;
}

export const listInbox = () => apiGet<{ items: InboxEntry[] }>("/inbox");
export const readMessage = (id: string) => apiGet<{ name: string; html: string; subject: string; from: string; date: string }>(`/message/${encodeURIComponent(id)}`);
export const markRead = (id: string) => apiPost(`/read/${encodeURIComponent(id)}`);
export const listDocs = () => apiGet<{ items: DocEntry[] }>("/docs");
export const readDoc = (id: string) => apiGet<{ name: string; html: string; title: string }>(`/doc/${encodeURIComponent(id)}`);
export const apiHealth = () => apiGet<{ ok: boolean }>("/health");
