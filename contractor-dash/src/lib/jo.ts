// Jo chat client — talks to the desktop FastAPI via the CF tunnel.
//
// The /jo/session/:id/stream endpoint is SSE. EventSource can't send cookies
// cross-origin credentials-true in all browsers; we use fetch+ReadableStream
// with `credentials: "include"` to keep the session cookie attached.

import { config } from "../config";
import { refreshSessionShared } from "./auth";

// Shared singleton — see auth.ts. Two-module duplication caused concurrent
// refresh races that dropped session mid-conversation.
const _refreshOnce = refreshSessionShared;

async function _fetchWithRefresh(input: string, init: RequestInit): Promise<Response> {
  const first = await fetch(input, init);
  if (first.status !== 401) return first;
  const ok = await _refreshOnce();
  if (ok) return fetch(input, init);
  if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    window.location.assign("/login");
  }
  return first;
}

export interface JoSession {
  id: string;
  created_at: number;
  last_active_at: number;
  status: "active" | "idle" | "closed";
}

export async function createJoSession(): Promise<JoSession> {
  const r = await _fetchWithRefresh(`${config.apiBaseUrl}/jo/session`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!r.ok) throw new Error(r.status === 401 ? "session_expired" : `jo_create_${r.status}`);
  return (await r.json()) as JoSession;
}

export async function listJoSessions(): Promise<JoSession[]> {
  const r = await _fetchWithRefresh(`${config.apiBaseUrl}/jo/sessions`, { credentials: "include" });
  if (!r.ok) throw new Error(r.status === 401 ? "session_expired" : `jo_list_${r.status}`);
  const j = (await r.json()) as { items: JoSession[] };
  return j.items;
}

export async function sendJoMessage(sessionId: string, text: string): Promise<void> {
  const r = await _fetchWithRefresh(`${config.apiBaseUrl}/jo/session/${encodeURIComponent(sessionId)}/send`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(r.status === 401 ? "session_expired" : `jo_send_${r.status}`);
}

export async function closeJoSession(sessionId: string): Promise<void> {
  await _fetchWithRefresh(`${config.apiBaseUrl}/jo/session/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    credentials: "include",
  });
}

export async function getJoNotificationsCount(): Promise<number> {
  const r = await _fetchWithRefresh(`${config.apiBaseUrl}/jo/notifications/count`, {
    credentials: "include",
  });
  if (!r.ok) return 0;
  const j = (await r.json()) as { count?: number };
  return typeof j.count === "number" ? j.count : 0;
}

export async function sendJoPing(to: string, text: string): Promise<void> {
  const r = await _fetchWithRefresh(`${config.apiBaseUrl}/jo/ping`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to, text }),
  });
  if (!r.ok) throw new Error(`jo_ping_${r.status}`);
}

export interface JoStreamHandlers {
  onChunk: (text: string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

export function streamJo(sessionId: string, handlers: JoStreamHandlers): { cancel: () => void } {
  const ctrl = new AbortController();

  (async () => {
    try {
      const r = await fetch(`${config.apiBaseUrl}/jo/session/${encodeURIComponent(sessionId)}/stream`, {
        credentials: "include",
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) {
        throw new Error(`jo_stream_${r.status}`);
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE parser: split on double newlines; each event is one block.
        let idx = buf.indexOf("\n\n");
        while (idx !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const parsed = parseSseBlock(raw);
          if (parsed.event === "chunk" && parsed.data) {
            handlers.onChunk(parsed.data);
          } else if (parsed.event === "done") {
            handlers.onDone();
            ctrl.abort();
            return;
          }
          idx = buf.indexOf("\n\n");
        }
      }
      handlers.onDone();
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      handlers.onError(err as Error);
    }
  })();

  return { cancel: () => ctrl.abort() };
}

function parseSseBlock(raw: string): { event: string; data: string } {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event: ")) event = line.slice(7).trim();
    else if (line.startsWith("data: ")) data.push(line.slice(6));
  }
  return { event, data: data.join("\n") };
}
