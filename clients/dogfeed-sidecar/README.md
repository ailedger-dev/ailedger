# dogfeed-sidecar

Local-write / async-drain Claude Code usage telemetry that ships to AILedger
without ever sitting in the request path.

**Authority:** [ADR 015](../../docs/adr/015-dogfeed-sidecar-pattern.md), bead `ai-4vp`,
[PINNED] `~/gt-lab/memory/feedback_bob_never_on_ailedger_proxy.md`.

This exists because Bob's runtime cannot ride AILedger uptime — see the ADR
for the 2026-04-29 outage that drove the rule.

## Pieces

```
clients/dogfeed-sidecar/
├── bin/
│   ├── dogfeed-capture        # Claude Code Stop / PostToolUse hook
│   └── dogfeed-drain          # systemd-fired, ships batched events
├── systemd/
│   ├── dogfeed-drain.service  # oneshot drain unit
│   └── dogfeed-drain.timer    # every 5 minutes, Persistent=true
├── install.sh                 # idempotent install
└── README.md
```

Queue lives at `~/gt-lab/.dogfeed/queue.jsonl`. Secrets at `~/gt-lab/.secrets/dogfeed.env`
(chmod 600). Drain state at `~/gt-lab/.dogfeed/drain.state.json`. Dropped-event
counter at `~/gt-lab/.dogfeed/dropped.counter`.

## Install

```bash
bash clients/dogfeed-sidecar/install.sh
```

The script is idempotent and prints the exact Claude Code hook config snippet
to add. Re-running it re-copies binaries, leaves the secrets file alone if
it already exists, and reloads the systemd timer.

After install:

1. Edit `~/gt-lab/.secrets/dogfeed.env`. Replace `REPLACE_WITH_alg_sk_KEY` with
   a real `alg_sk_*` key.
2. Add the printed hook block to `~/.claude/settings.json` (or, for Bob,
   `mayor/.claude/settings.json` — Jake / Bob installs that side per ai-4vp
   off-limits policy).
3. Restart Claude Code so the hook config takes effect.

The hook block (also printed by `install.sh`) looks like:

```json
{
  "hooks": {
    "Stop": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "/home/<you>/gt-lab/bin/dogfeed-capture" }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "/home/<you>/gt-lab/bin/dogfeed-capture" }] }
    ]
  }
}
```

## Verify the queue is draining

```bash
# 1. Are events being captured?
ls -lh ~/gt-lab/.dogfeed/queue.jsonl
tail -1 ~/gt-lab/.dogfeed/queue.jsonl | jq

# 2. Is the timer running?
systemctl --user status dogfeed-drain.timer

# 3. When did the last drain fire and what happened?
journalctl --user -u dogfeed-drain.service -n 50 --no-pager

# 4. Are there backoff or dropped events?
cat ~/gt-lab/.dogfeed/drain.state.json
cat ~/gt-lab/.dogfeed/dropped.counter 2>/dev/null
```

Healthy steady state: `queue.jsonl` shrinks back to zero (or near zero) every
5 minutes; `drain.state.json` shows `backoff_s: 0` and a recent
`last_success_ts`; `dropped.counter` is absent or unchanging.

## Failure-mode matrix

Five rows. **Bob impact column is "None" in every row** — that's the whole point.

| Failure | What goes wrong | Bob impact | Telemetry impact |
|---|---|---|---|
| AILedger proxy worker outage | `POST /v1/events` 5xx or unreachable | **None** — capture is local-only | Queue holds; drain backs off + retries on schedule |
| Network down / DNS broken | `urllib.urlopen` raises | **None** — capture is local-only | Queue persists across reboots; eventual ship on reconnect |
| Disk full at `~/gt-lab/.dogfeed/` | Capture's `os.write` raises | **None** — script swallows + `sys.exit(0)` | Events lost during disk-full window; resumes when freed |
| Drain script broken / 50MB cap hit | Drain crashes or FIFO-drops oldest 10MB | **None** — drain runs in its own systemd unit, separate from Bob | Bumps `dropped.counter`; pages via `notify-phone --topic dogfeed-stalled` after 24h sustained failure |
| Capture hook itself broken | Capture raises before write | **None** — outer `try/except` + 200ms SIGALRM cap | Single event lost; next hook fires fine |

## Debug

**Capture not appending:**
```bash
echo '{"model":"test","usage":{"input_tokens":1,"output_tokens":2}}' \
  | DOGFEED_QUEUE_DIR=/tmp/dogfeed-debug ~/gt-lab/bin/dogfeed-capture
ls /tmp/dogfeed-debug/queue.jsonl
```
If the file isn't there, the script either timed out (>200ms — unlikely) or
hit a permission error on the queue dir.

**Drain returning 401:**
The `AILEDGER_KEY` in `~/gt-lab/.secrets/dogfeed.env` is missing or wrong.
The receiver writes `dogfeed:storage-failed` to Cloudflare Workers logs on
failure — check Logpush if you have access.

**Drain returning 4xx for a single batch:**
That batch is dropped locally and counted in `dropped.counter`. Check the
drain logs for the per-event `reason` field returned by `/v1/events`. Common
cause: clock skew making `ts` invalid, or a Claude Code envelope shape we
didn't anticipate.

**Drain holding indefinitely with backoff growing:**
Check connectivity (`curl -fsS https://proxy.ailedger.dev/health`). If that
returns ok but drain still 5xx's, check the receiver-side Supabase table
exists (`ledger.dogfeed_events` — see `proxy/migrations/20260503_dogfeed_events.sql`).

**`dropped.counter` ticking up unexpectedly:**
Either the queue exceeded 50MB (drain isn't keeping up — check timer cadence)
or the receiver is rejecting batches for schema reasons.

## What this does NOT do

- Modify `mayor/.claude/settings.json`. The hook snippet is printed but
  never written; Bob installs that side. (Per ai-4vp off-limits policy.)
- Touch existing AILedger inference logging (`inference_logs` table,
  `logInference()`). This is an additive path; nothing about the proxy
  request flow changes.
- Add `pip` dependencies. Stdlib only by design — the install must work
  on a clean laptop.
- Offer a tail / live-monitor mode. Use `journalctl --user -fu dogfeed-drain.service`
  for that.

## Acceptance reproduction

```bash
# 1. Tests pass.
cd proxy && npm test && npm run canary

# 2. Install runs cleanly on a fresh fake home.
TMP=$(mktemp -d) GT_LAB_ROOT="$TMP/gt-lab" \
  bash clients/dogfeed-sidecar/install.sh

# 3. Capture writes a JSONL line under 200ms.
echo '{"model":"x","usage":{"input_tokens":1,"output_tokens":1}}' \
  | DOGFEED_QUEUE_DIR="$TMP/q" "$TMP/gt-lab/bin/dogfeed-capture"
test -s "$TMP/q/queue.jsonl"
```
