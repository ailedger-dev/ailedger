import { useEffect, useRef, useState } from "react";
import { MessageSquareText, Send, Loader2, RefreshCw, X } from "lucide-react";
import { createJoSession, listJoSessions, sendJoMessage, streamJo, closeJoSession, type JoSession } from "../lib/jo";

interface Message {
  role: "user" | "jo";
  text: string;
  ts: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function JoChat({ open, onClose }: Props) {
  const [session, setSession] = useState<JoSession | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const streamRef = useRef<{ cancel: () => void } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

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
      onError: (e) => setErr(e.message),
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
      setErr((e as Error).message);
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
    setMessages([]);
    setErr(null);
    const fresh = await createJoSession();
    setSession(fresh);
    openStream(fresh.id);
  }

  if (!open) return null;
  return (
    <aside className="fixed right-0 top-0 bottom-0 w-[28rem] bg-zinc-900 border-l border-zinc-800 shadow-2xl flex flex-col z-20">
      <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <MessageSquareText className="w-4 h-4 text-blue-400" />
          <span className="text-sm font-semibold">Jo</span>
          {session && <span className="text-xs text-zinc-500 font-mono">#{session.id.slice(0, 8)}</span>}
        </div>
        <div className="flex items-center gap-1">
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

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-sm text-zinc-500">Ask Jo anything.</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : ""}>
            <div
              className={`inline-block max-w-[85%] px-3 py-2 rounded-lg text-sm whitespace-pre-wrap ${
                m.role === "user" ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-100"
              }`}
            >
              {m.text || <Loader2 className="w-3.5 h-3.5 animate-spin inline" />}
            </div>
          </div>
        ))}
        {err && <p className="text-xs text-rose-400">{err}</p>}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="border-t border-zinc-800 p-3 flex items-end gap-2"
      >
        <textarea
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message Jo…"
          className="flex-1 resize-none px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-md text-sm focus:outline-none focus:border-blue-500"
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
      </form>
    </aside>
  );
}
