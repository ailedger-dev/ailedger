import { useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { MessageSquareText } from "lucide-react";
import Sidebar from "../components/Sidebar";
import Inbox from "../components/Inbox";
import DocsList from "../components/DocsList";
import MessageView from "../components/MessageView";
import DocView from "../components/DocView";
import JoChat from "../components/JoChat";
import { config } from "../config";
import { apiHealth } from "../lib/api";
import type { SessionState } from "../lib/auth";

interface Props {
  session: SessionState;
  onLogout: () => void;
}

export default function Home({ session, onLogout }: Props) {
  const [apiUp, setApiUp] = useState<boolean | null>(null);
  const [joOpen, setJoOpen] = useState(false);

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
      if (e.key === "Escape" && joOpen) setJoOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [joOpen]);

  return (
    <div className="flex h-full">
      <Sidebar session={session} onLogout={onLogout} apiUp={apiUp} />
      <main className="flex-1 overflow-hidden bg-zinc-950 relative">
        <Routes>
          <Route index element={<InboxRoute />} />
          <Route path="inbox" element={<Inbox />} />
          <Route path="inbox/:id" element={<MessageView />} />
          <Route path="docs" element={<DocsList />} />
          <Route path="docs/:id" element={<DocView />} />
          <Route path="*" element={<Navigate replace to="" />} />
        </Routes>
        <button
          onClick={() => setJoOpen((v) => !v)}
          title="Jo chat (press j)"
          className="fixed right-6 bottom-6 h-12 w-12 rounded-full bg-blue-600 hover:bg-blue-500 shadow-lg flex items-center justify-center z-10"
        >
          <MessageSquareText className="w-5 h-5" />
        </button>
        <JoChat open={joOpen} onClose={() => setJoOpen(false)} />
      </main>
    </div>
  );
}

function InboxRoute() {
  // Default landing inside /app shows the hello-status stub alongside the inbox
  // once v1 lights up. For v0 we show a greeting and a link to start.
  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold">Hello {config.displayName}</h1>
      <p className="text-zinc-400 mt-2">Status: <span className="text-emerald-400 font-semibold">ACTIVE</span></p>
      <p className="text-zinc-500 text-sm mt-6">
        Your inbox and reading room will appear here once the desktop API is reachable.
      </p>
    </div>
  );
}
