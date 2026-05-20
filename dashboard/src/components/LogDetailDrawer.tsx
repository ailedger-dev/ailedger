import { useEffect, useState, type ReactNode } from 'react'

interface LogDetail {
  id: number
  logged_at: string
  started_at: string | null
  completed_at: string | null
  provider: string
  model_name: string | null
  method?: string
  path: string
  input_hash: string | null
  output_hash: string | null
  chain_prev_hash: string | null
  status_code: number
  latency_ms: number
  system_id: string | null
}

export default function LogDetailDrawer({
  log,
  systemName,
  chainPosition,
  onClose,
}: {
  log: LogDetail | null
  systemName: string | null
  chainPosition: number | null
  onClose: () => void
}) {
  const [copyKey, setCopyKey] = useState<string | null>(null)

  // Close on Esc.
  useEffect(() => {
    if (!log) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [log, onClose])

  if (!log) return null

  async function handleCopy(value: string | null, key: string) {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopyKey(key)
      setTimeout(() => setCopyKey(null), 1200)
    } catch {
      /* clipboard blocked */
    }
  }

  const isChained = log.chain_prev_hash !== null

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <button
        aria-label="Close"
        onClick={onClose}
        style={{ cursor: 'pointer' }}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm border-0"
      />
      {/* Drawer */}
      <div className="relative w-full max-w-md bg-[#13151c] border-l border-slate-800 shadow-2xl overflow-y-auto">
        <div className="sticky top-0 bg-[#13151c] border-b border-slate-800 px-5 py-4 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white">Inference record</h3>
            <p className="text-xs text-slate-500 mt-0.5">id {log.id}{chainPosition !== null && ` · #${chainPosition} in chain`}</p>
          </div>
          <button
            onClick={onClose}
            style={{ cursor: 'pointer' }}
            className="text-slate-400 hover:text-white text-lg leading-none px-2"
            aria-label="Close drawer"
          >
            ×
          </button>
        </div>

        <div className="p-5 space-y-5 text-xs">
          <Section label="Time">
            <Field label="Logged at" value={log.logged_at} />
            <Field label="Started" value={log.started_at} />
            <Field label="Completed" value={log.completed_at} />
            <Field label="Latency" value={`${log.latency_ms}ms`} />
          </Section>

          <Section label="Request">
            <Field label="System" value={log.system_id ? (systemName ?? '-') : '(no system)'} />
            <Field label="Provider" value={log.provider} />
            <Field label="Model" value={log.model_name ?? '-'} />
            <Field label="Method" value={log.method ?? '-'} />
            <Field label="Path" value={log.path} mono />
            <Field label="Status" value={String(log.status_code)} mono />
          </Section>

          <Section label="Hashes (SHA-256, RFC 8785 JCS canonical)">
            <CopyableHash
              label="Input"
              value={log.input_hash}
              copied={copyKey === 'input'}
              onCopy={() => handleCopy(log.input_hash, 'input')}
            />
            <CopyableHash
              label="Output"
              value={log.output_hash}
              copied={copyKey === 'output'}
              onCopy={() => handleCopy(log.output_hash, 'output')}
            />
          </Section>

          <Section label="Chain link">
            {isChained ? (
              <CopyableHash
                label="Previous-row hash"
                value={log.chain_prev_hash}
                copied={copyKey === 'prev'}
                onCopy={() => handleCopy(log.chain_prev_hash, 'prev')}
              />
            ) : (
              <p className="text-slate-500">
                Legacy row (pre-chain migration). Excluded from `verify_chain` and not part of the cryptographic chain.
              </p>
            )}
          </Section>
        </div>
      </div>
    </div>
  )
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">{label}</div>
      <div className="rounded-lg border border-slate-800 divide-y divide-slate-800/60">
        {children}
      </div>
    </div>
  )
}

function Field({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 gap-3">
      <span className="text-slate-500 shrink-0">{label}</span>
      <span className={`text-slate-300 truncate text-right ${mono ? 'font-mono' : ''}`}>
        {value ?? '-'}
      </span>
    </div>
  )
}

function CopyableHash({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string
  value: string | null
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-slate-500 shrink-0">{label}</span>
        {value ? (
          <button
            onClick={onCopy}
            style={{ cursor: 'pointer' }}
            className="text-slate-500 hover:text-slate-300 text-[11px]"
            title="Copy full hash"
          >
            {copied ? '✓ copied' : 'copy'}
          </button>
        ) : null}
      </div>
      <div className="mt-1.5 font-mono text-[11px] text-slate-300 break-all">
        {value ?? '-'}
      </div>
    </div>
  )
}
