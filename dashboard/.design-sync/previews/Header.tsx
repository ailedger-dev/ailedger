import { Header } from 'dashboard'

// Header takes a Supabase session (reads session.user.email) + theme controls.
// esbuild strips the types, so a plain object stands in for the Session.
const session = { user: { id: 'u_demo', email: 'jane@acme.example', user_metadata: {} } } as any

export function Default() {
  return (
    <Header
      session={session}
      theme="dark"
      onToggleTheme={() => {}}
      onLogoClick={() => {}}
    />
  )
}
