import { useEffect, useState } from 'react'
import { supabase } from '../supabase'

type ChainHead = {
  chain_head_hash: string | null
  last_id: number | null
  row_count: number
}

type VerifyChain = {
  ok: boolean
  broken_at_id: number | null
  expected_hash: string | null
  actual_hash: string | null
  chain_head_hash: string | null
  row_count: number
}

type Status = 'idle' | 'verifying' | 'verified-ok' | 'verified-broken' | 'stale' | 'error'

type ChainHealth = {
  customer_id: string
  last_verified_at: string | null
  last_status: 'ok' | 'broken' | 'never'
  last_row_count: number
  chain_head_hash: string | null
  broken_at_id: number | null
  expected_hash: string | null
  actual_hash: string | null
  last_alerted_at: string | null
}

const VERIFY_THROTTLE_MS = 60_000

function shortHash(hash: string | null | undefined, prefixLen = 8) {
  if (!hash) return '-'
  return hash.slice(0, prefixLen) + '…' + hash.slice(-4)
}

function formatRelative(iso: string | null) {
  if (!iso) return 'never'
  const d = new Date(iso)
  const sec = Math.floor((Date.now() - d.getTime()) / 1000)
  if (sec < 5) return 'just now'
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return d.toLocaleDateString()
}

export default function ChainIntegrityPanel({ customerId, lastInsertAt, onHeadUpdate }: {
  customerId: string
  lastInsertAt: string | null
  onHeadUpdate?: (head: ChainHead) => void
}) {
  const [head, setHead] = useState<ChainHead | null>(null)
  const [health, setHealth] = useState<ChainHealth | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [verifyResult, setVerifyResult] = useState<VerifyChain | null>(null)
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [copyFlash, setCopyFlash] = useState(false)
  const [throttleExpired, setThrottleExpired] = useState(true)

  // localStorage key — per-customer so cross-customer state doesn't leak.
  const lsKey = `ailedger:chain-verify:${customerId}`

  // Re-evaluate throttle every 5s so the Verify button re-enables in bounded time.
  // Done in an effect (not during render) to keep the component pure.
  useEffect(() => {
    const recompute = () => {
      if (verifiedAt === null) {
        setThrottleExpired(true)
        return
      }
      setThrottleExpired(Date.now() - new Date(verifiedAt).getTime() > VERIFY_THROTTLE_MS)
    }
    recompute()
    const interval = setInterval(recompute, 5_000)
    return () => clearInterval(interval)
  }, [verifiedAt])

  // Initial load: fetch the chain head only. Verification is manual-only
  // per Jake — users click "Verify" when they want a fresh integrity check.
  //
  // Hydrate the LAST verification result from localStorage so Verified-OK /
  // Verified-broken state survives a page refresh. If the chain has grown
  // since the last verify (current row_count > stored row_count), we
  // restore the result but mark it stale; the user has to re-click to
  // confirm against current state.
  useEffect(() => {
    let cancelled = false

    // Hydrate first so we have something to compare against the head.
    let hydrated: { verifyResult: VerifyChain; verifiedAt: string; rowCountAtVerify: number } | null = null
    try {
      const raw = localStorage.getItem(lsKey)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && parsed.verifyResult && parsed.verifiedAt && typeof parsed.rowCountAtVerify === 'number') {
          hydrated = parsed
          setVerifyResult(parsed.verifyResult)
          setVerifiedAt(parsed.verifiedAt)
          setStatus(parsed.verifyResult.ok ? 'verified-ok' : 'verified-broken')
        }
      }
    } catch {
      // localStorage unavailable or corrupted — silently ignore, start clean
    }

    async function loadHead() {
      const { data, error } = await supabase.rpc('chain_head', { p_customer_id: customerId })
      if (cancelled) return
      if (error) {
        setErrorMsg(error.message)
        setStatus('error')
        return
      }
      const headData = data as ChainHead
      setHead(headData)
      if (onHeadUpdate) onHeadUpdate(headData)

      // Read server-side chain_health (populated by the scheduled chain
      // monitor every cron tick). Surfaces last-known integrity status +
      // last-alerted-at without requiring the user to click Verify.
      const { data: healthRows } = await supabase
        .from('chain_health')
        .select('*')
        .eq('customer_id', customerId)
        .limit(1)
      if (cancelled) return
      const healthRow = healthRows?.[0] as ChainHealth | undefined
      if (healthRow) {
        setHealth(healthRow)
        // If server-side monitor saw broken AND we don't already have a
        // local manually-verified state, surface broken status from server.
        if (
          healthRow.last_status === 'broken' &&
          status !== 'verified-broken' &&
          status !== 'verified-ok'
        ) {
          setVerifyResult({
            ok: false,
            broken_at_id: healthRow.broken_at_id,
            expected_hash: healthRow.expected_hash,
            actual_hash: healthRow.actual_hash,
            chain_head_hash: healthRow.chain_head_hash,
            row_count: headData.row_count,
          })
          setVerifiedAt(healthRow.last_verified_at)
          setStatus('verified-broken')
        }
      }

      // Only auto-stale a previously verified-OK chain after rows have
      // been added. A previously verified-BROKEN chain must NEVER be
      // downgraded to "stale" on reload — a break is a load-bearing
      // finding that has to stay visible until the user explicitly
      // re-verifies. Anti-pattern caught by Jake 2026-05-08.
      if (
        hydrated &&
        hydrated.verifyResult.ok &&
        headData.row_count > hydrated.rowCountAtVerify
      ) {
        setStatus('stale')
      }
    }
    loadHead()
    return () => { cancelled = true }
  }, [customerId, onHeadUpdate, lsKey])

  // When a new row is inserted, refresh the head and mark existing
  // verification stale. Debounced 3s so a high-frequency insert burst
  // (e.g., the sidecar daemon shipping a backlog) doesn't fire one
  // chain_head fetch per row — it fires once after writes settle.
  useEffect(() => {
    if (!lastInsertAt) return
    let cancelled = false
    const t = setTimeout(async () => {
      const { data, error } = await supabase.rpc('chain_head', { p_customer_id: customerId })
      if (cancelled) return
      if (error) return
      const headData = data as ChainHead
      setHead(headData)
      if (onHeadUpdate) onHeadUpdate(headData)
      setStatus((prev) => (prev === 'verified-ok' || prev === 'verified-broken' ? 'stale' : prev))
    }, 3000)
    return () => { cancelled = true; clearTimeout(t) }
  }, [lastInsertAt, customerId, onHeadUpdate])

  const canVerify = status !== 'verifying' && throttleExpired

  const handleVerify = async () => {
    if (!canVerify) return
    setStatus('verifying')
    setErrorMsg(null)
    const { data, error } = await supabase.rpc('verify_chain', { p_customer_id: customerId })
    if (error) {
      setErrorMsg(error.message)
      setStatus('error')
      return
    }
    const result = data as VerifyChain
    const verifiedAtNow = new Date().toISOString()
    const rowCountAtVerify = result.row_count
    setVerifyResult(result)
    setVerifiedAt(verifiedAtNow)
    setStatus(result.ok ? 'verified-ok' : 'verified-broken')
    if (result.chain_head_hash) {
      const updated: ChainHead = {
        chain_head_hash: result.chain_head_hash,
        last_id: head?.last_id ?? null,
        row_count: result.row_count,
      }
      setHead(updated)
      if (onHeadUpdate) onHeadUpdate(updated)
    }
    // Persist so Verified-OK survives a page refresh.
    try {
      localStorage.setItem(
        lsKey,
        JSON.stringify({
          verifyResult: result,
          verifiedAt: verifiedAtNow,
          rowCountAtVerify,
        }),
      )
    } catch {
      /* localStorage quota / disabled — silently skip persistence */
    }
  }

  const handleCopy = async () => {
    if (!head?.chain_head_hash) return
    try {
      await navigator.clipboard.writeText(head.chain_head_hash)
      setCopyFlash(true)
      setTimeout(() => setCopyFlash(false), 1200)
    } catch {
      /* clipboard blocked; fail silently */
    }
  }

  const rowCount = head?.row_count ?? 0
  const empty = rowCount === 0

  return (
    <div className="mb-6 rounded-xl border border-slate-800 bg-[#1a1d27] p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-white">Chain Integrity</span>
          <StatusBadge status={status} />
          {health && health.last_status !== 'never' && (
            <span
              title={`Server-side cryptographic chain monitor — last verified ${formatRelative(health.last_verified_at)}`}
              className="text-[10px] font-medium text-emerald-400 bg-emerald-950/40 border border-emerald-800/60 rounded-full px-2 py-0.5"
            >
              ● 24/7 monitored
            </span>
          )}
        </div>
        <button
          onClick={handleVerify}
          disabled={!canVerify || empty}
          style={{ cursor: !canVerify || empty ? 'not-allowed' : 'pointer' }}
          className={`text-xs font-medium px-3 py-1 rounded-lg transition-colors ${
            !canVerify || empty
              ? 'bg-slate-800 text-slate-500'
              : 'bg-indigo-600 hover:bg-indigo-500 text-white'
          }`}
        >
          {status === 'verifying' ? 'Verifying…' : 'Verify chain'}
        </button>
      </div>

      {empty ? (
        <p className="text-xs text-slate-500">
          No chained records yet. Once your AI calls flow through the proxy, the chain begins automatically.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            <div>
              <div className="text-slate-500 mb-0.5">Chain head</div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-slate-300">{shortHash(head?.chain_head_hash)}</span>
                <button
                  onClick={handleCopy}
                  style={{ cursor: 'pointer' }}
                  className="text-slate-500 hover:text-slate-300 transition-colors"
                  title="Copy full hash"
                >
                  {copyFlash ? '✓' : '⎘'}
                </button>
              </div>
            </div>
            <div>
              <div className="text-slate-500 mb-0.5">Records chained</div>
              <div className="text-slate-300 font-medium">{rowCount.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-slate-500 mb-0.5">Last verified</div>
              <div className="text-slate-300">{formatRelative(verifiedAt)}</div>
            </div>
          </div>

          {status === 'verified-broken' && verifyResult && (
            <div className="mt-3 rounded-lg border border-red-900/50 bg-red-950/30 p-3">
              <div className="text-sm font-semibold text-red-400 mb-2">✗ Chain break detected</div>
              <div className="text-xs text-slate-300 space-y-1">
                <div>Broken at row id <span className="font-mono text-red-300">{verifyResult.broken_at_id}</span> (record #{verifyResult.row_count})</div>
                <div>
                  <span className="text-slate-500">Expected:</span>{' '}
                  <span className="font-mono text-slate-300">{shortHash(verifyResult.expected_hash, 12)}</span>
                </div>
                <div>
                  <span className="text-slate-500">Actual:</span>{' '}
                  <span className="font-mono text-red-300">{shortHash(verifyResult.actual_hash, 12)}</span>
                </div>
                <div className="mt-2 text-red-300">
                  The cryptographic chain has detected a row whose stored data no longer matches its locked-in predecessor hash. This is tamper-evidence working as designed: any change to a chained row breaks the hash linkage and surfaces here.
                </div>
                {health?.last_alerted_at && (
                  <div className="mt-2 text-amber-300">
                    Our team has been automatically notified ({formatRelative(health.last_alerted_at)}) and is investigating. You can also reach us at <a href="mailto:support@ailedger.dev" className="underline">support@ailedger.dev</a>.
                  </div>
                )}
                {!health?.last_alerted_at && (
                  <div className="mt-2 text-red-300">
                    Contact <a href="mailto:support@ailedger.dev" className="underline">support@ailedger.dev</a> for forensic analysis of the affected record.
                  </div>
                )}
              </div>
            </div>
          )}

          {status === 'stale' && (
            <div className="mt-3 text-xs text-yellow-400">
              New records inserted since last verify. Re-verify to refresh integrity status.
            </div>
          )}

          {status === 'error' && errorMsg && (
            <div className="mt-3 text-xs text-red-400">Verification error: {errorMsg}</div>
          )}
        </>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: Status }) {
  const config: Record<Status, { label: string; cls: string; dot?: string }> = {
    idle: { label: 'Not yet verified', cls: 'text-slate-500 border-slate-700', dot: 'bg-slate-500' },
    verifying: { label: 'Verifying…', cls: 'text-slate-300 border-slate-600', dot: 'bg-indigo-400 animate-pulse' },
    'verified-ok': { label: 'Verified', cls: 'text-emerald-400 border-emerald-900/60', dot: 'bg-emerald-400' },
    'verified-broken': { label: 'Break detected', cls: 'text-red-400 border-red-900/60', dot: 'bg-red-400' },
    stale: { label: 'Stale (new records)', cls: 'text-yellow-400 border-yellow-900/60', dot: 'bg-yellow-400' },
    error: { label: 'Error', cls: 'text-red-400 border-red-900/60', dot: 'bg-red-400' },
  }
  const c = config[status]
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full border ${c.cls}`}>
      {c.dot && <span className={`w-[6px] h-[6px] rounded-full ${c.dot}`} />}
      {c.label}
    </span>
  )
}
