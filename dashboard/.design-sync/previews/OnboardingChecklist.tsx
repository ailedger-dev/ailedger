import { OnboardingChecklist } from 'dashboard'

// First-run onboarding checklist (tracks setup steps for a customer).
export function Default() {
  return <OnboardingChecklist customerId="demo-customer-0001" onGoToKeys={() => {}} />
}
