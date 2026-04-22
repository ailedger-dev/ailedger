import { useEffect, useState } from 'react'
import { supabase } from '../supabase'

const PLANS = [
  {
    name: 'Pro',
    price_monthly: '$149/mo',
    price_annual: '$1,490/yr',
    description: 'Up to 500k inferences/mo, PDF compliance reports, 5 API keys, multiple AI systems, EU data residency',
    key_monthly: 'pro_monthly',
    key_annual: 'pro_annual',
  },
  {
    name: 'Scale',
    price_monthly: '$499/mo',
    price_annual: '$4,990/yr',
    description: 'Up to 1M inferences/mo, unlimited API keys, unlimited AI systems, priority support',
    key_monthly: 'scale_monthly',
    key_annual: 'scale_annual',
  },
]

const PLAN_LABELS: Record<string, string> = {
  pro_monthly: 'Pro - Monthly',
  pro_annual: 'Pro - Annual',
  scale_monthly: 'Scale - Monthly',
  scale_annual: 'Scale - Annual',
}

interface Subscription {
  status: string
  plan: string | null
}

export default function Billing() {
  const [billing, setBilling] = useState<'monthly' | 'annual'>('monthly')
  const [loading, setLoading] = useState<string | null>(null)
  const [sub, setSub] = useState<Subscription | null | 'loading'>('loading')

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('subscriptions')
        .select('status, plan')
        .maybeSingle()
      setSub(data ?? null)
    }
    load()
  }, [])

  async function checkout(priceKey: string) {
    setLoading(priceKey)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      const res = await fetch('https://proxy.ailedger.dev/checkout/create-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ price_key: priceKey }),
      })

      const data = await res.json() as { url?: string; error?: string }
      if (data.url) {
        window.location.href = data.url
      } else {
        console.error('Checkout error:', data.error)
      }
    } finally {
      setLoading(null)
    }
  }

  const activePlan = sub !== 'loading' && sub?.status === 'active' ? sub.plan : null

  async function managePortal() {
    setLoading('portal')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      const res = await fetch('https://proxy.ailedger.dev/billing/portal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
      })

      const data = await res.json() as { url?: string; error?: string }
      if (data.url) {
        window.location.href = data.url
      } else {
        console.error('Portal error:', data.error)
      }
    } finally {
      setLoading(null)
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-white">Billing</h2>
        <p className="text-slate-400 text-sm mt-0.5">Upgrade to unlock higher limits and compliance features.</p>
      </div>

      <div>

      {/* Current plan banner */}
      {sub === 'loading' ? null : activePlan ? (
        <div className="mb-5 px-4 py-3 bg-slate-800/60 border border-slate-700 rounded-lg flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
            <span className="text-sm text-slate-300 font-medium">{PLAN_LABELS[activePlan] ?? activePlan}</span>
            <span className="text-xs text-slate-500">· Active</span>
          </div>
          <button
            onClick={managePortal}
            disabled={loading === 'portal'}
            style={{ cursor: 'pointer' }}
            className="text-sm text-indigo-400 hover:text-indigo-300 font-medium transition-colors disabled:text-slate-600"
          >
            {loading === 'portal' ? 'Redirecting...' : 'Manage billing'}
          </button>
        </div>
      ) : (
        <div className="billing-banner mb-6 px-4 py-3 rounded-lg flex items-center gap-2" style={{ background: '#1a1d27', border: 'none' }}>
          <span className="w-1.5 h-1.5 rounded-full bg-slate-500 shrink-0" />
          <span className="text-sm text-slate-400">You're on the <span className="text-white font-medium">Free</span> plan.</span>
        </div>
      )}

      {/* Monthly / Annual toggle */}
      <div className="flex items-center gap-1 mb-8">
        <button
          onClick={() => setBilling('monthly')}
          style={{ cursor: 'pointer' }}
          className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            billing === 'monthly' ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:text-white'
          }`}
        >
          Monthly
        </button>
        <button
          onClick={() => setBilling('annual')}
          style={{ cursor: 'pointer' }}
          className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            billing === 'annual' ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:text-white'
          }`}
        >
          Annual <span className="text-emerald-400 text-xs ml-1">2 months free</span>
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {PLANS.map((plan) => {
          const priceKey = billing === 'monthly' ? plan.key_monthly : plan.key_annual
          const price = billing === 'monthly' ? plan.price_monthly : plan.price_annual
          const isLoading = loading === priceKey
          const isCurrent = activePlan === priceKey

          return (
            <div
              key={plan.name}
              className={`flex flex-col p-4 sm:p-6 rounded-xl border ${
                isCurrent
                  ? 'bg-[#1a1d27] border-indigo-500'
                  : 'bg-[#1a1d27] border-slate-800'
              }`}
            >
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-indigo-400 font-bold text-sm uppercase tracking-wide">{plan.name}</h3>
                  {isCurrent && (
                    <span className="text-xs px-2 py-0.5 bg-indigo-600 rounded-full text-white">Current</span>
                  )}
                </div>
                <div className="text-2xl font-bold text-white billing-price">{price}</div>
                <p className="text-slate-500 text-sm mt-2">{plan.description}</p>
              </div>
              <div className="mt-auto pt-4">
                <button
                  onClick={() => checkout(priceKey)}
                  disabled={isLoading || isCurrent}
                  style={{ cursor: 'default' }}
                  className={`w-full px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                    isCurrent
                      ? 'bg-slate-800/60 text-slate-300 border border-slate-600'
                      : 'bg-indigo-600 hover:bg-indigo-500 text-white'
                  }`}
                >
                  {isCurrent ? 'Current plan' : isLoading ? 'Redirecting...' : `Upgrade to ${plan.name}`}
                </button>
              </div>
            </div>
          )
        })}
      </div>
      </div>
    </div>
  )
}
