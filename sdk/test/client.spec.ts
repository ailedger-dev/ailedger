// Transport-layer tests for DetectionEventClient (v0.2.0)
//
// Mocks global fetch to exercise the proxy-response branches:
// 201 success, 401 auth, 422 validation, 429 rate-limit, 500 server, network failure.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DetectionEventClient } from '../src/client.js';
import {
  AILedgerAuthError,
  AILedgerRateLimitError,
  AILedgerServerError,
  AILedgerTransportError,
  AILedgerValidationError,
} from '../src/errors.js';

const TENANT_ID = '00000000-0000-0000-0000-00000000aaaa';
const SYSTEM_ID = '00000000-0000-0000-0000-00000000bbbb';
const EVENT_ID = '00000000-0000-0000-0000-00000000cccc';

function makeClient(): DetectionEventClient {
  return new DetectionEventClient({
    baseUrl: 'https://proxy.test.invalid',
    apiKey: 'agl_sk_test',
    tenantId: TENANT_ID,
    systemId: SYSTEM_ID,
  });
}

function mockFetchOnce(status: number, body: unknown, headers: Record<string, string> = {}): void {
  const responseHeaders = new Headers({
    'Content-Type': 'application/json',
    ...headers,
  });
  globalThis.fetch = vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers: responseHeaders }),
  );
}

describe('DetectionEventClient.emit transport', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a canonical event and merges populated chain fields', async () => {
    const populated = {
      event_id: EVENT_ID,
      hash_chain_prev: '0'.repeat(64),
      hash_chain_self: 'a'.repeat(64),
    };
    mockFetchOnce(201, { event: populated });

    const client = makeClient();
    const result = await client.emit({
      eventId: EVENT_ID,
      rawInputs: { hello: 'world' },
      decisionType: 'employment_screening',
      confidence: 0.85,
    });

    expect(result.event_id).toBe(EVENT_ID);
    expect(result.hash_chain_prev).toBe('0'.repeat(64));
    expect(result.hash_chain_self).toBe('a'.repeat(64));
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://proxy.test.invalid/v2/detection-events',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('strips trailing slash from baseUrl', async () => {
    mockFetchOnce(201, { event: null });
    const client = new DetectionEventClient({
      baseUrl: 'https://proxy.test.invalid/',
      apiKey: 'agl_sk_test',
      tenantId: TENANT_ID,
      systemId: SYSTEM_ID,
    });
    await client.emit({ eventId: EVENT_ID, rawInputs: null });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://proxy.test.invalid/v2/detection-events',
      expect.anything(),
    );
  });

  it('sends x-ailedger-key header', async () => {
    mockFetchOnce(201, { event: null });
    const client = makeClient();
    await client.emit({ eventId: EVENT_ID, rawInputs: null });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-ailedger-key']).toBe('agl_sk_test');
  });

  it('throws AILedgerAuthError on 401', async () => {
    mockFetchOnce(401, { error: 'Invalid API key' });
    const client = makeClient();
    await expect(
      client.emit({ eventId: EVENT_ID, rawInputs: null }),
    ).rejects.toBeInstanceOf(AILedgerAuthError);
  });

  it('throws AILedgerValidationError on 400', async () => {
    mockFetchOnce(400, { error: 'event_id must be a UUID' });
    const client = makeClient();
    await expect(
      client.emit({ eventId: EVENT_ID, rawInputs: null }),
    ).rejects.toBeInstanceOf(AILedgerValidationError);
  });

  it('throws AILedgerValidationError on 422 (CHECK constraint)', async () => {
    mockFetchOnce(422, { error: 'Schema constraint violated' });
    const client = makeClient();
    await expect(
      client.emit({ eventId: EVENT_ID, rawInputs: null }),
    ).rejects.toBeInstanceOf(AILedgerValidationError);
  });

  it('throws AILedgerRateLimitError on 429 with retry-after', async () => {
    mockFetchOnce(429, { error: 'limit reached' }, { 'retry-after': '60' });
    const client = makeClient();
    try {
      await client.emit({ eventId: EVENT_ID, rawInputs: null });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AILedgerRateLimitError);
      const rateErr = err as AILedgerRateLimitError;
      expect(rateErr.retryAfterSeconds).toBe(60);
    }
  });

  it('throws AILedgerServerError on 500', async () => {
    mockFetchOnce(500, { error: 'Upstream storage error' });
    const client = makeClient();
    await expect(
      client.emit({ eventId: EVENT_ID, rawInputs: null }),
    ).rejects.toBeInstanceOf(AILedgerServerError);
  });

  it('throws AILedgerTransportError on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed'));
    const client = makeClient();
    await expect(
      client.emit({ eventId: EVENT_ID, rawInputs: null }),
    ).rejects.toBeInstanceOf(AILedgerTransportError);
  });
});

describe('DetectionEventClient.emitInferred transport', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('emits inferred event with extractor metadata + hashes params client-side', async () => {
    const populated = {
      event_id: EVENT_ID,
      hash_chain_self: 'b'.repeat(64),
    };
    mockFetchOnce(201, { event: populated });

    const client = makeClient();
    const result = await client.emitInferred({
      eventId: EVENT_ID,
      anchorEventId: '00000000-0000-0000-0000-00000000eeee',
      extractorMethod: 'detection.parse',
      extractorModel: 'claude-haiku-4-5-20251001',
      extractorParams: {
        trace_source: 'chain-of-thought',
        parse_strategy: 'pattern-match',
        parse_strategy_version: 'v1.0',
        ontology_ref: 'ailedger-generic:v0.1.0',
      },
      extractionStartedAt: new Date('2026-05-18T12:00:00.000Z'),
      extractionComputeMs: 42,
    });

    expect(result.event_id).toBe(EVENT_ID);
    expect(result.extractor_method).toBe('detection.parse');
    expect(result.extractor_params_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.hash_chain_self).toBe('b'.repeat(64));
  });
});
