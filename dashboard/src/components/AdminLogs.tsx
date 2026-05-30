import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { formatDate, formatLocalTooltip } from '../formatDate'

interface AdminLog {
  id: number
  logged_at: string
  started_at: string | null
  completed_at: string | null
  customer_id: string
  provider: string
  model_name: string | null
  status_code: number
  latency_ms: number
  input_hash: string | null
  output_hash: string | null
  system_id: string | null
}

function shortHash(h: string | null) {
  return h ? h.slice(0, 12) + '...' : '-'
}

const STATUS_COLOR: Record<number, string> = {
  200: 'text-emerald-400',
  201: 'text-emerald-400',
}

function statusColor(code: number) {
  return STATUS_COLOR[code] ?? (code >= 400 ? 'text-red-400' : 'text-slate-400')
}

export default function AdminLogs() {
  const [logs, setLogs] = useState<AdminLog[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState(0)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const PAGE_SIZE = 50

  async function fetchLogs(pageNum: number) {
    setLoading(true)
    const from = pageNum * PAGE_SIZE
    const to = from + PAGE_SIZE - 1

    const { data, count } = await supabase
      .from('inference_logs')
      .select('*', { count: 'exact' })
      .order('logged_at', { ascending: false })
      .range(from, to)

    setLogs(data ?? [])
    setTotal(count ?? 0)
    setLoading(false)
  }

  useEffect(() => {
    fetchLogs(page)
  }, [page])

  useEffect(() => {
    if (!autoRefresh) return
    const interval = setInterval(() => fetchLogs(page), 5000)
    return () => clearInterval(interval)
  }, [page, autoRefresh])

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Admin - All Inference Logs</h2>
            <p className="text-slate-400 text-sm mt-0.5">{total.toLocaleString()} total records across all customers</p>
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-slate-400" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="rounded"
              />
              Auto-refresh
            </label>
            <button
              onClick={() => fetchLogs(page)}
              style={{ cursor: 'pointer' }}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs font-medium rounded-lg transition-colors"
            >Refresh</button>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-[#1a1d27]">
                <th className="text-left px-4 py-3 text-slate-400 font-medium">Time</th>
                <th className="text-left px-4 py-3 text-slate-400 font-medium">Customer</th>
                <th className="text-left px-4 py-3 text-slate-400 font-medium">Provider</th>
                <th className="text-left px-4 py-3 text-slate-400 font-medium">Model</th>
                <th className="text-left px-4 py-3 text-slate-400 font-medium">Status</th>
                <th className="text-left px-4 py-3 text-slate-400 font-medium">Latency</th>
                <th className="text-left px-4 py-3 text-slate-400 font-medium">Input hash</th>
                <th className="text-left px-4 py-3 text-slate-400 font-medium">Output hash</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-slate-500">Loading...</td></tr>
              ) : logs.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-slate-500">No logs yet.</td></tr>
              ) : logs.map((log) => (
                <tr key={log.id} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                  <td title={formatLocalTooltip(log.logged_at)} className="px-4 py-3 text-slate-400 whitespace-nowrap">{formatDate(log.logged_at)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">{log.customer_id.slice(0, 8)}...</td>
                  <td className="px-4 py-3 text-white capitalize">{log.provider}</td>
                  <td className="px-4 py-3 text-slate-300">{log.model_name ?? '-'}</td>
                  <td className={`px-4 py-3 font-mono font-medium ${statusColor(log.status_code)}`}>{log.status_code}</td>
                  <td className="px-4 py-3 text-slate-400">{log.latency_ms}ms</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">{shortHash(log.input_hash)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">{shortHash(log.output_hash)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-sm text-slate-500">Page {page + 1} of {totalPages}</span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              style={{ cursor: page === 0 ? 'default' : 'pointer' }}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-900 disabled:text-slate-600 text-slate-300 text-xs rounded-lg transition-colors"
            >Previous</button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              style={{ cursor: page >= totalPages - 1 ? 'default' : 'pointer' }}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-900 disabled:text-slate-600 text-slate-300 text-xs rounded-lg transition-colors"
            >Next</button>
          </div>
        </div>
      )}
    </div>
  )
}
