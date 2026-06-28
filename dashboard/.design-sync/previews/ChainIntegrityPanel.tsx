import { ChainIntegrityPanel } from 'dashboard'

// Hash-chain integrity status panel (verifies the chain head for a customer).
export function Default() {
  return (
    <ChainIntegrityPanel
      customerId="demo-customer-0001"
      lastInsertAt="2024-05-15T11:58:02Z"
      onHeadUpdate={() => {}}
    />
  )
}
