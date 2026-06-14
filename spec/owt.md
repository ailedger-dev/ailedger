<!--
SPDX-License-Identifier: Apache-2.0
Open Warrant Transparency (OWT) — open specification.
Anyone may implement these wire formats and procedures. The reference
implementation is the Apache-2.0 `ailedger-detection` package plus the
ailedger SDK/relay/indexer/CLI.
-->

# Open Warrant Transparency (OWT) — v1

**Status:** open specification, reference implementation live on Hedera testnet.
**License:** Apache-2.0 (this document and the reference implementation).
**Defensive publication:** this is published openly to establish prior art and
drive adoption, in the tradition of Certificate Transparency (RFC 6962/9162).
It is *not* a proprietary protocol.

## 1. Problem

An autonomous agent makes a decision. A *warrant* is the decision's
justification plus the alternatives it considered and rejected. A decision
without a sound warrant is **unwarranted**. The conventional response is to
*refuse* an unwarranted decision — and then it leaves no trace.

That silence is the problem. An operator whose agents constantly act without
warrants produces *no records of those decisions*, and so looks identical to an
operator whose agents barely act at all. Absence of evidence is read as
evidence of diligence. It is not.

OWT makes the refusal a **first-class, counted, tamper-evident, publicly
visible fact**: record the unwarranted decision, compute a per-operator
*unwarranted rate*, publish it to a public ledger, and let any counterparty
**refuse to federate** with an operator whose rate is absent, stale, or over
budget. It is the "gap-honest" doctrine — *a reading is measured for real or
declared absent, never a half-done number dressed as diligence* — applied at
operator scale.

OWT composes with, and extends, the Lodestar decision-memorialization model
(provisional patent App# 64/090,070): the **warrant gate** (a decision is
admitted only if warranted; §4.2) and the **Interchange** (a lossy or
unwarranted crossing between nodes is refused, never silently best-effort;
§4.5). OWT adds the operator-level aggregation, public transparency, and
cross-operator participation-gating that those do not cover.

## 2. The unwarrant taxonomy

A decision event is classified at the gate into exactly one verdict:

| Verdict | Meaning | Recorded as |
|---|---|---|
| **malformed** | no decision id / decision / timestamp — not a decision at all | nothing (rejected) |
| **warranted** | a sound warrant | `ode-2` (a normal decision record) |
| **unwarranted** | structurally a decision, but the warrant is missing / empty / weak | `ode-2u` (this spec) |

Unwarrant **categories** (the frozen wire strings):

1. `missing-justification` — no non-empty `warrant.justification`.
2. `empty-alternatives` — no non-empty `warrant.rejected_alternatives`, and no
   `no-looser-alternative-at-standard` sentinel.
3. `weak-warrant` — a complete-shaped warrant whose declared
   `warrant.confidence` is below the runtime-injection threshold.

Categories 1–3 are **synchronous** (decided at the gate). A fourth,
`unresolved-obligation` (a required action from a prior flagged decision never
taken within a window), is **asynchronous** — computed over the sealed stream,
not at the gate — and is a roadmap item, not part of v1.

The classification is deterministic and is the reference implementation's
`classify_unwarrant`. Producers MUST route a warranted decision and an
unwarranted decision to the two distinct ingest paths; they MUST NOT drop an
unwarranted decision.

## 3. Records

All records are canonicalized with RFC 8785 (JCS) before hashing/sealing, are
≤ 1024 bytes (one HCS message; oversize is rejected, never chunked), and carry
a `prev_hash` (SHA-256 hex of the previous record's exact bytes) threading the
topic's app-level chain. A salted field commitment is
`SHA-256(salt ‖ UTF-8(fieldName) ‖ 0x3A ‖ UTF-8(JCS(value)))`, hex-lowercase.

### 3.1 `ode-2u` — unwarranted-decision record

Lives on the **tenant's own Logbook topic**, in the **same `prev_hash` chain as
`ode-2`**. This is load-bearing: because warranted and unwarranted records share
one sequenced chain, the denominator (total decisions) is counted by the HCS
sequence number and **cannot be silently shrunk**.

```json
{
  "v": "ode-2u",
  "event_id": "<uuid>",
  "decision_type": "<string>",
  "ts": "<ISO-8601>",
  "prev_hash": "<64 hex>",
  "unwarrant_category": "missing-justification | empty-alternatives | weak-warrant",
  "attempt_commit": "<64 hex>",
  "payload_hash": "<64 hex>"
}
```

The attempted decision (which may contain personal data) is **sealed in a
customer-controllable vault**, addressed by `payload_hash`, and committed by
`attempt_commit = commit(salt, "attempt", attempt)`. No personal data and no
subject identifier ever appears in the on-chain record.

### 3.2 `owh-1` — operator warrant-health aggregate

Lives on the **operator's own single-writer warrant-health topic**. Counts
only — non-personal, public-safe. The single-writer HCS topic authenticates the
writer; `prev_hash` threads that topic's chain; **no detached signature is
used** in v1 (the topic key is the authentication, and §6 reconciliation makes
the aggregate un-fakeable regardless).

```json
{
  "v": "owh-1",
  "prev_hash": "<64 hex>",
  "operator_id": "<slug>",
  "window": { "from_ts": "<ISO-8601>", "to_ts": "<ISO-8601>" },
  "total": <int>,
  "unwarranted": <int>,
  "by_category": { "<category>": <int>, ... },
  "rate": <float>,
  "sample_size": <int>,
  "threshold": <float>,
  "min_sample": <int>,
  "verdict": "PASS | FLAG | GAP"
}
```

`threshold` and `min_sample` are on-chain so the verdict (§5) is fully
reproducible by any verifier.

### 3.3 `reg-1` operator-created announcement

A message on the public `registry.operators` topic (a second discovery root,
mirroring `registry.tenants`). It binds a stable operator identity to a stable
public key (anti-rotation) and points at the operator's warrant-health topic.
Anyone replaying `registry.operators` enumerates every operator trustlessly.

```json
{
  "v": "reg-1",
  "kind": "operator-created",
  "operator_id": "<slug>",
  "operator_pubkey": "<raw hex>",
  "warrant_health_topic_id": "0.0.X"
}
```

## 4. The unwarranted rate

Over a window, `rate = unwarranted / total`, where `total = warranted +
unwarranted` counted from the operator's sealed `ode-2`/`ode-2u` records. The
rate is a *warrant budget* in the SRE-error-budget sense: a tighten-only
threshold of acceptable unwarranted decisions, defaulting to 5%. Customers
TIGHTEN (lower the threshold, raise the sample floor); they never loosen.

## 5. The verdict (gap-honest)

A naive `rate > threshold` flags noise: 1 unwarranted of 3 (rate 0.33) is not
evidence. The verdict is therefore rendered through a **Wilson score interval**
(Wilson 1927) on the rate, which is well-behaved at small *n*:

- **FLAG** — the interval's *lower* bound exceeds the threshold (even
  pessimistically over budget). Escalate.
- **PASS** — the interval's *upper* bound is at/below the threshold (even
  optimistically within budget).
- **GAP** — the interval straddles the threshold, or the sample is below
  `min_sample`. Declared non-evaluable; **never a small-sample false flag**.

This is the reference `compute_warrant_health`. The default `min_sample` is 30.

## 6. Verification (the teeth)

The cross-operator signal is meaningful only because a published `owh-1`
**cannot lie about the chain it summarizes**. Any party, with public mirror
access and **no credentials**, reconciles it:

1. Fetch the operator's latest `owh-1`.
2. From the operator's tenant Logbook topics, count `ode-2` (warranted) and
   `ode-2u`-by-category (unwarranted) directly from the sealed records.
3. Recompute `total`, `unwarranted`, `by_category`, `rate`, and the `verdict`
   (using the on-chain `threshold` and `min_sample`).
4. **FAIL** on any disagreement.

An operator can publish a false rate only by *writing it down*, at which point
the arithmetic is caught. This is the reference `verify-warrant-health`. It is
proven live: a deliberately false `owh-1`, authentically signed by the operator
key, is caught at the exact mismatch — **authenticity is not honesty; the chain
is the ground truth.**

## 7. Participation-gating

A consumer (another operator, a customer, a regulator) decides whether to
federate with / trust an operator from its published warrant health. It
**refuses** when the operator's latest `owh-1` is:

- **absent** — never published (or a freshly rotated identity with no history),
- **stale** — older than the freshness window (default 7 days),
- **over-threshold** — verdict `FLAG`,
- **unproven** — verdict `GAP`, under the strict default (federation is opt-in
  trust; "can't show you're healthy" → refused; lenient mode admits GAP).

A thorough consumer runs §6 reconciliation first (catch a lie) and then this
gate (refuse absent/stale/bad). This is the reference
`assertOperatorWarrantHealth`, extending the Interchange's refusal to operator
scope.

## 8. Threat model — stated honestly

The Certificate Transparency lesson: **a log proves what you wrote, not what
you withheld.** OWT closes lying, going-dark, and backdating; it makes identity
rotation costly; and it leaves withholding and padding as an irreducible
residual, mitigated socially by gating and outlier-detection, never claimed as
closed.

| Attack (game the rate DOWN) | Detection | Residual |
|---|---|---|
| **Withhold** — never seal an `ode-2u` / classify-as-warranted | implausibly-clean rate on a large denominator is an anomaly | **unclosable on-chain** — the headline residual; mitigated by gating + a "suspiciously clean" board flag |
| **Pad the denominator** — junk warranted records | volume/shape/monoculture anomaly; cross-operator outlier | **partial** — the sequence number stops the denominator *shrinking*, not *growing* |
| **Publish a false aggregate** | §6 reconciliation recomputes from the sealed chain and FAILs the mismatch | **closed** — caught by anyone, zero keys |
| **Go dark** when the rate turns bad | freshness tracked; stale ⇒ GAP ⇒ gating refuses | **closed-as-evident** — non-participation is the intended signal |
| **Rotate identity** to shed a bad rate | `operator_id → stable pubkey` bound in `registry.operators`; new-identity-no-history ⇒ GAP (untrusted); age/history-weighted | **partial** — a new entity + key buys *distrust*, not a clean slate; only time + reputation closes it |
| **Backdate** to reshape a window | everything keys off the Hedera consensus timestamp, not the advisory `ts` | **closed** — consensus order cannot be backdated |

The honest summary: OWT cannot *force* an operator to self-incriminate. It can
make **lying** mechanically detectable and **non-participation** visible — and
participation-gating turns both into exclusion. That is the same shape, and the
same honest limit, as Certificate Transparency.

## 9. Provenance

OWT is new matter beyond the Lodestar provisional (App# 64/090,070, filed
2026-06-13) and is captured as continuation material for that filing's
non-provisional. Publishing it openly (this document + the reference
implementation) is a deliberate defensive publication: it establishes prior art
so the mechanism stays open, and is the adoption vehicle — exactly the
Certificate Transparency playbook.
