import { useEffect, useState } from 'react'
import { supabase } from '../supabase'

const ANNEX_III_CATEGORIES = [
  'I. Biometric identification and categorisation of natural persons',
  'II. Management and operation of critical infrastructure',
  'III. Education and vocational training',
  'IV. Employment, workers management and access to self-employment',
  'V. Access to essential private services and public services and benefits',
  'VI. Law enforcement',
  'VII. Migration, asylum and border control management',
  'VIII. Administration of justice and democratic processes',
  'IX. General Purpose AI (GPAI) deployed in a high-risk context',
  'Other (describe in system purpose)',
]

interface System {
  id: string
  system_name: string
  system_purpose: string
  annex_iii_category: string
}

const BLANK: Omit<System, 'id'> = {
  system_name: '',
  system_purpose: '',
  annex_iii_category: '',
}

export default function SystemSettings({ customerId }: { customerId: string }) {
  const [systems, setSystems] = useState<System[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [form, setForm] = useState(BLANK)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [adding, setAdding] = useState(false)
  const [isPro, setIsPro] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [orgName, setOrgName] = useState('')
  const [orgSaved, setOrgSaved] = useState(false)

  useEffect(() => {
    load()
  }, [customerId])

  async function load() {
    setLoading(true)
    const [{ data: settingsData }, { data: subData }, { data: profileData }] = await Promise.all([
      supabase
        .from('account_settings')
        .select('id, system_name, system_purpose, annex_iii_category')
        .eq('customer_id', customerId)
        .order('system_name'),
      supabase
        .from('subscriptions')
        .select('status')
        .maybeSingle(),
      supabase
        .from('profiles')
        .select('org_name')
        .eq('customer_id', customerId)
        .maybeSingle(),
    ])
    setIsPro((subData as { status: string } | null)?.status === 'active')
    if (profileData?.org_name) setOrgName(profileData.org_name)
    const rows = (settingsData ?? []) as System[]
    setSystems(rows)
    if (rows.length > 0 && !selected) {
      setSelected(rows[0].id)
      setForm({
        system_name: rows[0].system_name ?? '',
        system_purpose: rows[0].system_purpose ?? '',
        annex_iii_category: rows[0].annex_iii_category ?? '',
      })
    }
    setLoading(false)
  }

  function selectSystem(sys: System) {
    setSelected(sys.id)
    setForm({
      system_name: sys.system_name ?? '',
      system_purpose: sys.system_purpose ?? '',
      annex_iii_category: sys.annex_iii_category ?? '',
    })
    setAdding(false)
    setSaved(false)
    setNameError(null)
  }

  function startAdding() {
    setSelected(null)
    setForm(BLANK)
    setAdding(true)
    setSaved(false)
    setNameError(null)
  }

  async function save() {
    const trimmed = form.system_name.trim()
    const isDuplicate = systems.some(
      (s) => s.system_name.toLowerCase() === trimmed.toLowerCase() && s.id !== selected
    )
    if (isDuplicate) {
      setNameError('A system with this name already exists.')
      return
    }
    setNameError(null)
    setSaving(true)
    if (adding) {
      const { data } = await supabase.from('account_settings').insert({
        customer_id: customerId,
        system_name: form.system_name,
        system_purpose: form.system_purpose,
        annex_iii_category: form.annex_iii_category,
        updated_at: new Date().toISOString(),
      }).select('id, system_name, system_purpose, annex_iii_category').single()
      if (data) {
        setSystems((prev) => [...prev, data as System].sort((a, b) => a.system_name.localeCompare(b.system_name)))
        setSelected((data as System).id)
        setAdding(false)
      }
    } else if (selected) {
      await supabase.from('account_settings').update({
        system_name: form.system_name,
        system_purpose: form.system_purpose,
        annex_iii_category: form.annex_iii_category,
        updated_at: new Date().toISOString(),
      }).eq('id', selected)
      setSystems((prev) => prev.map((s) => s.id === selected ? { ...s, ...form } : s))
    }
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  async function deleteSystem(id: string) {
    const { count } = await supabase
      .from('api_keys')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', customerId)
      .eq('system_id', id)
    const refCount = count ?? 0
    if (refCount > 0) {
      const msg =
        refCount === 1
          ? '1 API key references this system and will be unassigned. Continue?'
          : `${refCount} API keys reference this system and will be unassigned. Continue?`
      if (!window.confirm(msg)) return
    }
    // .select() returns the rows actually deleted. Under RLS, a missing
    // DELETE policy silently filters the row out and Postgres reports 0
    // rows affected; PostgREST returns 204 regardless. Without this
    // assertion the UI would appear to succeed while the row persists.
    const { data, error } = await supabase
      .from('account_settings')
      .delete()
      .eq('id', id)
      .select('id')
    if (error) {
      console.error('delete system error:', error)
      window.alert(`Could not delete system: ${error.message}`)
      return
    }
    if (!data || data.length === 0) {
      console.error('delete system: 0 rows affected for id', id)
      window.alert(
        'Delete did not persist (database declined the operation). Please reload and try again, or contact support if this repeats.'
      )
      await load()
      return
    }
    const remaining = systems.filter((s) => s.id !== id)
    setSystems(remaining)
    if (remaining.length > 0) {
      selectSystem(remaining[0])
    } else {
      setSelected(null)
      setForm(BLANK)
      setAdding(false)
    }
  }

  if (loading) return <div className="text-slate-500 text-sm py-8">Loading...</div>

  return (
    <div>
      {/* Organization name */}
      <div className="mb-8">
        <label className="block text-sm font-medium text-slate-300 mb-1.5">Organization Name</label>
        <div className="flex gap-3 items-stretch [&_input]:!mb-0">
          <input
            type="text"
            placeholder="e.g. Acme Corp"
            value={orgName}
            onChange={(e) => { setOrgName(e.target.value); setOrgSaved(false) }}
            onKeyDown={async (e) => {
              if (e.key === 'Enter') {
                const { error } = await supabase.from('profiles').upsert({ customer_id: customerId, org_name: orgName }, { onConflict: 'customer_id' })
                if (error) console.error('org save error:', error)
                setOrgSaved(!error)
              }
            }}
            className="flex-1 max-w-sm px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
          <button
            onClick={async () => {
              const { error } = await supabase.from('profiles').upsert({ customer_id: customerId, org_name: orgName }, { onConflict: 'customer_id' })
              if (error) console.error('org save error:', error)
              setOrgSaved(!error)
            }}
            style={{ cursor: 'pointer' }}
            className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
          >{orgSaved ? 'Saved' : 'Save'}</button>
        </div>
        <p className="text-slate-500 text-xs mt-1">Used as the header on compliance reports.</p>
      </div>

    <div className="flex flex-col sm:flex-row gap-6 sm:gap-8">
      {/* Sidebar - system list */}
      <div className="sm:w-52 sm:shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {/* Hamburger - mobile only */}
            <button
              onClick={() => setSidebarOpen((v) => !v)}
              style={{ cursor: 'pointer' }}
              className="sm:hidden text-slate-400 hover:text-white transition-colors"
              aria-label="Toggle systems list"
            >
              {sidebarOpen ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              )}
            </button>
            <span className="text-sm font-medium text-slate-300">AI Systems</span>
          </div>
          {isPro || systems.length === 0 ? (
            <button
              onClick={startAdding}
              style={{ cursor: 'pointer' }}
              className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              + Add
            </button>
          ) : (
            <span
              title="Upgrade to Pro to add multiple AI systems"
              className="text-xs text-slate-600 cursor-not-allowed"
            >
              Pro
            </span>
          )}
        </div>
        <div className={`space-y-1 ${sidebarOpen ? 'block' : 'hidden'} sm:block`}>
          {systems.map((sys) => (
            <div
              key={sys.id}
              onClick={() => selectSystem(sys)}
              style={{ cursor: 'pointer' }}
              className={`group flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors ${
                selected === sys.id && !adding
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-white'
              }`}
            >
              <span className="truncate">{sys.system_name || 'Unnamed'}</span>
              <button
                onClick={(e) => { e.stopPropagation(); deleteSystem(sys.id) }}
                style={{ cursor: 'pointer' }}
                className={`ml-2 opacity-0 group-hover:opacity-100 text-xs transition-opacity ${
                  selected === sys.id && !adding ? 'text-indigo-200 hover:text-white' : 'text-slate-500 hover:text-red-400'
                }`}
              >
                ✕
              </button>
            </div>
          ))}
          {systems.length === 0 && !adding && (
            <p className="text-slate-600 text-xs px-1">No systems yet.</p>
          )}
          {adding && (
            <div className="px-3 py-2 rounded-lg text-sm bg-indigo-600 text-white">
              New system
            </div>
          )}
        </div>
      </div>

      {/* Form */}
      <div className="flex-1">
        {(selected || adding) ? (
          <>
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-white">
                {adding ? 'New AI System' : (systems.find((s) => s.id === selected)?.system_name || 'Settings')}
              </h2>
              <p className="text-slate-400 text-sm mt-0.5">
                Included in your compliance reports.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">AI System Name</label>
                <input
                  type="text"
                  placeholder="e.g. Customer Support Bot, Loan Risk Scorer"
                  value={form.system_name}
                  onChange={(e) => { setForm((p) => ({ ...p, system_name: e.target.value })); setSaved(false); setNameError(null) }}
                  className={`w-full px-3 py-2 bg-slate-800 border rounded-lg text-white text-sm placeholder-slate-500 focus:outline-none ${nameError ? 'border-red-500 focus:border-red-500' : 'border-slate-700 focus:border-indigo-500'}`}
                />
                {nameError && <p className="text-red-400 text-xs mt-1">{nameError}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">System Purpose & Description</label>
                <textarea
                  rows={4}
                  placeholder="Describe what this AI system does, what decisions it informs or makes, and who it affects."
                  value={form.system_purpose}
                  onChange={(e) => { setForm((p) => ({ ...p, system_purpose: e.target.value })); setSaved(false) }}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm placeholder-slate-500 focus:outline-none focus:border-indigo-500 resize-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">EU AI Act Annex III Category</label>
                <select
                  value={form.annex_iii_category}
                  onChange={(e) => { setForm((p) => ({ ...p, annex_iii_category: e.target.value })); setSaved(false) }}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-indigo-500"
                >
                  <option value="">Select a category...</option>
                  {ANNEX_III_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
                <p className="text-slate-500 text-xs mt-0.5 pl-1">
                  The Annex III category under Regulation (EU) 2024/1689. <a href="https://ailedger.dev/guide/annex-iii" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:text-indigo-300 transition-colors">How do I choose?</a>
                </p>
              </div>

              <div className="mt-6">
                <label className="block text-sm font-medium text-slate-300 mb-1.5">Data Residency</label>
                <div className="w-full px-3 py-2 bg-slate-900 border border-slate-700/50 rounded-lg text-slate-400 text-sm">
                  AWS eu-central-1 (Frankfurt, Germany) via Supabase. Inference data is processed at Cloudflare's global edge network prior to storage.
                </div>
                <p className="text-slate-600 text-xs mt-0.5 mb-2 pl-1">Managed by AILedger infrastructure.</p>
              </div>

              <div className="mt-6">
                <label className="block text-sm font-medium text-slate-300 mb-1.5">Retention Policy</label>
                <div className="w-full px-3 py-2 bg-slate-900 border border-slate-700/50 rounded-lg text-slate-400 text-sm">
                  Indefinite - records are append-only and cannot be deleted. Immutability is enforced at the database level per EU AI Act Article 12.
                </div>
                <p className="text-slate-600 text-xs mt-0.5 mb-2 pl-1">Managed by AILedger infrastructure.</p>
              </div>

              <div className="flex items-center gap-4 mt-4">
                <button
                  onClick={save}
                  disabled={saving}
                  style={{ cursor: 'pointer' }}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  {saving ? 'Saving...' : adding ? 'Create system' : 'Save settings'}
                </button>
                {saved && <span className="text-emerald-400 text-sm">Saved.</span>}
              </div>
            </div>
          </>
        ) : (
          <div className="text-slate-500 text-sm py-8">
            Select a system or <button onClick={startAdding} style={{ cursor: 'pointer' }} className="text-indigo-400 hover:text-indigo-300">add one</button>.
          </div>
        )}
      </div>
    </div>
    </div>
  )
}
