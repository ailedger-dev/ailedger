// Ack semantics — queued → sealed polling against a fake indexer.
import { describe, expect, it } from 'vitest';
import { fetchSealed, waitForSealed } from '../src/evidence/ack.js';

function fakeFetch(responses: Array<{ status: number; body?: unknown }>): typeof fetch {
  let i = 0;
  return (async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: async () => r.body,
    } as Response;
  }) as unknown as typeof fetch;
}

describe('ack: queued → sealed', () => {
  it('fetchSealed reports not-sealed on 404, sealed on 200', async () => {
    expect(await fetchSealed('http://ix', 'e1', { fetchImpl: fakeFetch([{ status: 404 }]) })).toEqual({
      sealed: false,
    });
    const sealed = await fetchSealed('http://ix', 'e1', {
      fetchImpl: fakeFetch([{ status: 200, body: { event_id: 'e1', seq: 5 } }]),
    });
    expect(sealed).toEqual({ sealed: true, event: { event_id: 'e1', seq: 5 } });
  });

  it('waitForSealed polls until the event appears', async () => {
    const fetchImpl = fakeFetch([{ status: 404 }, { status: 404 }, { status: 200, body: { event_id: 'e1' } }]);
    let clock = 0;
    const status = await waitForSealed('http://ix', 'e1', {
      fetchImpl,
      intervalMs: 10,
      timeoutMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(status.sealed).toBe(true);
  });

  it('waitForSealed returns not-sealed (no throw) on timeout', async () => {
    let clock = 0;
    const status = await waitForSealed('http://ix', 'e1', {
      fetchImpl: fakeFetch([{ status: 404 }]),
      intervalMs: 10,
      timeoutMs: 25,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(status.sealed).toBe(false);
  });

  it('fetchSealed throws on a non-404 error status', async () => {
    await expect(
      fetchSealed('http://ix', 'e1', { fetchImpl: fakeFetch([{ status: 500 }]) }),
    ).rejects.toThrow(/indexer 500/);
  });
});
