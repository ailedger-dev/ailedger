import { useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { MessageSquareText, Menu } from "lucide-react";
import Sidebar from "../components/Sidebar";
import Inbox from "../components/Inbox";
import DocsList from "../components/DocsList";
import MessageView from "../components/MessageView";
import DocView from "../components/DocView";
import JoChat from "../components/JoChat";
import { config } from "../config";
import { apiHealth } from "../lib/api";
import { getJoNotificationsCount } from "../lib/jo";
import type { SessionState } from "../lib/auth";

interface Props {
  session: SessionState;
  onLogout: () => void;
}

export default function Home({ session, onLogout }: Props) {
  const [apiUp, setApiUp] = useState<boolean | null>(null);
  const [joOpen, setJoOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [notifCount, setNotifCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const n = await getJoNotificationsCount();
        if (!cancelled) setNotifCount(n);
      } catch {
        // ignore — best-effort
      }
    }
    poll();
    const id = setInterval(poll, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Opening Jo drains the notifications server-side on session create; clear
  // the dot immediately so the UI feels responsive, then let the next poll
  // confirm.
  useEffect(() => {
    if (joOpen && notifCount > 0) setNotifCount(0);
  }, [joOpen]);

  useEffect(() => {
    apiHealth()
      .then(() => setApiUp(true))
      .catch(() => setApiUp(false));
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (!typing && (e.key === "j" || e.key === "J")) {
        e.preventDefault();
        setJoOpen((v) => !v);
      }
      if (e.key === "Escape") {
        if (joOpen) setJoOpen(false);
        else if (navOpen) setNavOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [joOpen, navOpen]);

  return (
    <div className="flex h-full">
      <Sidebar
        session={session}
        onLogout={onLogout}
        apiUp={apiUp}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />
      <main className="flex-1 overflow-hidden bg-zinc-950 relative">
        {/* Mobile top bar with hamburger */}
        <div className="md:hidden flex items-center gap-3 px-4 py-3 border-b border-zinc-800 bg-zinc-900">
          <button
            aria-label="Open navigation"
            onClick={() => setNavOpen(true)}
            className="p-1.5 text-zinc-300 hover:bg-zinc-800 rounded-md"
          >
            <Menu className="w-5 h-5" />
          </button>
          <span className="text-sm font-semibold">{config.displayName}</span>
        </div>
        <Routes>
          <Route index element={<InboxRoute />} />
          <Route path="inbox" element={<Inbox />} />
          <Route path="inbox/:id" element={<MessageView />} />
          <Route path="docs" element={<DocsList userId={session.userId ?? "anon"} />} />
          <Route path="docs/:id" element={<DocView />} />
          <Route path="*" element={<Navigate replace to="" />} />
        </Routes>
        <button
          onClick={() => setJoOpen((v) => !v)}
          title={notifCount > 0 ? `Jo chat (${notifCount} pending)` : "Jo chat (press j)"}
          aria-label={notifCount > 0 ? `Open Jo chat, ${notifCount} pending` : "Open Jo chat"}
          className="fixed right-4 bottom-4 md:right-6 md:bottom-6 h-12 w-12 rounded-full bg-blue-600 hover:bg-blue-500 shadow-lg flex items-center justify-center z-10"
        >
          <MessageSquareText className="w-5 h-5" />
          {notifCount > 0 && (
            <span
              aria-hidden="true"
              className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold leading-[18px] text-center shadow ring-2 ring-zinc-950"
            >
              {notifCount > 9 ? "9+" : notifCount}
            </span>
          )}
        </button>
        <JoChat
          open={joOpen}
          onClose={() => setJoOpen(false)}
          userId={session.userId ?? "anon"}
        />
      </main>
    </div>
  );
}

function InboxRoute() {
  return (
    <div className="p-6 md:p-8">
      <h1 className="text-2xl font-semibold">Hello {config.displayName}</h1>
      <p className="text-zinc-400 mt-2">Status: <span className="text-emerald-400 font-semibold">ACTIVE</span></p>
      <p className="text-zinc-500 text-sm mt-6">
        Your inbox and reading room will appear here once the desktop API is reachable.
      </p>
    </div>
  );
}
