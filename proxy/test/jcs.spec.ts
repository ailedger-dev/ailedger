import { describe, it, expect } from "vitest";
import fc from "fast-check";
import canonicalize from "canonicalize";
import { sha256jcs, isJsonContentType } from "../src";

// ─── Helpers ────────────────────────────────────────────────────────────────

function toAB(s: string): ArrayBuffer {
	const u8 = new TextEncoder().encode(s);
	const ab = new ArrayBuffer(u8.byteLength);
	new Uint8Array(ab).set(u8);
	return ab;
}

function bytesToAB(bytes: number[]): ArrayBuffer {
	const ab = new ArrayBuffer(bytes.length);
	new Uint8Array(ab).set(bytes);
	return ab;
}

async function sha256hexLocal(input: string | Uint8Array): Promise<string> {
	const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
	const h = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(h))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// ─── isJsonContentType ──────────────────────────────────────────────────────

describe("isJsonContentType", () => {
	it("matches bare application/json", () => {
		expect(isJsonContentType("application/json")).toBe(true);
	});

	it("strips parameters after semicolon (charset)", () => {
		expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isJsonContentType("APPLICATION/JSON")).toBe(true);
		expect(isJsonContentType("Application/Json")).toBe(true);
	});

	it("matches +json structured suffix", () => {
		expect(isJsonContentType("application/vnd.api+json")).toBe(true);
	});

	it("matches +json with charset parameter", () => {
		expect(
			isJsonContentType("application/vnd.openai+json; charset=utf-8"),
		).toBe(true);
	});

	it("rejects text/plain", () => {
		expect(isJsonContentType("text/plain")).toBe(false);
	});

	it("rejects application/octet-stream", () => {
		expect(isJsonContentType("application/octet-stream")).toBe(false);
	});

	it("rejects multipart/form-data", () => {
		expect(isJsonContentType("multipart/form-data; boundary=abc")).toBe(false);
	});

	it("rejects text/event-stream (SSE)", () => {
		expect(isJsonContentType("text/event-stream")).toBe(false);
	});

	it("rejects null, undefined, empty string", () => {
		expect(isJsonContentType(null)).toBe(false);
		expect(isJsonContentType(undefined)).toBe(false);
		expect(isJsonContentType("")).toBe(false);
	});
});

// ─── sha256jcs: hash stability (core value prop) ────────────────────────────

describe("sha256jcs hash stability (RFC 8785)", () => {
	it("key-reordered top-level JSON produces same hash", async () => {
		const a = await sha256jcs(toAB('{"a":1,"b":2}'), "application/json");
		const b = await sha256jcs(toAB('{"b":2,"a":1}'), "application/json");
		expect(a).toBe(b);
		expect(a).not.toBeNull();
	});

	it("whitespace-only differences produce same hash", async () => {
		const a = await sha256jcs(toAB('{"a":1}'), "application/json");
		const b = await sha256jcs(toAB('{ "a" : 1 }'), "application/json");
		const c = await sha256jcs(
			toAB('{\n  "a":\t1\n}'),
			"application/json",
		);
		expect(a).toBe(b);
		expect(a).toBe(c);
	});

	it("nested objects with permuted inner keys produce same hash", async () => {
		const a = await sha256jcs(
			toAB('{"x":{"a":1,"b":2},"y":3}'),
			"application/json",
		);
		const b = await sha256jcs(
			toAB('{"y":3,"x":{"b":2,"a":1}}'),
			"application/json",
		);
		expect(a).toBe(b);
	});

	it("array order is preserved (different order -> different hash)", async () => {
		const a = await sha256jcs(toAB("[1,2,3]"), "application/json");
		const b = await sha256jcs(toAB("[3,2,1]"), "application/json");
		expect(a).not.toBe(b);
	});

	it("numeric normalization: 1.0 and 1 hash identically", async () => {
		const a = await sha256jcs(toAB('{"n":1.0}'), "application/json");
		const b = await sha256jcs(toAB('{"n":1}'), "application/json");
		expect(a).toBe(b);
	});

	it("unicode strings hash identically across calls", async () => {
		const a = await sha256jcs(toAB('{"s":"café 🔒"}'), "application/json");
		const b = await sha256jcs(toAB('{"s":"café 🔒"}'), "application/json");
		expect(a).toBe(b);
		// And a different unicode string differs
		const c = await sha256jcs(toAB('{"s":"cafe 🔒"}'), "application/json");
		expect(a).not.toBe(c);
	});

	it("null/true/false literals are preserved", async () => {
		const a = await sha256jcs(
			toAB('{"a":null,"b":true,"c":false}'),
			"application/json",
		);
		const b = await sha256jcs(
			toAB('{"c":false,"a":null,"b":true}'),
			"application/json",
		);
		expect(a).toBe(b);
		const different = await sha256jcs(
			toAB('{"a":null,"b":false,"c":true}'),
			"application/json",
		);
		expect(a).not.toBe(different);
	});

	it("hash equals SHA-256(canonicalize(obj)) -- contract check against canonicalize lib", async () => {
		const obj = { b: 2, a: 1, arr: [3, 1, 2], nested: { z: 9, y: 8 } };
		const canonical = canonicalize(obj);
		expect(canonical).toBeDefined();
		const expected = await sha256hexLocal(canonical as string);
		const actual = await sha256jcs(
			toAB(JSON.stringify(obj)),
			"application/json",
		);
		expect(actual).toBe(expected);
	});
});

// ─── sha256jcs: content-type branching ──────────────────────────────────────

describe("sha256jcs content-type branching", () => {
	it("JSON body + application/json -> JCS path (key-order independent)", async () => {
		const a = await sha256jcs(toAB('{"a":1,"b":2}'), "application/json");
		const b = await sha256jcs(toAB('{"b":2,"a":1}'), "application/json");
		expect(a).toBe(b);
	});

	it("JSON body + text/plain -> raw-byte path (key-order sensitive)", async () => {
		const a = await sha256jcs(toAB('{"a":1,"b":2}'), "text/plain");
		const b = await sha256jcs(toAB('{"b":2,"a":1}'), "text/plain");
		expect(a).not.toBe(b);
		// And the raw-byte hash matches plain sha256 of the bytes
		const expected = await sha256hexLocal('{"a":1,"b":2}');
		expect(a).toBe(expected);
	});

	it("malformed JSON + application/json -> raw-byte fallback, no throw", async () => {
		const raw = "{not valid json";
		const result = await sha256jcs(toAB(raw), "application/json");
		const expected = await sha256hexLocal(raw);
		expect(result).toBe(expected);
	});

	it("JSON body + application/vnd.api+json -> JCS path", async () => {
		const a = await sha256jcs(
			toAB('{"a":1,"b":2}'),
			"application/vnd.api+json",
		);
		const b = await sha256jcs(
			toAB('{"b":2,"a":1}'),
			"application/vnd.api+json",
		);
		expect(a).toBe(b);
	});

	it("JSON body + null content-type -> raw-byte path", async () => {
		const a = await sha256jcs(toAB('{"a":1,"b":2}'), null);
		const expected = await sha256hexLocal('{"a":1,"b":2}');
		expect(a).toBe(expected);
	});
});

// ─── sha256jcs: fallback on exception ───────────────────────────────────────

describe("sha256jcs fallback on exception", () => {
	it("malformed JSON (parse throws) -> raw-byte fallback", async () => {
		const raw = "this is not JSON at all";
		const result = await sha256jcs(toAB(raw), "application/json");
		const expected = await sha256hexLocal(raw);
		expect(result).toBe(expected);
	});

	it("invalid UTF-8 bytes with JSON content-type -> raw-byte fallback", async () => {
		// 0xFF 0xFE are not valid UTF-8 start bytes; with fatal TextDecoder this throws.
		const invalid = bytesToAB([0xff, 0xfe, 0x7b, 0x7d]);
		const result = await sha256jcs(invalid, "application/json");
		const expected = await sha256hexLocal(
			new Uint8Array([0xff, 0xfe, 0x7b, 0x7d]),
		);
		expect(result).toBe(expected);
	});

	it("unterminated JSON string -> raw-byte fallback", async () => {
		const raw = '{"a":"unterminated';
		const result = await sha256jcs(toAB(raw), "application/json");
		const expected = await sha256hexLocal(raw);
		expect(result).toBe(expected);
	});

	it("lone UTF-8 continuation byte with JSON content-type -> raw-byte fallback", async () => {
		// 0x80 alone is a continuation byte without a lead -- fatal TextDecoder rejects.
		const invalid = bytesToAB([0x7b, 0x80, 0x7d]);
		const result = await sha256jcs(invalid, "application/json");
		const expected = await sha256hexLocal(new Uint8Array([0x7b, 0x80, 0x7d]));
		expect(result).toBe(expected);
	});
});

// ─── sha256jcs: edge-case guards ────────────────────────────────────────────

describe("sha256jcs edge-case guards", () => {
	it("empty ArrayBuffer -> null", async () => {
		const result = await sha256jcs(new ArrayBuffer(0), "application/json");
		expect(result).toBeNull();
	});

	it("null input -> null", async () => {
		expect(await sha256jcs(null, "application/json")).toBeNull();
		expect(await sha256jcs(null, null)).toBeNull();
	});

	it("very large JSON (10k keys) canonicalizes stably across key orderings", async () => {
		const obj: Record<string, number> = {};
		for (let i = 0; i < 10000; i++) obj[`k${i}`] = i;
		const forward = JSON.stringify(obj);
		const reversedObj: Record<string, number> = {};
		Object.keys(obj)
			.reverse()
			.forEach((k) => {
				reversedObj[k] = obj[k];
			});
		const reversed = JSON.stringify(reversedObj);
		expect(forward).not.toBe(reversed); // sanity: byte sequences differ
		const a = await sha256jcs(toAB(forward), "application/json");
		const b = await sha256jcs(toAB(reversed), "application/json");
		expect(a).toBe(b);
		expect(a).not.toBeNull();
	});
});

// ─── PB2: JCS round-trip stability (property-based) ─────────────────────────
// Property: for any valid JSON value V, JCS(V) === JCS(JSON.parse(JCS(V))).
// Canonical form is idempotent under parse-and-recanonicalize, so re-encoding
// a previously canonicalized payload yields byte-identical output. If this
// ever drifts, downstream chain hashes diverge between encoders.

describe("PB2: JCS round-trip stability (fast-check)", () => {
	it("canonicalize is idempotent under parse-and-recanonicalize", () => {
		fc.assert(
			fc.property(fc.jsonValue(), (v) => {
				const s1 = canonicalize(v);
				expect(s1).toBeDefined();
				const s2 = canonicalize(JSON.parse(s1 as string));
				expect(s2).toBe(s1);
			}),
			{ numRuns: 200 },
		);
	});

	it("sha256jcs is stable across one round-trip of canonical text", async () => {
		// Stronger end-to-end property: hashing the canonical text and hashing
		// the re-canonicalized form yield identical hashes through the public
		// sha256jcs entry point (covers the JCS branch and hex encoding).
		await fc.assert(
			fc.asyncProperty(fc.jsonValue(), async (v) => {
				const s1 = canonicalize(v) as string;
				const s2 = canonicalize(JSON.parse(s1)) as string;
				const h1 = await sha256jcs(toAB(s1), "application/json");
				const h2 = await sha256jcs(toAB(s2), "application/json");
				expect(h1).toBe(h2);
				expect(h1).not.toBeNull();
			}),
			{ numRuns: 100 },
		);
	});
});
