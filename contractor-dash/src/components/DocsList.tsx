import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BookOpen, CircleAlert } from "lucide-react";
import { listDocs, type DocEntry } from "../lib/api";

export default function DocsList() {
  const [items, setItems] = useState<DocEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listDocs()
      .then((r) => !cancelled && setItems(r.items))
      .catch((e: Error) => !cancelled && setErr(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  if (err) {
    return (
      <div className="p-8">
        <div className="flex items-center gap-2 text-amber-400 mb-2">
          <CircleAlert className="w-4 h-4" />
          <h2 className="font-semibold">Reading room unavailable</h2>
        </div>
        <p className="text-sm text-zinc-400">{err}</p>
      </div>
    );
  }
  if (items === null) return <div className="p-8 text-zinc-500 text-sm">Loading…</div>;
  if (items.length === 0) {
    return (
      <div className="p-8 text-zinc-500 text-sm flex items-center gap-2">
        <BookOpen className="w-4 h-4" /> Nothing here yet.
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto">
      <div className="px-6 py-4 border-b border-zinc-800 sticky top-0 bg-zinc-950">
        <h2 className="text-lg font-semibold">Reading room</h2>
      </div>
      <ul>
        {items.map((d) => (
          <li key={d.id}>
            <Link
              to={`/app/docs/${encodeURIComponent(d.id)}`}
              className="flex items-center gap-3 px-6 py-3 border-b border-zinc-900 hover:bg-zinc-900"
            >
              <BookOpen className="w-4 h-4 text-zinc-500" />
              <div className="flex-1 truncate">{d.title}</div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
