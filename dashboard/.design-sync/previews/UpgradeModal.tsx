import { UpgradeModal } from 'dashboard'

// Upgrade modal — `feature` selects the copy. Three variants, one per feature.
export function Report() {
  return <UpgradeModal feature="report" onClose={() => {}} onUpgrade={() => {}} />
}
export function Keys() {
  return <UpgradeModal feature="keys" onClose={() => {}} onUpgrade={() => {}} />
}
export function Usage() {
  return <UpgradeModal feature="usage" onClose={() => {}} onUpgrade={() => {}} />
}
