import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Inbox as InboxIcon, CircleAlert } from "lucide-react";
import { listInbox, type InboxEntry } from "../lib/api";

export default function Inbox() {
  const [items, setItems] = useState<InboxEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listInbox()
      .then((r) => {
        if (!cancelled) setItems(r.items);
      })
      .catch((e: Error) => {
        if (!cancelled) setErr(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (err) {
    return (
      <div className="p-8">
        <div className="flex items-center gap-2 text-amber-400 mb-2">
          <CircleAlert className="w-4 h-4" />
          <h2 className="font-semibold">Inbox unavailable</h2>
        </div>
        <p className="text-sm text-zinc-400">The desktop API isn't reachable right now ({err}).</p>
      </div>
    );
  }
  if (items === null) {
    return <div className="p-8 text-zinc-500 text-sm">Loading inbox…</div>;
  }
  if (items.length === 0) {
    return (
      <div className="p-8 text-zinc-500 text-sm flex items-center gap-2">
        <InboxIcon className="w-4 h-4" /> No messages.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="px-6 py-4 border-b border-zinc-800 sticky top-0 bg-zinc-950">
        <h2 className="text-lg font-semibold">Inbox</h2>
      </div>
      <ul>
        {items.map((m) => (
          <li key={m.id}>
            <Link
              to={`/app/inbox/${encodeURIComponent(m.id)}`}
              className={`flex items-center gap-4 px-6 py-3 border-b border-zinc-900 hover:bg-zinc-900 ${
                m.unread ? "text-zinc-100" : "text-zinc-500"
              }`}
            >
              <div className={`w-2 h-2 rounded-full ${m.unread ? "bg-blue-500" : "bg-transparent"}`} />
              <div className="w-24 text-xs uppercase tracking-wider">{m.from}</div>
              <div className={`flex-1 truncate ${m.unread ? "font-semibold" : ""}`}>{m.subject}</div>
              <div className="text-xs text-zinc-600">{formatDate(m.date)}</div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}
