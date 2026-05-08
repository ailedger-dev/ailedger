# ADR 015 — Dogfeed sidecar pattern (Bob-decoupled usage telemetry)

- **Status:** Accepted
- **Date:** 2026-05-03
- **Bead:** ai-4vp
- **Authority:** [PINNED] `~/gt-lab/memory/feedback_bob_never_on_ailedger_proxy.md` · `docs/HANDOFF.md` §6.7
- **Supersedes the dogfood routing prescribed by ADR-013 for Bob's session.** ADR-013 still applies to NON-Bob agents (polecats, Angela, John, customer flows).

## Context

On **2026-04-29 ~10am PT → 2026-04-30 ~11:20am PT (~24+ hours)**, Bob (Mayor of the Jake silo) was completely offline because `mayor/.claude/settings.json` had `ANTHROPIC_BASE_URL=https://proxy.ailedger.dev/proxy/anthropic` (per ADR-013 dogfood routing) and the AILedger proxy worker was failing every request with HTTP 500 / Cloudflare error 1101. The proxy regression itself was a missing `canonicalize` npm dependency in `proxy/node_modules/`, which had silently broken every CI deploy since 2026-04-13.

Outage post-mortem in one line: **Bob's lifeline rode AILedger uptime.** AILedger is a pre-revenue product Jake is building; it WILL break repeatedly. Routing Bob's request path through it makes Bob's reliability ≤ AILedger's reliability — unacceptable for the system's main coordinator during steady-state sales cadence + Anand meeting prep window.

Jake (2026-04-30): *"this is completely unacceptable. we are closing deals over on the angela side. i am not happy with you... your runtime must be 100% ALWAYS"*

The hard rule is now: **Bob's request path NEVER touches AILedger.** But we still want Bob's usage telemetry as the AILedger dogfood signal — Jake's own Claude Code traffic is the highest-fidelity ground truth we have for what the receiver-side will actually see in the wild.

## Decision

Ship usage telemetry as a **write-aside sidecar**, not an in-line proxy:

1. **Capture (in-process, write-aside).** A Claude Code `Stop` / `PostToolUse` hook (`dogfeed-capture`) appends one JSONL line to a local queue (`~/gt-lab/.dogfeed/queue.jsonl`). Hard 200ms timeout via `SIGALRM`. All failures swallowed. **Always exits 0.** Bob never sees an error from the hook.
2. **Drain (out-of-process, async).** A user-systemd timer (`dogfeed-drain.timer`, 5-min cadence, `Persistent=true`) batches up to 100 events and POSTs them to `${AILEDGER_PROXY_URL}/v1/events` with `x-ailedger-key`. On 2xx, sent lines are truncated. On 5xx / network failure, the queue is left intact and exponential backoff is bumped. After 24h sustained failure, fire `notify-phone --topic dogfeed-stalled` once (with cooldown) so Jake notices.
3. **Receiver (this repo's Worker).** `POST /v1/events` validates schema, dedupes by `(tenant_id, event_id)` for 7 days via KV, appends to `ledger.dogfeed_events`, returns `{accepted, rejected[]}`. 4xx on auth/schema (client gives up), 5xx on storage failure (client retries).

The data path is **unidirectional and decoupled**: Bob writes locally, the drain ships eventually. Any failure on the AILedger side stays on the AILedger side.

## Failure-mode matrix

> **Required reading.** This is the table the rule lives or dies by.

| Failure | What goes wrong | Bob impact | Telemetry impact |
|---|---|---|---|
| AILedger proxy worker outage (the 2026-04-29 case) | `POST /v1/events` 5xx or unreachable | **None** — capture only writes to disk; Bob's request path never calls the proxy | Drain holds the queue, backs off; ships when proxy recovers |
| Network down / DNS broken on Jake's laptop | `urllib.urlopen` raises `URLError` | **None** — capture is local-only | Drain holds queue + backoff; queues survive across reboots; eventual ship on reconnect |
| Disk full at `~/gt-lab/.dogfeed/` | `dogfeed-capture` write raises `OSError` | **None** — the `try/except` swallows it and the script still exits 0 | Events lost for the duration of the disk-full state; queue resumes once disk frees |
| Drain script broken (bug, 50MB cap hit, malformed line) | Drain may crash, or FIFO-drop oldest 10MB on cap breach | **None** — drain runs in its own systemd unit, completely separate from Bob's process tree | Bumps `~/gt-lab/.dogfeed/dropped.counter`; sustained drain failure pages via `notify-phone` after 24h |
| Capture hook itself broken (bad envelope, Python crash) | `dogfeed-capture` raises before write | **None** — the script's `main()` is wrapped in a bare `except:` that always reaches `sys.exit(0)`; SIGALRM cap means even a wedged hook can't block Bob past 200ms | Single event lost; next hook fires fine |

The key invariant: **every column in the "Bob impact" row says None.** That's the whole point of the pattern.

## Rejected alternatives

### A. In-line proxy routing (the status quo we are leaving)
Route Bob's `ANTHROPIC_BASE_URL` through `proxy.ailedger.dev` (ADR-013).
- ✗ Caused the 2026-04-29 outage.
- ✗ Bob's reliability ≤ AILedger's reliability — structurally wrong.
- ✓ Simple — single config flip.
- **Verdict:** rejected. The simplicity is a trap; we already paid for it.

### B. OpenTelemetry exporter (OTLP/HTTP)
Run a local OTel collector that batches + ships spans.
- ✗ More infra (collector binary, config, agent supervision) for the same outcome.
- ✗ Schema impedance mismatch — OTel spans don't natively carry `input_tokens` / `output_tokens` / `tool_name` cleanly; we'd be shoving them into resource attributes.
- ✗ Adds a non-stdlib dependency surface (Python OTel SDK, gRPC libs) that violates the bead's "stdlib only" constraint.
- ✓ Industry-standard, observability-native.
- **Verdict:** rejected. The cost-benefit is upside-down for our scale (one-laptop dogfood) — we're not running a 50-service mesh.

### C. Wrap the Claude Code SDK runtime (in-process telemetry)
Inject a logging shim into Claude Code itself.
- ✗ We don't own Bob's runtime — Anthropic ships Claude Code; we'd be patching upstream.
- ✗ Every Claude Code update could silently break the shim, regressing telemetry without warning.
- ✗ A bug in the shim could crash Bob (the exact failure mode the sidecar is designed to prevent).
- ✓ Highest-fidelity capture (sees the full request/response).
- **Verdict:** rejected. Right pattern wrong layer — observability of someone else's runtime should be observational, not invasive.

### D. Just Logpush from Cloudflare Workers
Have the Worker side log usage and skip the client side entirely.
- ✗ Doesn't apply — we explicitly cannot route Bob through the Worker, so there is no Worker-side hook for Bob's traffic.
- ✗ Conflates with the ADR-013 inference-logging path, which is a separate stream.
- **Verdict:** rejected. Solves the wrong problem.

## Consequences

**Positive:**
- Bob's runtime SLO becomes independent of AILedger uptime. The 2026-04-29 class of outage is structurally impossible.
- Receiver lives at `/v1/events` — a clean, separable surface that any future client (Angela, John, customer SDKs) can target. Reuses the existing `x-ailedger-key` auth.
- Stdlib-only client means the install is `cp + chmod + systemd link` — no `pip` step, no venv, no version-skew risk.
- Idempotency at both layers (KV + Postgres unique index) means retries are always safe.

**Negative:**
- Telemetry is now eventually-consistent — events can lag by minutes during normal operation, hours during a proxy outage. Acceptable for dogfood signal; would not be acceptable for billing-critical paths.
- Two new operational surfaces to monitor: queue depth and drain lag. Mitigated by the `notify-phone` fallback after 24h sustained failure and the `dropped.counter` for FIFO trims.
- Adds a Supabase table (`ledger.dogfeed_events`) and a KV key prefix (`dogfeed_evt:*`) that need to be remembered when reviewing storage costs.
