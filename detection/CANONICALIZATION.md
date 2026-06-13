# Canonicalization settlement — cross-substrate `canonical()`

**Status: proposed by AILedger 2026-06-12; awaiting counterparty sign-off.**
Once both sides depend on this, digests and chain links cross-check
byte-for-byte across every producer, transport, and verifier.

## The settled form

`canonical()` = **RFC 8785 (JSON Canonicalization Scheme, JCS)** — exactly.

Reference implementations, all pinned to one shared golden-vector corpus
(`testdata/jcs-golden-vectors.json`, generated from the production
TypeScript `canonicalize` package):

| Language | Implementation | Enforced by |
|---|---|---|
| Python | `ailedger_detection.canonical` (this package, stdlib-only, Apache-2.0) | `tests/test_canonical.py` |
| Python | `ailedger_cli.canonical` (same code, CLI side) | `cli/tests/test_canonical.py` |
| TypeScript | `canonicalize` npm package (sdk + relay) | `sdk/test/jcs-vectors.spec.ts` + pre-deploy canary |

**Adopting the settlement = depending on `ailedger-detection >= 0.3.0` and
calling `canonical()` / `canonical_digest()`** — the agreement is a pip
dependency, not a convention to keep in sync by hand.

## Why JCS and not `json.dumps(sort_keys=True, separators=(",", ":"))`

The earlier placeholder form is byte-identical to JCS for most everyday
payloads, which makes the divergences dangerous — they appear late and fork
silently:

1. **Float formatting.** `json.dumps(1781305000.0)` → `"1781305000.0"`;
   JCS/ECMAScript → `"1781305000"`. Any float epoch timestamp (`ts` in the
   decision-event schema is "epoch seconds, number") diverges. This is the
   concrete fork that forced the settlement; it is locked by test
   (`test_jcs_supersedes_json_dumps_for_float_ts`).
2. **Key ordering.** Python `sort_keys` sorts by code point; JCS sorts by
   UTF-16 code units. They disagree on non-BMP keys (U+10000 sorts before
   U+FF61 in UTF-16). Exotic, but a canonical form either always agrees or
   it isn't canonical.
3. **Number edge cases.** `1e-7`, `1e21`, `-0.0` all format differently
   between Python repr conventions and ECMAScript Number-to-string.

JCS also has an RFC, multi-language implementations, and is what the
TypeScript production path already computes — settling on anything else
would mean re-implementing the JS side against the standard instead.

## The digest

```
digest = SHA-256( UTF-8( canonical(obj) ) )   # hex-lowercase
```

For decision events use `ailedger_detection.canonical_digest(obj)` — it
validates against the frozen v1 schema first
(`ailedger_detection/schemas/decision-event.v1.json`), then hashes the FULL
object including any extra fields, so both sides of the seam digest
identical bytes. The frozen sentinel for "no alternative existed" is
`no-looser-alternative-at-standard` (exported as `NO_LOOSER_ALTERNATIVE`).

## Sign-off procedure

1. `pip install` (or vendor) `ailedger-detection >= 0.3.0`.
2. Run your side's serializer against `testdata/jcs-golden-vectors.json` —
   every vector must match byte-for-byte.
3. Exchange one real decision-event digest computed independently on each
   side; equality = settled.
4. From then on, the golden corpus is append-only: new vectors may be added,
   existing vectors never change.
