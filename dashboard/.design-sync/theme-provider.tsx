import { useLayoutEffect, type ReactNode } from 'react'

// Preview provider (design-sync only — NOT shipped to the app, and real designs
// built with this DS never render DarkRoot, so everything here is preview-scoped).
//
// Two jobs:
// 1. Force the brand dark theme. The dashboard reads its theme from `html.dark`
//    / `html.light` (src/useTheme.ts + src/index.css). Previews have no useTheme
//    running, so without this they fall to index.css's light default and clash
//    with the hardcoded-dark components.
// 2. Short-circuit Supabase network calls. Every screen fetches from
//    import.meta.env.VITE_SUPABASE_URL (a dummy host injected by the build) on
//    mount; against a host that never answers the fetch stays pending and the
//    screen is stuck on "Loading…" / renders null. Returning an empty 200 lets
//    each query resolve so the component renders its EMPTY state (a real,
//    honest design state) instead of a perpetual spinner. ponytail: empty-array
//    mock only — not fabricated rows; richer fixtures would mean matching every
//    query shape, not worth it for static cards.
//
// Patched at module load (runs once when the bundle evaluates, before any
// preview mounts — child mount effects would otherwise beat a provider effect).
declare global { interface Window { __dsFetchPatched?: boolean } }

if (typeof window !== 'undefined' && !window.__dsFetchPatched) {
  window.__dsFetchPatched = true
  const real = window.fetch.bind(window)
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (url && url.includes('demo.supabase.co')) {
      return Promise.resolve(
        new Response('[]', {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/0' },
        }),
      )
    }
    return real(input as any, init)
  }) as typeof window.fetch
}

export function DarkRoot({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    const el = document.documentElement
    el.classList.add('dark')
    el.classList.remove('light')
  }, [])
  return <div style={{ background: '#0f1117', minHeight: '100%' }}>{children}</div>
}
