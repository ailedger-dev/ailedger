// Ack semantics — queued → sealed.
//
// The relay acks a decision as `queued` (202): durably enqueued, consensus is
// ~2 s away. "Sealed" means the record reached consensus and the indexer
// ingested it from the mirror. This helper closes that gap: poll the indexer's
// /v1/events/:id until the event appears (sealed) or a deadline passes.
//
// Keyless and read-only — points at any indexer instance (operator-run or your
// own). now/sleep/fetch are injectable so the loop is unit-testable with no
// real timers or network.

export interface SealedStatus {
  sealed: boolean;
  /** The indexer's derived event row, present once sealed. */
  event?: Record<string, unknown>;
}

export interface SealedPollOptions {
  fetchImpl?: typeof fetch;
}

export interface WaitForSealedOptions extends SealedPollOptions {
  /** Give up after this long (default 30 s). */
  timeoutMs?: number;
  /** Delay between polls (default 1 s). */
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** One poll: is this event sealed (indexed) yet? */
export async function fetchSealed(
  indexerBase: string,
  eventId: string,
  opts: SealedPollOptions = {},
): Promise<SealedStatus> {
  const f = opts.fetchImpl ?? fetch;
  const url = `${indexerBase.replace(/\/$/, '')}/v1/events/${encodeURIComponent(eventId)}`;
  const res = await f(url);
  if (res.status === 404) return { sealed: false };
  if (!res.ok) throw new Error(`indexer ${res.status} polling event ${eventId}`);
  return { sealed: true, event: (await res.json()) as Record<string, unknown> };
}

/**
 * Poll until the event is sealed or the timeout elapses. Resolves
 * { sealed: false } on timeout rather than throwing — a not-yet-sealed event is
 * an expected state, not an error. Transport/HTTP errors still throw.
 */
export async function waitForSealed(
  indexerBase: string,
  eventId: string,
  opts: WaitForSealedOptions = {},
): Promise<SealedStatus> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + timeoutMs;
  for (;;) {
    const status = await fetchSealed(indexerBase, eventId, opts);
    if (status.sealed) return status;
    if (now() >= deadline) return { sealed: false };
    await sleep(intervalMs);
  }
}
