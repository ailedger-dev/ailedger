import { ReportGenerator } from 'dashboard'

// Compliance-report (EU AI Act Art. 12) generator screen.
export function Default() {
  return (
    <ReportGenerator
      customerId="demo-customer-0001"
      customerEmail="jane@acme.example"
      onUpgrade={() => {}}
    />
  )
}
