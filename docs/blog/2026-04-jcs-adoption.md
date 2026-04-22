---
title: "Why AILedger adopted RFC 8785 for audit-hash canonicalization"
date: 2026-04-22
status: DRAFT
author: AILedger team
tags: [engineering, compliance, audit]
---

> **Draft — not yet published.** Awaiting voice-review pass before release.

If you care about auditing an AI pipeline, the moment of truth is simple:
I hand you a log entry, you hand me a request body, and we both hash the
body and compare. If the hashes match, the log is provably about that
request. If they don't, the log is useless.

We found out the hard way that this simple story has a subtle failure
mode. We're fixing it by adopting [RFC 8785 — JSON Canonicalization
Scheme (JCS)](https://www.rfc-editor.org/rfc/rfc8785). This post
explains why, what changes, and why it matters for anyone who wants to
verify AILedger's audit logs on their own.

## The cross-SDK hash-variance problem

AILedger's proxy logs a SHA-256 hash of every inference request and
response body. The hash is immutable, stored in an append-only chain,
and designed so regulators and customers can independently re-verify
the log by replaying the original payload.

Until now, we hashed the raw bytes on the wire. That worked fine when
the customer used the same SDK we tested against. It broke the moment
someone tried to recompute the hash from a semantically-equivalent
version of the same request — for example, a JSON body re-serialized
by a different library, with different key ordering, different
whitespace, or a different number format.

Three concrete ways this shows up in practice:

1. **Key order.** `JSON.stringify` in Node preserves insertion order;
   Python's `json.dumps` sorts alphabetically if you ask it to; the
   Go `encoding/json` package sorts map keys alphabetically by default.
   Same object, three different byte sequences, three different hashes.
2. **Whitespace.** One SDK emits `{"a":1,"b":2}`; another emits
   `{ "a": 1, "b": 2 }`. Both correct, different hashes.
3. **Number format.** `1.0` vs `1`, `1e2` vs `100`, trailing zeros,
   scientific notation — every language has a slightly different
   default. Every variant is a different hash.

For a customer self-verifying the log, this is a dead end: to
reproduce our hash, they'd have to replicate *our exact serialization*,
which is whatever our HTTP client happened to emit on the wire. That's
not a stable contract. It's an accident.

## The fix: RFC 8785

RFC 8785 is a short, precise spec that defines *one* canonical byte
sequence for any given JSON value. Object keys sort by UTF-16 code
units. Whitespace is eliminated. Numbers use the ECMAScript
`Number.prototype.toString()` form. Strings use the minimum escape
set from RFC 8259 §7.

Two systems that both implement RFC 8785 produce the same bytes for
the same logical JSON — full stop. Hashing those canonical bytes
gives a stable, SDK-independent audit hash.

Starting with this release, the AILedger proxy canonicalizes JSON
request and response bodies with RFC 8785 before SHA-256 hashing.
Non-JSON payloads (binary uploads, `multipart/form-data`, streaming
`text/event-stream`) continue to be hashed as raw bytes — there's no
canonical form to appeal to there, and the raw-byte hash is already
stable for those cases.

## What this means if you're verifying logs

If you're a customer or auditor reproducing our hashes:

- Pull any RFC 8785 implementation in your language. The reference
  JavaScript implementation is [`canonicalize`](https://github.com/erdtman/canonicalize);
  there are equivalents in [Python](https://pypi.org/project/jcs/),
  [Go](https://github.com/cyberphone/json-canonicalization), Java,
  Rust, and others.
- For JSON bodies: canonicalize with RFC 8785, then SHA-256 the UTF-8
  encoding of the canonical form.
- For non-JSON bodies: SHA-256 the raw bytes.

Your hash will match ours regardless of which SDK you used to send
the original request, and regardless of which language you use to
re-verify.

## Edge cases worth naming out loud

- **Streaming responses (SSE).** We do not canonicalize per-chunk.
  We assemble the full body (`data: ...\n\n` lines and all), then
  hash as raw bytes — the stream is not itself a JSON document.
- **JSON with embedded base64 binary.** Canonicalized via the JSON
  path; the base64 string is treated as an opaque value. Providers
  that emit non-standard (e.g., line-wrapped) base64 will only get a
  stable hash if that wrapping is stable across calls. The proxy does
  not re-encode.
- **Chain integrity.** The tamper-evident chain that ships with
  AILedger's Supabase schema is not retroactively rewritten. Rows
  inserted before this change retain their original raw-byte hashes,
  and the genesis-disclosure row that separates legacy rows from the
  chain is left alone. Going forward, every new row's `input_hash` and
  `output_hash` use the JCS-canonicalized form.
- **Malformed JSON.** If a body declares `Content-Type: application/json`
  but doesn't parse, we fall back to raw-byte hashing rather than fail.
  Customers who hit this in practice will see a hash that depends on
  exact bytes; that's intentional — the log is telling the truth about
  what arrived.

## Thanks

RFC 8785 exists because people cared enough about a tedious,
high-stakes problem to produce a specification that the rest of us can
just import and rely on. AILedger is standing on their shoulders.

Specifically, thank you to **Anders Rundgren** and **Samuel Erdtman**
(the RFC's primary and co-author, and maintainers of the `canonicalize`
reference implementation we adopted), to **Bret Jordan** (co-author),
and to the **IETF JOSE Working Group** for shepherding the spec
through review and standardization.

Our adoption is a small thing — a 1.3 KB dependency, a helper function,
a paragraph in our changelog. But it's a small thing that only works
because a much larger amount of careful, unpaid work happened first.
That deserves to be said out loud.

---

*AILedger is an EU AI Act audit-logging proxy for AI inferences. We
log every inference as a tamper-evident, regulator-verifiable record
without changing a single line of your application code.*
