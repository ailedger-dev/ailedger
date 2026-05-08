# AILedger Proxy — Changelog

## Unreleased

### Added
- **RFC 8785 JSON Canonicalization Scheme (JCS) for audit-log hash stability.**
  The proxy now canonicalizes JSON request and response bodies per RFC 8785
  *before* SHA-256 hashing. Customers verifying logs on their side no longer
  need to reproduce our exact serialization — any RFC 8785 implementation
  produces the same hash. Non-JSON bodies (binary, `multipart/form-data`,
  `text/event-stream` streams) continue to be hashed as raw bytes.

  Chain impact: existing `inference_logs` rows are unchanged. New rows use
  JCS-canonicalized input/output hashes. The genesis-disclosure mechanism
  in `migrations/20260418_tamper_evident_chain.sql` already separates
  pre-existing rows from the chain, so no retroactive mutation of historical
  hashes is performed (and never will be — that would break the whole point
  of a tamper-evident log).

### Public thanks

RFC 8785 exists because a small group of people cared enough to turn a
tedious problem — "the same JSON, serialized two ways, hashes differently" —
into a stable, auditable standard that everyone can rely on. AILedger's
cross-SDK verification story rests directly on their work. Thank you to:

- **Anders Rundgren** — RFC 8785 primary author, co-author of the
  `canonicalize` reference implementation.
- **Samuel Erdtman** — co-author of RFC 8785 and maintainer of the
  `canonicalize` npm package we adopted.
- **Bret Jordan** — RFC 8785 co-author.
- The **IETF JOSE Working Group** — for shepherding the spec through
  review.

Library choice: we use `canonicalize` (MIT/Apache-2.0,
<https://github.com/erdtman/canonicalize>), the reference implementation
co-authored by two of the RFC's authors. Bundle size: ~1.3 KB. No runtime
dependencies. Considered `json-canonicalize` as an alternative but chose
`canonicalize` for authorship provenance and smaller footprint on
Cloudflare Workers.
