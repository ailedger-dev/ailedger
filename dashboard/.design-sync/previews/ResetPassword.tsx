import { ResetPassword } from 'dashboard'

// Set-a-new-password screen (post recovery-link). Self-contained card.
export function Default() {
  return <ResetPassword onDone={() => {}} />
}
