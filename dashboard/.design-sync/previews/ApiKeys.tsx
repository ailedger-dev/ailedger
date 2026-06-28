import { ApiKeys } from 'dashboard'

// API key management screen (fetches keys). Shows the create-key form + table.
export function Default() {
  return <ApiKeys customerId="demo-customer-0001" onUpgrade={() => {}} />
}
