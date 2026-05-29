import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'
import UpgradeModal from './UpgradeModal'
import ChainIntegrityPanel from './ChainIntegrityPanel'
import LogDetailDrawer from './LogDetailDrawer'

const PLAN_LIMITS: Record<string, number | null> = {
  free: 10_000,
  pro: 500_000,
  scale: null,
}

function getPlanTier(plan: string | null | undefined): 'free' | 'pro' | 'scale' {
  if (!plan) return 'free'
  if (plan.startsWith('pro')) return 'pro'
  if (plan.startsWith('scale')) return 'scale'
  return 'free'
}

interface LogEntry {
  id: number
  logged_at: string
  started_at: string | null
  completed_at: string | null
  provider: string
  model_name: string | null
  path: string
  input_hash: string | null
  output_hash: string | null
  chain_prev_hash: string | null
  status_code: number
  latency_ms: number
  system_id: string | null
}

interface AiSystem {
  id: string
  system_name: string
}

const STATUS_COLOR: Record<number, string> = {
  200: 'text-emerald-400',
  201: 'text-emerald-400',
}

function statusColor(code: number) {
  return STATUS_COLOR[code] ?? (code >= 400 ? 'text-red-400' : 'text-yellow-400')
}

function shortHash(hash: string | null) {
  return hash ? hash.slice(0, 8) + '...' : '-'
}

function formatDate(iso: string) {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

// Mirrors the canonical UTC format (YYYY-MM-DD HH:MM:SS) in the viewer's
// timezone for the hover tooltip. en-CA + h23 keeps it symmetric so operators
// can compare directly. UTC remains the source of truth in the cell text.
function formatLocalTooltip(iso: string) {
  const formatted = new Date(iso).toLocaleString('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  })
  return 'Local: ' + formatted.replace(',', '')
}

// Position within the chain. Visible logs are the most-recent N rows ordered
// by logged_at DESC; the chain orders by id ASC. We approximate by assuming
// the newest visible chained row is at position chainRowCount, the next is
// chainRowCount-1, etc. Legacy rows (chain_prev_hash null) are skipped.
function computeChainPosition(log: LogEntry, allLogs: LogEntry[], chainRowCount: number): number | null {
  if (log.chain_prev_hash === null) return null
  if (chainRowCount === 0) return null
  let position = chainRowCount
  for (const candidate of allLogs) {
    if (candidate.chain_prev_hash === null) continue
    if (candidate.id === log.id) return position
    position -= 1
  }
  return null
}

export default function LogTable({ customerId, onUpgrade }: { customerId: string; onUpgrade: () => void }) {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [systems, setSystems] = useState<AiSystem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [total, setTotal] = useState(0)
  const [monthlyCount, setMonthlyCount] = useState(0)
  const [planTier, setPlanTier] = useState<'free' | 'pro' | 'scale'>('free')
  const [showUpgradeModal, setShowUpgradeModal] = useState(false)
  const [lastInsertAt, setLastInsertAt] = useState<string | null>(null)
  const [chainRowCount, setChainRowCount] = useState<number>(0)
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null)
  // Freeze-on-scroll: once the user scrolls past the first viewport, new
  // realtime INSERT rows accumulate in `pendingLogs` instead of prepending.
  // Scrolling back to the top flushes pendingLogs into logs. Counters
  // (total, monthlyCount, lastInsertAt) keep updating regardless.
  const [frozen, setFrozen] = useState(false)
  const [pendingLogs, setPendingLogs] = useState<LogEntry[]>([])
  const frozenRef = useRef(false)
  frozenRef.current = frozen
  const PAGE = 250
  const sentinelRef = useRef<HTMLTableRowElement | null>(null)
  // Ref mirror of logs so fetchMore can read the latest tail without re-binding
  // the IntersectionObserver every render.
  const logsRef = useRef<LogEntry[]>([])
  logsRef.current = logs
  const loadingMoreRef = useRef(false)
  loadingMoreRef.current = loadingMore
  const hasMoreRef = useRef(true)
  hasMoreRef.current = hasMore

  useEffect(() => {
    supabase
      .from('account_settings')
      .select('id, system_name')
      .eq('customer_id', customerId)
      .then(({ data }) => setSystems(data ?? []))
  }, [customerId])

  useEffect(() => {
    async function fetchUsage() {
      const [subResult, countResult] = await Promise.all([
        supabase.from('subscriptions').select('status, plan').maybeSingle(),
        supabase
          .from('inference_logs')
          .select('*', { count: 'exact', head: true })
          .eq('customer_id', customerId)
          .gte('logged_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()),
      ])
      const activePlan = subResult.data?.status === 'active' ? subResult.data.plan : null
      setPlanTier(getPlanTier(activePlan))
      setMonthlyCount(countResult.count ?? 0)
    }
    fetchUsage()
  }, [customerId])

  useEffect(() => {
    // Reset paging state when the customer changes
    setLogs([])
    setHasMore(true)
    setLoading(true)

    async function fetchInitial() {
      const { data, count, error } = await supabase
        .from('inference_logs')
        .select('*', { count: 'exact' })
        .eq('customer_id', customerId)
        .order('id', { ascending: false })
        .limit(PAGE)

      if (!error && data) {
        setLogs(data)
        setTotal(count ?? 0)
        setHasMore(data.length === PAGE)
      }
      setLoading(false)
    }

    fetchInitial()

    // Live updates - subscribe to new rows for this customer. New rows prepend;
    // we no longer slice the tail, so infinite scroll keeps the full window.
    const channel = supabase
      .channel('inference_logs')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'ledger',
        table: 'inference_logs',
        filter: `customer_id=eq.${customerId}`,
      }, (payload) => {
        const row = payload.new as LogEntry
        if (frozenRef.current) {
          // User is browsing history — buffer the new row; don't disrupt
          // their scroll position by prepending.
          setPendingLogs((prev) => (prev.some((r) => r.id === row.id) ? prev : [row, ...prev]))
        } else {
          setLogs((prev) => (prev.some((r) => r.id === row.id) ? prev : [row, ...prev]))
        }
        setTotal((t) => t + 1)
        setLastInsertAt(new Date().toISOString())
        setMonthlyCount((m) => m + 1)
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [customerId])

  // Scroll watcher — set `frozen` true once the user has scrolled past
  // the first viewport, false when they return near the top. We use the
  // window scrollY because the table is rendered in the page flow, not
  // inside a fixed-height scroll container.
  useEffect(() => {
    const FREEZE_AT = 200    // px below top — start buffering
    const UNFREEZE_AT = 50   // px below top — flush buffer
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const y = window.scrollY
        setFrozen((current) => (current ? y > UNFREEZE_AT : y > FREEZE_AT))
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  // When unfrozen, flush any pending realtime rows back into the visible
  // log list.
  useEffect(() => {
    if (frozen) return
    if (pendingLogs.length === 0) return
    setLogs((prev) => {
      const known = new Set(prev.map((r) => r.id))
      const toAdd = pendingLogs.filter((r) => !known.has(r.id))
      return toAdd.length > 0 ? [...toAdd, ...prev] : prev
    })
    setPendingLogs([])
  }, [frozen, pendingLogs])

  // Cursor pagination — load older rows when the sentinel scrolls into view.
  useEffect(() => {
    async function fetchMore() {
      const current = logsRef.current
      if (loadingMoreRef.current || !hasMoreRef.current || current.length === 0) return
      loadingMoreRef.current = true
      setLoadingMore(true)
      const lastId = current[current.length - 1].id
      const { data, error } = await supabase
        .from('inference_logs')
        .select('*')
        .eq('customer_id', customerId)
        .lt('id', lastId)
        .order('id', { ascending: false })
        .limit(PAGE)
      if (!error && data) {
        // Dedup in case a realtime INSERT landed a row inside the fetched range
        setLogs((prev) => {
          const seen = new Set(prev.map((r) => r.id))
          const merged = [...prev, ...data.filter((r) => !seen.has(r.id))]
          return merged
        })
        if (data.length < PAGE) setHasMore(false)
      }
      setLoadingMore(false)
      loadingMoreRef.current = false
    }

    const node = sentinelRef.current
    if (!node) return
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) fetchMore()
    }, { rootMargin: '400px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [customerId, loading])

  const limit = PLAN_LIMITS[planTier]
  const pct = limit ? Math.min((monthlyCount / limit) * 100, 100) : 0
  const atLimit = limit !== null && monthlyCount >= limit
  const nearLimit = limit !== null && monthlyCount >= limit * 0.85

  // Hide the System column entirely when no visible log row has a system
  // assigned. Tenants that never call POST /v1/systems (e.g. the
  // vernier-internal sidecar) shouldn't see a column full of blanks.
  // Re-evaluated each render so the column reappears as soon as a
  // system-tagged row arrives.
  const showSystemColumn = logs.some((l) => l.system_id !== null)
  const colSpan = showSystemColumn ? 9 : 8

  return (
    <div>
      {/* Floating "N new logs ↑" pill, visible only while scrolled past the
          freeze threshold AND new rows have buffered. Click smooth-scrolls
          to top, which fires the unfreeze + flush. */}
      {frozen && pendingLogs.length > 0 && (
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          style={{ cursor: 'pointer' }}
          className="fixed left-1/2 -translate-x-1/2 top-4 z-50 px-3 py-1.5 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium shadow-lg"
          aria-live="polite"
        >
          ↑ {pendingLogs.length} new log{pendingLogs.length === 1 ? '' : 's'}
        </button>
      )}
      {showUpgradeModal && (
        <UpgradeModal
          feature="usage"
          onClose={() => setShowUpgradeModal(false)}
          onUpgrade={() => { setShowUpgradeModal(false); onUpgrade() }}
        />
      )}

      {/* Chain integrity — surfaces the load-bearing audit-chain structure */}
      <ChainIntegrityPanel
        customerId={customerId}
        lastInsertAt={lastInsertAt}
        onHeadUpdate={(h) => setChainRowCount(h.row_count)}
      />

      <LogDetailDrawer
        log={selectedLog}
        systemName={selectedLog?.system_id ? (systems.find((s) => s.id === selectedLog.system_id)?.system_name ?? null) : null}
        chainPosition={selectedLog && selectedLog.chain_prev_hash !== null ? computeChainPosition(selectedLog, logs, chainRowCount) : null}
        onClose={() => setSelectedLog(null)}
      />

      {/* Usage bar */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-medium text-slate-400">Inferences this month</span>
          <span className={`text-xs font-medium ${atLimit ? 'text-red-400' : nearLimit ? 'text-yellow-400' : 'text-slate-500'}`}>
            {planTier === 'scale'
              ? `${monthlyCount.toLocaleString()} / unlimited`
              : `${monthlyCount.toLocaleString()} / ${limit?.toLocaleString()}`}
          </span>
        </div>
        <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${atLimit ? 'bg-red-500' : nearLimit ? 'bg-yellow-500' : planTier === 'scale' ? 'bg-indigo-500/40' : 'bg-indigo-500'}`}
            style={{ width: planTier === 'scale' ? '100%' : `${pct}%` }}
          />
        </div>
        {atLimit && (
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-red-400">Limit reached - new inferences are paused.</span>
            <button onClick={() => setShowUpgradeModal(true)} style={{ cursor: 'pointer' }} className="text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 px-3 py-1 rounded-lg transition-colors">Upgrade</button>
          </div>
        )}
        {nearLimit && !atLimit && (
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-yellow-400">Approaching limit - upgrade to avoid interruption.</span>
            <button onClick={() => setShowUpgradeModal(true)} style={{ cursor: 'pointer' }} className="text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 px-3 py-1 rounded-lg transition-colors">Upgrade</button>
          </div>
        )}
        {planTier === 'free' && !nearLimit && (
          <p className="mt-1 text-xs text-slate-600">Free plan · 10,000 inferences/mo · <button onClick={() => setShowUpgradeModal(true)} style={{ cursor: 'pointer' }} className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2">Upgrade for more</button></p>
        )}
      </div>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-white">Inference Logs</h2>
          <p className="text-slate-400 text-sm mt-0.5">{total.toLocaleString()} total records</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
            <span className="w-[7px] h-[7px] rounded-full bg-emerald-400 animate-pulse" />
            Live
          </span>
        </div>
      </div>

      <div className="rounded-xl border border-slate-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-[#1a1d27]">
                <th className="text-left px-4 py-3 text-slate-400 font-medium">#</th>
                <th className="text-left px-4 py-3 text-slate-400 font-medium">Time</th>
                {showSystemColumn && <th className="text-left px-4 py-3 text-slate-400 font-medium">System</th>}
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
                <tr>
                  <td colSpan={colSpan} className="px-4 py-12 text-center text-slate-500">
                    Loading...
                  </td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={colSpan} className="px-4 py-12 text-center text-slate-500">
                    No logs yet. Point your AI calls through the proxy to start recording.
                  </td>
                </tr>
              ) : (
                <>
                  {logs.map((log) => {
                    const position = computeChainPosition(log, logs, chainRowCount)
                    return (
                      <tr
                        key={log.id}
                        onClick={() => setSelectedLog(log)}
                        style={{ cursor: 'pointer' }}
                        className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors"
                      >
                        <td className="px-4 py-3 font-mono text-xs text-slate-500 whitespace-nowrap">
                          {position !== null ? `#${position}` : '–'}
                        </td>
                        <td title={formatLocalTooltip(log.logged_at)} className="px-4 py-3 text-slate-400 whitespace-nowrap">{formatDate(log.logged_at)}</td>
                        {showSystemColumn && (
                          <td className="px-4 py-3 text-sm">
                            {log.system_id ? (
                              <span className="text-slate-300">
                                {systems.find((s) => s.id === log.system_id)?.system_name ?? '-'}
                              </span>
                            ) : (
                              <span className="text-slate-600">—</span>
                            )}
                          </td>
                        )}
                        <td className="px-4 py-3 text-white capitalize">{log.provider}</td>
                        <td className="px-4 py-3 text-slate-300">{log.model_name ?? '-'}</td>
                        <td className={`px-4 py-3 font-mono font-medium ${statusColor(log.status_code)}`}>{log.status_code}</td>
                        <td className="px-4 py-3 text-slate-400">{log.latency_ms}ms</td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-500">{shortHash(log.input_hash)}</td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-500">{shortHash(log.output_hash)}</td>
                      </tr>
                    )
                  })}
                  <tr ref={sentinelRef} aria-hidden="true">
                    <td colSpan={colSpan} className="px-4 py-3 text-center text-xs text-slate-500">
                      {loadingMore
                        ? 'Loading more...'
                        : hasMore
                        ? `Scroll to load more (${logs.length.toLocaleString()} of ${total.toLocaleString()})`
                        : `End of logs · ${logs.length.toLocaleString()} shown`}
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
