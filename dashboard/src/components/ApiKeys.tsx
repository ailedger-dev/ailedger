import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import UpgradeModal from './UpgradeModal'

interface ApiKey {
  id: number
  name: string
  key_prefix: string
  created_at: string
  last_used_at: string | null
  system_id: string | null
}

interface AiSystem {
  id: string
  system_name: string
}

type PlanTier = 'free' | 'pro' | 'scale'

const KEY_LIMITS: Record<PlanTier, number | null> = {
  free: 1,
  pro: 5,
  scale: null, // unlimited
}

function generateKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return 'alg_sk_' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function sha256hex(data: string): Promise<string> {
  const buf = new TextEncoder().encode(data)
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function formatDate(iso: string) {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

export default function ApiKeys({ customerId, onUpgrade }: { customerId: string; onUpgrade?: () => void }) {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [systems, setSystems] = useState<AiSystem[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeySystem, setNewKeySystem] = useState<string>('')
  const [revealedKey, setRevealedKey] = useState<string | null>(null)
  const [planTier, setPlanTier] = useState<PlanTier>('free')
  const [showUpgradeModal, setShowUpgradeModal] = useState(false)
  const [copied, setCopied] = useState(false)
  const [fadingOut, setFadingOut] = useState(false)
  const [editingSystem, setEditingSystem] = useState<number | null>(null)
  const [addingSystem, setAddingSystem] = useState(false)
  const [newSystemName, setNewSystemName] = useState('')

  useEffect(() => {
    fetchAll()
  }, [customerId])

  // Systems can be deleted from the Settings tab (or another browser tab).
  // Refresh when the document becomes visible so the dropdowns don't render
  // stale entries that would produce orphan system_id references on create.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') fetchSystems()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId])

  async function fetchSystems() {
    const { data } = await supabase
      .from('account_settings')
      .select('id, system_name')
      .eq('customer_id', customerId)
      .order('system_name')
    const fresh = (data ?? []) as AiSystem[]
    setSystems(fresh)
    // If the currently-staged selection was deleted elsewhere, clear it.
    setNewKeySystem((prev) => (prev && !fresh.some((s) => s.id === prev) ? '' : prev))
  }

  async function fetchAll() {
    setLoading(true)
    const [{ data: keysData }, { data: sysData }, { data: subData }] = await Promise.all([
      supabase
        .from('api_keys')
        .select('id, name, key_prefix, created_at, last_used_at, system_id')
        .eq('customer_id', customerId)
        .order('created_at', { ascending: false }),
      supabase
        .from('account_settings')
        .select('id, system_name')
        .eq('customer_id', customerId)
        .order('system_name'),
      supabase
        .from('subscriptions')
        .select('status, plan')
        .maybeSingle(),
    ])
    setKeys(keysData ?? [])
    setSystems(sysData ?? [])
    if (subData?.status === 'active') {
      const plan = subData.plan as string
      setPlanTier(plan.startsWith('scale') ? 'scale' : 'pro')
    } else {
      setPlanTier('free')
    }
    setLoading(false)
  }

  async function fetchKeys() {
    const { data } = await supabase
      .from('api_keys')
      .select('id, name, key_prefix, created_at, last_used_at, system_id')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
    setKeys(data ?? [])
  }

  async function createKey() {
    if (!newKeyName.trim()) return
    const limit = KEY_LIMITS[planTier]
    if (limit !== null && keys.length >= limit) return
    setCreating(true)

    const rawKey = generateKey()
    const keyHash = await sha256hex(rawKey)
    const keyPrefix = rawKey.slice(0, 16)

    const { error } = await supabase.from('api_keys').insert({
      customer_id: customerId,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: newKeyName.trim(),
      system_id: newKeySystem || null,
    })

    if (!error) {
      setRevealedKey(rawKey)
      setNewKeyName('')
      setNewKeySystem('')
      fetchKeys()
    }

    setCreating(false)
  }

  async function addSystemInline() {
    if (!newSystemName.trim()) return
    const { data, error } = await supabase.from('account_settings').insert({
      customer_id: customerId,
      system_name: newSystemName.trim(),
    }).select('id, system_name').single()
    if (!error && data) {
      setSystems((prev) => [...prev, data as AiSystem])
      setNewKeySystem(data.id)
      setNewSystemName('')
      setAddingSystem(false)
    }
  }

  async function updateKeySystem(id: number, systemId: string | null) {
    const { error } = await supabase.from('api_keys').update({ system_id: systemId }).eq('id', id)
    if (!error) {
      setKeys((prev) => prev.map((k) => k.id === id ? { ...k, system_id: systemId } : k))
    }
    setEditingSystem(null)
  }

  async function deleteKey(id: number) {
    // Mirror the assertion from SystemSettings.deleteSystem: if RLS filters
    // the row, Postgres reports 0 rows and PostgREST returns 204. Surface
    // that as an error instead of letting the UI lie.
    const { data, error } = await supabase
      .from('api_keys')
      .delete()
      .eq('id', id)
      .select('id')
    if (error) {
      console.error('delete key error:', error)
      window.alert(`Could not revoke key: ${error.message}`)
      return
    }
    if (!data || data.length === 0) {
      console.error('delete key: 0 rows affected for id', id)
      window.alert(
        'Revoke did not persist (database declined the operation). Please reload and try again, or contact support if this repeats.'
      )
      await fetchKeys()
      return
    }
    setKeys((prev) => prev.filter((k) => k.id !== id))
  }

  const limit = KEY_LIMITS[planTier]
  const atLimit = limit !== null && keys.length >= limit

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-white">API Keys</h2>
        <p className="text-slate-400 text-sm mt-0.5">Use these keys in the <code className="text-slate-300 bg-slate-800 px-1 rounded">x-ailedger-key</code> header</p>
      </div>

      {/* Upgrade modal */}
      {showUpgradeModal && (
        <UpgradeModal
          feature="keys"
          onClose={() => setShowUpgradeModal(false)}
          onUpgrade={() => { setShowUpgradeModal(false); onUpgrade?.() }}
        />
      )}

      {/* Limit banner */}
      {atLimit && !revealedKey && (
        <div className="mb-5 px-4 py-3 bg-slate-800/60 border border-slate-700 rounded-lg flex items-center justify-between">
          <span className="text-slate-300 text-sm">
            {planTier === 'free'
              ? 'Free plan is limited to 1 API key.'
              : `Pro plan is limited to ${limit} API keys.`}
          </span>
          <button
            onClick={() => setShowUpgradeModal(true)}
            style={{ cursor: 'pointer' }}
            className="text-sm text-indigo-400 hover:text-indigo-300 font-medium transition-colors"
          >
            Upgrade →
          </button>
        </div>
      )}

      {/* New key revealed - show once */}
      {revealedKey && (
        <div
          className="mb-6 p-4 bg-[#1a1d27] border border-slate-700 rounded-xl"
          style={{ transition: 'opacity 0.3s ease', opacity: fadingOut ? 0 : 1 }}
        >
          <p className="text-slate-300 text-sm mb-2">
            <span className="text-red-400 font-medium">Warning:</span> copy this key now - it will never be shown again.
          </p>
          <div className="flex items-center gap-3">
            <code className="text-slate-300 text-xs break-all flex-1">{revealedKey}</code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(revealedKey)
                setCopied(true)
                setTimeout(() => setFadingOut(true), 500)
                setTimeout(() => { setRevealedKey(null); setCopied(false); setFadingOut(false) }, 800)
              }}
              style={{ cursor: 'pointer' }}
              className={`shrink-0 px-3 py-1.5 text-xs rounded-lg transition-colors ${copied ? 'bg-emerald-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-white'}`}
            >
              {copied ? '✓ Copied!' : 'Copy & dismiss'}
            </button>
          </div>
        </div>
      )}

      {/* Create key */}
      {!atLimit && (
        <div className="flex gap-3 mb-6 items-stretch [&_input]:!mb-0 [&_select]:!mb-0">
          <input
            type="text"
            placeholder="Key name (e.g. Production)"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createKey()}
            className="flex-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
          {addingSystem ? (
            <div className="flex gap-2">
              <input
                type="text"
                autoFocus
                placeholder="System name"
                value={newSystemName}
                onChange={(e) => setNewSystemName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addSystemInline()}
                className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
              <button
                onClick={addSystemInline}
                disabled={!newSystemName.trim()}
                style={{ cursor: 'pointer' }}
                className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-xs font-medium rounded-lg transition-colors"
              >Add</button>
              <button
                onClick={() => { setAddingSystem(false); setNewSystemName('') }}
                style={{ cursor: 'pointer' }}
                className="px-2 py-2 text-slate-400 hover:text-white text-sm transition-colors"
              >x</button>
            </div>
          ) : (
            <select
              value={newKeySystem}
              onChange={(e) => {
                if (e.target.value === '__new__') { setAddingSystem(true); return }
                setNewKeySystem(e.target.value)
              }}
              style={{ cursor: 'pointer' }}
              className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-indigo-500"
            >
              <option value="">No system</option>
              {systems.map((s) => (
                <option key={s.id} value={s.id}>{s.system_name}</option>
              ))}
              <option value="__new__">+ Add new system</option>
            </select>
          )}
          <button
            onClick={createKey}
            disabled={creating || !newKeyName.trim()}
            style={{ cursor: 'pointer' }}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {creating ? 'Creating...' : 'Create key'}
          </button>
        </div>
      )}

      {/* Keys table */}
      <div className="rounded-xl border border-slate-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800 bg-[#1a1d27]">
              <th className="text-left px-4 py-3 text-slate-400 font-medium">Name</th>
              <th className="text-left px-4 py-3 text-slate-400 font-medium">System</th>
              <th className="text-left px-4 py-3 text-slate-400 font-medium">Prefix</th>
              <th className="text-left px-4 py-3 text-slate-400 font-medium">Created</th>
              <th className="text-left px-4 py-3 text-slate-400 font-medium">Last used</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-500">Loading...</td></tr>
            ) : keys.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-500">No keys yet.</td></tr>
            ) : keys.map((key) => (
              <tr key={key.id} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                <td className="px-4 py-3 text-white">{key.name}</td>
                <td className="px-4 py-3 text-sm">
                  {editingSystem === key.id ? (
                    <select
                      autoFocus
                      value={key.system_id ?? ''}
                      onChange={(e) => updateKeySystem(key.id, e.target.value || null)}
                      onBlur={() => setEditingSystem(null)}
                      style={{ cursor: 'pointer' }}
                      className="px-2 py-1 bg-slate-800 border border-indigo-500 rounded text-white text-sm focus:outline-none"
                    >
                      <option value="">No system</option>
                      {systems.map((s) => (
                        <option key={s.id} value={s.id}>{s.system_name}</option>
                      ))}
                    </select>
                  ) : (
                    <span
                      onClick={() => systems.length > 0 && setEditingSystem(key.id)}
                      style={{ cursor: systems.length > 0 ? 'pointer' : 'default' }}
                      className={systems.length > 0 ? 'text-slate-400 hover:text-indigo-400 transition-colors' : 'text-slate-400'}
                    >
                      {key.system_id ? (systems.find((s) => s.id === key.system_id)?.system_name ?? '-') : '-'}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-slate-400">{key.key_prefix}...</td>
                <td className="px-4 py-3 text-slate-400">{formatDate(key.created_at)}</td>
                <td className="px-4 py-3 text-slate-400">{key.last_used_at ? formatDate(key.last_used_at) : 'Never'}</td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => deleteKey(key.id)}
                    style={{ cursor: 'pointer' }}
                    className="text-xs text-red-400 hover:text-red-300 transition-colors"
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
