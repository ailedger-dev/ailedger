import { useEffect, useRef, useState } from "react";
import { MessageSquareText, Send, Loader2, RefreshCw, X, Maximize2, Minimize2 } from "lucide-react";
import { createJoSession, listJoSessions, sendJoMessage, streamJo, closeJoSession, type JoSession } from "../lib/jo";

interface Message {
  role: "user" | "jo";
  text: string;
  ts: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  userId: string;
}

// localStorage key for persisted chat messages. Scoped per user so a shared
// browser (devtools across users, unlikely in practice but still correct) or
// a user-change on the same device doesn't leak transcript. Trimmed to the
// last N messages to cap localStorage growth.
const MSG_CACHE_PREFIX = "jo_chat_messages_v1:";
const MSG_CACHE_MAX = 200;
// Separate key for scroll position — small, updated on every scroll, don't
// want to thrash the messages blob.
const SCROLL_CACHE_PREFIX = "jo_chat_scroll_v1:";

function loadScroll(userId: string): number {
  try {
    const raw = localStorage.getItem(SCROLL_CACHE_PREFIX + userId);
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

function saveScroll(userId: string, scrollTop: number): void {
  try {
    localStorage.setItem(SCROLL_CACHE_PREFIX + userId, String(Math.round(scrollTop)));
  } catch {
    /* ignore */
  }
}

function loadCachedMessages(userId: string): Message[] {
  try {
    const raw = localStorage.getItem(MSG_CACHE_PREFIX + userId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Message[];
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-MSG_CACHE_MAX);
  } catch {
    return [];
  }
}

function saveCachedMessages(userId: string, messages: Message[]): void {
  try {
    const trimmed = messages.slice(-MSG_CACHE_MAX);
    localStorage.setItem(MSG_CACHE_PREFIX + userId, JSON.stringify(trimmed));
  } catch {
    // quota exceeded / private mode — best-effort; drop silently
  }
}

const FULLSCREEN_KEY = "jo_chat_fullscreen_v1";

function loadFullscreen(): boolean {
  try {
    return localStorage.getItem(FULLSCREEN_KEY) === "1";
  } catch {
    return false;
  }
}

export default function JoChat({ open, onClose, userId }: Props) {
  const [session, setSession] = useState<JoSession | null>(null);
  const [messages, setMessages] = useState<Message[]>(() => loadCachedMessages(userId));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState<boolean>(() => loadFullscreen());
  const streamRef = useRef<{ cancel: () => void } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Persist full-screen toggle across reload.
  useEffect(() => {
    try {
      localStorage.setItem(FULLSCREEN_KEY, fullscreen ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [fullscreen]);

  // ESC exits full-screen (doesn't close the whole panel).
  useEffect(() => {
    if (!open || !fullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setFullscreen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, fullscreen]);

  // Persist messages to localStorage on every change so panel-toggle /
  // logout / reload doesn't lose visual history. The backend claude_sid
  // persistence handles the MODEL's memory; this handles the UI's memory.
  useEffect(() => {
    saveCachedMessages(userId, messages);
  }, [messages, userId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const sessions = await listJoSessions();
        if (cancelled) return;
        if (sessions.length > 0 && sessions[0].status === "active") {
          setSession(sessions[0]);
          openStream(sessions[0].id);
          return;
        }
        const fresh = await createJoSession();
        if (cancelled) return;
        setSession(fresh);
        openStream(fresh.id);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.cancel();
    };
  }, [open]);

  // Track whether the user is "pinned to bottom" (within 40px). If pinned,
  // new streamed chunks auto-scroll to bottom (classic chat). If scrolled up,
  // new chunks don't yank the viewport — the contractor stays where they are
  // reading. Ref, not state, to avoid re-render thrash on every scroll.
  const pinnedToBottomRef = useRef(true);
  const restoredScrollRef = useRef(false);

  // Restore prior scroll position once on panel-open, after layout settles.
  useEffect(() => {
    if (!open) {
      restoredScrollRef.current = false;
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    // rAF ensures layout has computed from the loaded messages.
    requestAnimationFrame(() => {
      if (restoredScrollRef.current) return;
      const saved = loadScroll(userId);
      if (saved > 0) {
        el.scrollTop = saved;
        // If restored position is near the bottom, stay in pinned mode.
        pinnedToBottomRef.current = el.scrollHeight - (el.scrollTop + el.clientHeight) < 40;
      } else {
        el.scrollTop = el.scrollHeight;
        pinnedToBottomRef.current = true;
      }
      restoredScrollRef.current = true;
    });
  }, [open, userId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !restoredScrollRef.current) return;
    if (pinnedToBottomRef.current) {
      // Use "auto" (instant) not "smooth" during streaming — smooth-scroll
      // stacking on every chunk creates the "racing/jumpy" feel Pasha
      // reported. Instant-to-bottom reads as natural chat.
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    // Pinned-to-bottom if within 40px of the end.
    const atBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) < 40;
    pinnedToBottomRef.current = atBottom;
    saveScroll(userId, el.scrollTop);
  }

  function openStream(sessionId: string) {
    streamRef.current?.cancel();
    streamRef.current = streamJo(sessionId, {
      onChunk: (chunk) => {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "jo") {
            return [...prev.slice(0, -1), { ...last, text: last.text + chunk }];
          }
          return [...prev, { role: "jo", text: chunk, ts: Date.now() }];
        });
      },
      onDone: () => {},
      onError: async (e) => {
        // Stale session id after FastAPI restart — silently recreate +
        // re-stream. claude_sid persistence makes this a no-op from the
        // contractor's perspective.
        if (e.message === "jo_stream_404") {
          try {
            const fresh = await createJoSession();
            setSession(fresh);
            openStream(fresh.id);
          } catch (e2) {
            setErr((e2 as Error).message);
          }
        } else {
          setErr(e.message);
        }
      },
    });
  }

  async function submit() {
    if (!session || !input.trim() || busy) return;
    const text = input.trim();
    setInput("");
    setBusy(true);
    setErr(null);
    setMessages((prev) => [...prev, { role: "user", text, ts: Date.now() }, { role: "jo", text: "", ts: Date.now() }]);
    try {
      await sendJoMessage(session.id, text);
    } catch (e) {
      const msg = (e as Error).message;
      // Server-side JoSession lives in FastAPI in-memory state. When the
      // FastAPI restarts (deploys, crashes, idle-reap past TTL) our local
      // session id 404s. Auto-recover: create a fresh session, reopen the
      // stream, retry the send. Claude --resume on the backend picks up
      // the same conversation transparently via the persisted claude_sid.
      if (msg === "jo_send_404") {
        try {
          const fresh = await createJoSession();
          setSession(fresh);
          openStream(fresh.id);
          await sendJoMessage(fresh.id, text);
          setErr(null);
        } catch (e2) {
          setErr((e2 as Error).message);
        }
      } else {
        setErr(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function newChat() {
    if (!session) return;
    streamRef.current?.cancel();
    try {
      await closeJoSession(session.id);
    } catch { /* ignore */ }
    // Clear both the visual history AND the backend claude_sid pointer so
    // this is a true fresh start — no recap, no prior memory.
    try {
      await fetch("/api/jo/reset-conversation", {
        method: "POST",
        credentials: "include",
      });
    } catch { /* best-effort */ }
    try {
      localStorage.removeItem(MSG_CACHE_PREFIX + userId);
      localStorage.removeItem(SCROLL_CACHE_PREFIX + userId);
    } catch { /* ignore */ }
    pinnedToBottomRef.current = true;
    restoredScrollRef.current = false;
    setMessages([]);
    setErr(null);
    const fresh = await createJoSession();
    setSession(fresh);
    openStream(fresh.id);
  }

  if (!open) return null;
  return (
    <aside
      style={fullscreen ? { background: "#18181b" } : undefined}
      className={
        fullscreen
          ? "fixed inset-0 shadow-2xl flex flex-col z-50"
          : "fixed right-0 top-0 bottom-0 w-full sm:w-[36rem] lg:w-[42rem] bg-zinc-900 border-l border-zinc-800 shadow-2xl flex flex-col z-20"
      }
    >
      <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <MessageSquareText className="w-4 h-4 text-blue-400" />
          <span className="text-sm font-semibold">Jo</span>
          {session && <span className="text-xs text-zinc-500 font-mono">#{session.id.slice(0, 8)}</span>}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setFullscreen((v) => !v)}
            title={fullscreen ? "Exit full-screen (Esc)" : "Full-screen"}
            aria-label={fullscreen ? "Exit full-screen" : "Full-screen"}
            className="p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded"
          >
            {fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          <button
            onClick={newChat}
            title="New chat"
            className="p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={onClose}
            title="Close panel"
            className="p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ overscrollBehavior: "contain" }}
        className={
          fullscreen
            ? "flex-1 overflow-y-auto"
            : "flex-1 overflow-y-auto p-4 space-y-4"
        }
      >
        <div className={fullscreen ? "max-w-[768px] mx-auto px-6 pt-12 pb-4 space-y-4" : ""}>
        {messages.length === 0 && (
          <div className="text-sm text-zinc-500">Ask Jo anything.</div>
        )}
        {messages.map((m, i) => {
          // Full-screen mode adopts a claude.ai-style register:
          //   - Jo messages: serif body, no bubble (just text on bg)
          //   - User messages: light-tint bubble, still visually distinct
          //   - Generous line-height + reading size
          // Sidebar mode keeps the existing compact bubble UI.
          if (fullscreen) {
            const isUser = m.role === "user";
            return (
              <div key={i} className={isUser ? "text-right" : ""}>
                <div
                  style={{
                    fontFamily: isUser
                      ? "'Styrene A', Inter, -apple-system, BlinkMacSystemFont, sans-serif"
                      : "'Tiempos', 'Copernicus', Georgia, 'Iowan Old Style', serif",
                    fontSize: 17,
                    lineHeight: 1.7,
                  }}
                  className={
                    isUser
                      ? "inline-block max-w-[85%] px-4 py-2.5 rounded-2xl whitespace-pre-wrap bg-indigo-500/15 text-zinc-100 border border-indigo-400/20"
                      : "block max-w-full px-1 py-1 whitespace-pre-wrap text-zinc-100"
                  }
                >
                  {m.text || <Loader2 className="w-3.5 h-3.5 animate-spin inline" />}
                </div>
              </div>
            );
          }
          return (
            <div key={i} className={m.role === "user" ? "text-right" : ""}>
              <div
                className={`inline-block max-w-[85%] px-3 py-2 rounded-lg text-sm whitespace-pre-wrap ${
                  m.role === "user" ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-100"
                }`}
              >
                {m.text || <Loader2 className="w-3.5 h-3.5 animate-spin inline" />}
              </div>
            </div>
          );
        })}
        {err && <p className="text-xs text-rose-400">{err}</p>}
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className={
          fullscreen
            ? "border-t border-zinc-800 py-3"
            : "border-t border-zinc-800 p-3 flex items-end gap-2"
        }
      >
        <div className={
          fullscreen
            ? "max-w-[768px] mx-auto px-6 flex items-end gap-2 w-full"
            : "contents"
        }>
        <textarea
          ref={(el) => {
            // Auto-grow: reset height then set to scrollHeight capped at 400px.
            if (!el) return;
            el.style.height = "auto";
            const next = Math.min(Math.max(el.scrollHeight, 120), 400);
            el.style.height = `${next}px`;
          }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message Jo…"
          style={{ minHeight: 120, maxHeight: 400 }}
          className="flex-1 resize-none px-4 py-3 bg-zinc-950 border border-zinc-800 rounded-md text-base leading-relaxed focus:outline-none focus:border-blue-500"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="p-2 bg-blue-600 hover:bg-blue-500 rounded-md disabled:opacity-50"
          title="Send (Enter)"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </button>
        </div>
      </form>
    </aside>
  );
}
