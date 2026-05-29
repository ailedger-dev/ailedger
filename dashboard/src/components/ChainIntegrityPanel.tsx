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

type Status = 'idle' | 'verifying' | 'verified-ok' | 'verified-broken' | 'error'

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
  return d.toISOString().slice(0, 10) + ' UTC'
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

  // localStorage key — per-customer so cross-customer state doesn't leak.
  const lsKey = `ailedger:chain-verify:${customerId}`

  // Initial load: fetch the chain head only. Verification is manual-only
  // per Jake — users click "Verify" when they want a fresh integrity check.
  //
  // Hydrate the LAST verification result from localStorage so Verified-OK /
  // Verified-broken state survives a page refresh. We do NOT auto-flip a
  // hydrated verified-ok to "stale" on head movement: in a busy tenant
  // (vernier-internal writes every few seconds) the head moves continuously
  // and the AFTER INSERT trigger (20260519_chain_insert_verification_trigger)
  // re-walks chain_prev_hash on every insert and RAISEs on tamper, so the
  // chain is still tamper-evidently verified once it's been walked. The
  // server-side chain_health monitor (cron) remains the authoritative break
  // signal. Removing the stale-flip also fixes the post-click flash where
  // the badge would briefly read "Verified" and then immediately turn
  // yellow because the head fetched in this effect had already advanced
  // past the verify_chain RPC's frozen-in-time chain_head_hash.
  useEffect(() => {
    let cancelled = false

    try {
      const raw = localStorage.getItem(lsKey)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && parsed.verifyResult && parsed.verifiedAt) {
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

    }
    loadHead()
    return () => { cancelled = true }
  }, [customerId, onHeadUpdate, lsKey])

  // When a new row is inserted, refresh the head (Records-chained KPI +
  // chain_head_hash). We do NOT auto-flip a verified-ok chain to stale:
  // the AFTER INSERT verification trigger (20260519_chain_insert_verification_trigger)
  // re-walks chain_prev_hash against the actual predecessor on every
  // insert and RAISEs on tamper, so a verified-ok chain extended by
  // clean inserts is still meaningfully verified. The server-side
  // chain_health monitor (cron) is the authoritative break signal — its
  // result is surfaced on initial load above. Debounced 3s so an insert
  // burst doesn't fire one chain_head fetch per row.
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
    }, 3000)
    return () => { cancelled = true; clearTimeout(t) }
  }, [lastInsertAt, customerId, onHeadUpdate])

  // No throttle: the in-flight `verifying` state alone gates double-clicks,
  // and `setStatus('verifying')` flips synchronously so two clicks in the
  // same tick can't both pass. Removing the 60s post-verify lockout was a
  // direct ask from Jake — for an 8k-row tenant verify_chain returns in
  // under a second and there's no reason to make the user wait.
  const canVerify = status !== 'verifying'

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
    setVerifyResult(result)
    setVerifiedAt(verifiedAtNow)
    setStatus(result.ok ? 'verified-ok' : 'verified-broken')
    // Don't overwrite head.row_count with verify's row_count — they have
    // different semantics now (verify counts post-disclosure walked rows,
    // chain_head counts total chained rows; the UI's "Records chained"
    // KPI wants the latter). Only refresh chain_head_hash if verify
    // produced one.
    if (result.chain_head_hash && head) {
      const updated: ChainHead = {
        ...head,
        chain_head_hash: result.chain_head_hash,
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
          chainHeadHashAtVerify: result.chain_head_hash,
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
                <div>Broken at row id <span className="font-mono text-red-300">{verifyResult.broken_at_id}</span></div>
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
