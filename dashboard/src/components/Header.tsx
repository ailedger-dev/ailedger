import type { Session } from '@supabase/supabase-js'
import { supabase } from '../supabase'
import type { Theme } from '../useTheme'

interface Props {
  session: Session
  theme: Theme
  onToggleTheme: () => void
  onLogoClick: () => void
}

export default function Header({ session, theme, onToggleTheme, onLogoClick }: Props) {
  return (
    <header className="border-b border-slate-800 px-5 py-4 bg-[#0f1117]">
      <div className="dashboard-main flex items-center justify-between">
        <button
          onClick={onLogoClick}
          style={{ cursor: 'pointer' }}
          className="flex items-center gap-3 shrink-0 hover:opacity-80 transition-opacity"
        >
          <img src="/favicon.svg" alt="AILedger" className="w-5 h-5" style={{ marginTop: '-1.5px' }} />
          <span className="text-white font-semibold tracking-tight leading-none inline-block text-lg">AILedger</span>
          <span className="text-[10px] text-slate-500 bg-slate-800 px-1.5 py-1 rounded-full leading-none">Early Access</span>
        </button>
        <div className="flex items-center gap-4">
          <button
            onClick={onToggleTheme}
            style={{ cursor: 'pointer' }}
            className="text-slate-400 hover:text-white transition-colors"
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707M17.657 17.657l-.707-.707M6.343 6.343l-.707-.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            )}
          </button>
          <span className="text-slate-400 text-sm hidden sm:inline">{session.user.email}</span>
          <button
            onClick={() => supabase.auth.signOut()}
            style={{ cursor: 'pointer' }}
            className="text-sm text-slate-400 hover:text-white transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  )
}
