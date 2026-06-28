import { LogTable } from 'dashboard'

// The primary inference-log screen: usage meter, chain-integrity panel, and the
// log table (fetches its own rows; preview shows chrome + empty state).
export function Default() {
  return <LogTable customerId="demo-customer-0001" onUpgrade={() => {}} />
}
