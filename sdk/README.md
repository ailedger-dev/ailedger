# @ailedger/sdk

Producer-side SDK for AILedger Detection Event emission.

**Version:** 0.2.0
**License:** MIT
**Spec:** `gt-lab/docs/param-canonicalization-spec-v1.md` (Jake-ratified 2026-05-18)

---

## What this SDK does

Producers (Wilhelm-style federated AI pipelines, in-firm AI deployments, or any system emitting AI-influenced decisions) integrate this SDK to:

1. Compute `inputs_hash` client-side using RFC 8785 JCS canonicalization for JSON or raw-byte SHA-256 for everything else. Raw inputs are never transmitted.
2. Normalize `confidence` to 4-decimal precision for chain-stable hashing.
3. Emit structured Detection Events with model provenance, decision type, protected-class context, flags, and required actions.
4. Emit inferred Detection Events from the 4-rung method ladder (`detection.parse` / `restructure` / `replay` / `perturb`) with extractor metadata and canonical-serialized parameter hashes.

The SDK never computes hash chain values; the database trigger populates `hash_chain_prev` and `hash_chain_self` atomically at insert time.

## v0.2.0 scope

This release ships:

- TypeScript type contracts matching `ledger.decision_events` schema plus the 2026-05-18 inferred-event extension.
- Hashing primitives (`sha256hex`, `sha256jcs`, `computeInputsHash`).
- Canonical-serialization for extractor params (per spec §7.2) and method-specific param schemas (parse / restructure / replay / perturb per spec §6).
- Confidence normalization to 4-decimal precision and timestamp normalization to microsecond-padded ISO-8601 UTC.
- `DetectionEventClient` class with `emit()` and `emitInferred()` methods.
- **NEW in v0.2.0:** HTTP transport wired to `POST {baseUrl}/v2/detection-events` on the AILedger proxy. Returns the populated row (with `hash_chain_prev` + `hash_chain_self` from the DB trigger) merged onto the local Detection Event.
- **NEW in v0.2.0:** Typed error hierarchy (`AILedgerAuthError`, `AILedgerValidationError`, `AILedgerForbiddenError`, `AILedgerRateLimitError` with `retryAfterSeconds`, `AILedgerServerError`, `AILedgerTransportError`).

Not yet shipped (v0.3.0+):

- Opt-in retry policy for 429 + 5xx (exponential backoff + durable-buffer fallback). v0.2.0 throws; caller retries.
- Verification helper that fetches a row back and re-computes the canonical hash via the dispatcher (`decision_events_canonical_hash`).
- Tenant-ownership validation at the proxy (v0.2.0 trusts SDK-supplied `tenant_id`).
- Multi-language ports (Python, Rust); current is TypeScript only.

## Install

```
npm install @ailedger/sdk
```

Requires Node 20+ (depends on global `crypto.subtle`).

## Usage

```typescript
import { DetectionEventClient } from '@ailedger/sdk';
import { randomUUID } from 'node:crypto';

const client = new DetectionEventClient({
  baseUrl: 'https://proxy.ailedger.dev',
  apiKey: process.env.AILEDGER_API_KEY!,
  tenantId: 'YOUR-TENANT-UUID',
  systemId: 'YOUR-SYSTEM-UUID',
});

// Canonical (production-time) Detection Event
await client.emit({
  eventId: randomUUID(),
  rawInputs: { patient_phenotype: { /* ... */ } },  // hashed via JCS; never transmitted
  modelVersion: 'qwen-3.5-wilhelm-rare-archive@v0.1.0',
  decisionType: 'differential-diagnosis-narrowing',
  subjectId: 'pseudonymized-subject-uuid',
  output: { /* structured decision output */ },
  confidence: 0.8523,  // SDK normalizes to 0.8523 (4-decimal)
  humanInLoop: true,
  protectedClassContext: { ancestry: 'inferred-from-phenotype' },
  protectedClassCollectionMethod: 'inferred',
  flagsRaised: ['low-confidence'],
  requiredActions: ['clinician-review-required'],
  actionsTaken: [],
});

// Inferred Detection Event from rung-1 parse
await client.emitInferred({
  eventId: randomUUID(),
  anchorEventId: 'CANONICAL-EVENT-UUID',
  extractorMethod: 'detection.parse',
  extractorModel: 'claude-haiku-4-5-20251001',
  extractorParams: {
    trace_source: 'chain-of-thought',
    parse_strategy: 'pattern-match',
    parse_strategy_version: 'v1.0',
    ontology_ref: 'ailedger-generic:v0.1.0',
  },
  extractionStartedAt: new Date(),
  extractionComputeMs: 42,
  output: { /* extracted decision shape */ },
});
```

## SDK contract per spec §9

The producer-side responsibilities locked by spec v1.0:

1. **`inputs_hash` is client-side.** Raw inputs never reach the SDK transport. The SDK accepts either a structured object (canonicalized via JCS) or raw bytes/string (hashed via `sha256jcs`).
2. **`confidence` is normalized to 4 decimals** before emission. Producers may pass any precision; the SDK truncates with banker's rounding.
3. **Structured fields are JSONB-shaped.** `output`, `protected_class_context`, `flags_raised`, `required_actions`, `actions_taken` are typed as objects/arrays; the SDK serializes for transport.
4. **Inferred-event hash is client-side.** `extractor_params_hash` is computed from the canonical-serialized params per spec §7.2 before transport.
5. **Chain values are server-side.** The SDK never computes `hash_chain_prev` or `hash_chain_self`. The BEFORE INSERT trigger populates them atomically.

## Spec linkage

- **§2 hashing:** `src/hash.ts` (SHA-256 hex-lowercase, UTF-8 strict, JCS-for-JSON / raw-bytes for everything else)
- **§3 null/empty conventions:** `src/canonicalize.ts` `canonicalizeValue()`
- **§4 numeric encoding:** `src/normalize.ts` `normalizeConfidence()` (Option A storage-IS-canonical with 4-decimal SDK normalization for confidence)
- **§5 storage layout:** `src/types.ts` mirrors `ledger.decision_events` schema
- **§6 per-method param schemas:** `src/types.ts` (param shapes) + `src/canonicalize.ts` (canonical-order serialization)
- **§7 canonical serialization rules:** `src/canonicalize.ts` `computeExtractorParamsHash()`
- **§9 SDK contract:** this README + `src/client.ts` `DetectionEventClient`

## Testing

```
cd sdk
npm install
npm run typecheck
npm test
```

## Naming note

SQL identifiers retain `decision_events` naming until the coordinated rename migration ships (bead `hq-4yh`). TypeScript types and prose use "Detection Event" per ratified naming 2026-05-17 (`docs/caird/AILedger-naming-exploration.md`).

## Authority

- Spec: `gt-lab/docs/param-canonicalization-spec-v1.md`
- Method ladder: `gt-lab/docs/compliance-architecture/HANDOFF-decision-event-layer.md`
- Schema: `proxy/migrations/20260512_decision_events_schema.sql` + `20260518_inferred_detection_events.sql`
- Charter: [ailedger-dev/charter/CHARTER.md](https://github.com/ailedger-dev/charter/blob/main/CHARTER.md)
