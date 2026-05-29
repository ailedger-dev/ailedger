/**
 * AILedger landing design system — shared foundation extracted from /hiring.
 * See ./README.md for the full reference.
 *
 * CSS is imported separately by each consuming page:
 *   import './ds/tokens.css'       // tokens only (Tier-A token consumers)
 *   import './ds/primitives.css'   // + utilities, reveal, scroll fix, Inter
 */
export { PageShell, Section } from './Section'
export { Eyebrow } from './Eyebrow'
export { DisplayHeading } from './Heading'
export { BackHomeLink } from './BackHomeLink'
export { useReveal, REVEAL_THRESHOLD, REVEAL_ROOT_MARGIN } from './useReveal'
