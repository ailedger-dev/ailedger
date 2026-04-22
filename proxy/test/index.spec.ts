import { describe, it, expect } from 'vitest';
import { isJsonContentType, sha256jcs } from '../src/index';

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe('isJsonContentType', () => {
	it('matches application/json with and without charset', () => {
		expect(isJsonContentType('application/json')).toBe(true);
		expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
		expect(isJsonContentType('APPLICATION/JSON')).toBe(true);
	});

	it('matches +json suffix types', () => {
		expect(isJsonContentType('application/vnd.api+json')).toBe(true);
		expect(isJsonContentType('application/ld+json; charset=utf-8')).toBe(true);
	});

	it('rejects non-JSON content types', () => {
		expect(isJsonContentType(null)).toBe(false);
		expect(isJsonContentType(undefined)).toBe(false);
		expect(isJsonContentType('')).toBe(false);
		expect(isJsonContentType('text/plain')).toBe(false);
		expect(isJsonContentType('text/event-stream')).toBe(false);
		expect(isJsonContentType('multipart/form-data; boundary=x')).toBe(false);
		expect(isJsonContentType('application/octet-stream')).toBe(false);
	});
});

describe('sha256jcs — JSON canonicalization path', () => {
	it('produces the same hash for semantically-equal JSON with different key order', async () => {
		const a = enc('{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}');
		const b = enc('{"messages":[{"content":"hi","role":"user"}],"model":"gpt-4"}');
		const ha = await sha256jcs(a, 'application/json');
		const hb = await sha256jcs(b, 'application/json');
		expect(ha).toBe(hb);
		expect(ha).toMatch(/^[0-9a-f]{64}$/);
	});

	it('ignores insignificant whitespace', async () => {
		const compact = enc('{"a":1,"b":[2,3]}');
		const spaced = enc('{\n  "a": 1,\n  "b": [ 2, 3 ]\n}');
		const hc = await sha256jcs(compact, 'application/json');
		const hs = await sha256jcs(spaced, 'application/json');
		expect(hc).toBe(hs);
	});

	it('canonicalizes integer number representations (1.0 vs 1 differ by design per RFC 8785 §3.2.2.3)', async () => {
		// RFC 8785 uses ECMAScript Number.toString, where 1 and 1.0 parse to the
		// same double and serialize identically. Pin that behavior.
		const withInt = enc('{"n":1}');
		const withFloat = enc('{"n":1.0}');
		const h1 = await sha256jcs(withInt, 'application/json');
		const h2 = await sha256jcs(withFloat, 'application/json');
		expect(h1).toBe(h2);
	});

	it('matches the content-type + charset parameter form', async () => {
		const body = enc('{"a":1}');
		const h1 = await sha256jcs(body, 'application/json');
		const h2 = await sha256jcs(body, 'application/json; charset=utf-8');
		expect(h1).toBe(h2);
	});

	it('handles +json content-types', async () => {
		const a = enc('{"b":2,"a":1}');
		const b = enc('{"a":1,"b":2}');
		const ha = await sha256jcs(a, 'application/vnd.api+json');
		const hb = await sha256jcs(b, 'application/vnd.api+json');
		expect(ha).toBe(hb);
	});
});

describe('sha256jcs — raw-byte fallback path', () => {
	it('uses raw SHA-256 for non-JSON content (binary passthrough)', async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const raw = await crypto.subtle.digest('SHA-256', bytes);
		const rawHex = Array.from(new Uint8Array(raw))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');

		const h = await sha256jcs(bytes.buffer as ArrayBuffer, 'application/octet-stream');
		expect(h).toBe(rawHex);
	});

	it('falls back to raw-byte hash for multipart uploads', async () => {
		const body = enc('--x\r\nContent-Disposition: form-data\r\n\r\npayload\r\n--x--\r\n');
		const h = await sha256jcs(body, 'multipart/form-data; boundary=x');
		const rawBuf = await crypto.subtle.digest('SHA-256', new Uint8Array(body));
		const expected = Array.from(new Uint8Array(rawBuf))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		expect(h).toBe(expected);
	});

	it('falls back to raw-byte hash for SSE streams', async () => {
		// text/event-stream is non-JSON at the transport layer (even when each
		// `data:` line holds JSON). The proxy hashes the full assembled body.
		const sse = enc(
			'data: {"id":"1","delta":"Hel"}\n\n' +
			'data: {"id":"2","delta":"lo"}\n\n' +
			'data: [DONE]\n\n',
		);
		const h = await sha256jcs(sse, 'text/event-stream');
		const rawBuf = await crypto.subtle.digest('SHA-256', new Uint8Array(sse));
		const expected = Array.from(new Uint8Array(rawBuf))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		expect(h).toBe(expected);
	});

	it('falls back to raw-byte hash when content-type is missing', async () => {
		const body = enc('{"a":1}');
		const h = await sha256jcs(body, null);
		const rawBuf = await crypto.subtle.digest('SHA-256', new Uint8Array(body));
		const expected = Array.from(new Uint8Array(rawBuf))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		expect(h).toBe(expected);
	});

	it('falls back to raw bytes when content-type is JSON but body is malformed', async () => {
		const body = enc('not actually json {');
		const h = await sha256jcs(body, 'application/json');
		const rawBuf = await crypto.subtle.digest('SHA-256', new Uint8Array(body));
		const expected = Array.from(new Uint8Array(rawBuf))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		expect(h).toBe(expected);
	});
});

describe('sha256jcs — edge cases', () => {
	it('returns null for null input', async () => {
		expect(await sha256jcs(null, 'application/json')).toBeNull();
	});

	it('returns null for zero-byte input', async () => {
		expect(await sha256jcs(new ArrayBuffer(0), 'application/json')).toBeNull();
	});
});

describe('sha256jcs — streaming SSE reconstruction', () => {
	it('produces a stable hash when SSE chunks are accumulated into a single buffer', async () => {
		// Simulate the Workers pipeline: chunks arrive from upstream, get
		// concatenated into a single ArrayBuffer, then hashed. The hash must
		// equal the hash computed over the same bytes delivered as one blob.
		const chunks = [
			'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":" "}}]}\n\n',
			'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
			'data: [DONE]\n\n',
		];

		const encoder = new TextEncoder();
		const encoded = chunks.map((c) => encoder.encode(c));
		const total = encoded.reduce((n, c) => n + c.byteLength, 0);
		const reconstructed = new Uint8Array(total);
		let offset = 0;
		for (const c of encoded) {
			reconstructed.set(c, offset);
			offset += c.byteLength;
		}

		const oneShot = encoder.encode(chunks.join(''));

		const hReconstructed = await sha256jcs(
			reconstructed.buffer as ArrayBuffer,
			'text/event-stream',
		);
		const hOneShot = await sha256jcs(
			oneShot.buffer as ArrayBuffer,
			'text/event-stream',
		);
		expect(hReconstructed).toBe(hOneShot);
		expect(hReconstructed).toMatch(/^[0-9a-f]{64}$/);
	});

	it('JSON response assembled from streamed chunks hashes the same as the one-shot JSON, regardless of server-side key order', async () => {
		// Non-SSE JSON response (e.g. Anthropic non-streaming completion).
		// Two servers could emit the same object with different key order;
		// JCS collapses both to the same hash.
		const streamed = enc('{"id":"msg_1","model":"claude","usage":{"output_tokens":4,"input_tokens":2}}');
		const oneShot = enc('{"usage":{"input_tokens":2,"output_tokens":4},"model":"claude","id":"msg_1"}');

		const hStreamed = await sha256jcs(streamed, 'application/json');
		const hOneShot = await sha256jcs(oneShot, 'application/json');
		expect(hStreamed).toBe(hOneShot);
	});
});
