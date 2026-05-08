import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { readDoc } from "../lib/api";

export default function DocView() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<{ name: string; html: string; title: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    readDoc(id)
      .then((r) => !cancelled && setData(r))
      .catch((e: Error) => !cancelled && setErr(e.message));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (err) {
    return (
      <div className="p-8">
        <Link to="/app/docs" className="text-sm text-blue-400 flex items-center gap-1 mb-4">
          <ArrowLeft className="w-3 h-3" /> Reading room
        </Link>
        <p className="text-sm text-rose-400">{err}</p>
      </div>
    );
  }
  if (!data) return <div className="p-8 text-zinc-500 text-sm">Loading…</div>;

  return (
    <div className="h-full overflow-auto">
      <div className="px-8 py-4 border-b border-zinc-800 sticky top-0 bg-zinc-950">
        <Link to="/app/docs" className="text-sm text-blue-400 flex items-center gap-1 mb-2">
          <ArrowLeft className="w-3 h-3" /> Reading room
        </Link>
        <h2 className="text-lg font-semibold">{data.title}</h2>
      </div>
      <article
        className="prose-md px-8 py-6 max-w-3xl"
        dangerouslySetInnerHTML={{ __html: data.html }}
      />
    </div>
  );
}
