import { BackHomeLink } from 'landing'

// The only nav chrome on a standalone DS page: a back-to-site link with an
// animated arrow and a 4px focus offset. Mounts inside .ds-root for its tokens.
function Surface({ children }: { children: React.ReactNode }) {
  return (
    <div className="ds-root" style={{ minHeight: 'auto', padding: 32 }}>
      {children}
    </div>
  )
}

export function Default() {
  return (
    <Surface>
      <BackHomeLink label="Back to AILedger" ariaLabel="Back to the AILedger home page" />
    </Surface>
  )
}
