// AILedger SDK — private-payload envelope encryption.
//
// The PRIVATE half of every decision event (subject_id, protected-class
// context, raw output, the per-event commitment salt) is sealed with a fresh
// per-event 256-bit DEK under AES-256-GCM and stored in a customer-
// controllable vault. The on-chain record binds it by content address:
// payload_hash = SHA-256(blob).
//
// Blob layout (version-prefixed, self-describing):
//   byte 0      format version (0x01)
//   bytes 1–12  AES-GCM IV (12 bytes, random per seal)
//   bytes 13–   ciphertext ‖ 16-byte GCM tag (WebCrypto appends the tag)
//
// Key custody is the caller's concern (KEK wrapping in KMS lands proxy-side);
// these primitives are deliberately pure so the SDK, relay, aDNA adapter, and
// verifier all share one implementation. Crypto-shredding = destroy the DEK
// (and KEK wrap); the blob — wherever it lives — becomes noise, and the
// on-chain payload_hash points at nothing recoverable.

import canonicalize from 'canonicalize';

export const ENVELOPE_VERSION = 0x01;
export const DEK_BYTES = 32;
const IV_BYTES = 12;

export interface SealedPayload {
  /** version ‖ iv ‖ ciphertext+tag — store this; hash this. */
  blob: Uint8Array;
  /** SHA-256 hex of blob — the on-chain payload_hash. */
  payloadHash: string;
}

/** Fresh per-event data-encryption key. */
export function generateDek(): Uint8Array {
  const dek = new Uint8Array(DEK_BYTES);
  crypto.getRandomValues(dek);
  return dek;
}

async function importDek(dek: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  if (dek.byteLength !== DEK_BYTES) {
    throw new Error(`DEK must be ${DEK_BYTES} bytes, got ${dek.byteLength}`);
  }
  // .slice() yields a fresh ArrayBuffer-backed copy, satisfying BufferSource
  // under TS 5.x typed-array generics without a cast.
  return crypto.subtle.importKey('raw', dek.slice(), { name: 'AES-GCM' }, false, [usage]);
}

async function sha256hexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Seal a payload object: JCS-canonicalize → AES-256-GCM under the DEK.
 * The event_id is bound as GCM additional authenticated data, so a blob
 * cannot be silently re-attached to a different event's record.
 */
export async function sealPayload(
  dek: Uint8Array,
  payload: Record<string, unknown>,
  eventId: string,
): Promise<SealedPayload> {
  const jcs = canonicalize(payload as Parameters<typeof canonicalize>[0]);
  if (jcs === undefined) throw new Error('payload is not JCS-serializable');
  const key = await importDek(dek, 'encrypt');
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(eventId) },
      key,
      new TextEncoder().encode(jcs),
    ),
  );
  const blob = new Uint8Array(1 + IV_BYTES + ciphertext.byteLength);
  blob[0] = ENVELOPE_VERSION;
  blob.set(iv, 1);
  blob.set(ciphertext, 1 + IV_BYTES);
  return { blob, payloadHash: await sha256hexBytes(blob) };
}

/**
 * Open a sealed blob. Throws on version mismatch, wrong DEK, wrong eventId
 * (AAD), or any bit of tampering (GCM authentication).
 */
export async function openPayload(
  dek: Uint8Array,
  blob: Uint8Array,
  eventId: string,
): Promise<Record<string, unknown>> {
  if (blob.byteLength < 1 + IV_BYTES + 16) throw new Error('blob too short');
  if (blob[0] !== ENVELOPE_VERSION) {
    throw new Error(`unsupported envelope version 0x${blob[0].toString(16)}`);
  }
  const key = await importDek(dek, 'decrypt');
  // .slice() copies onto fresh ArrayBuffers — BufferSource under TS 5.x.
  const iv = blob.slice(1, 1 + IV_BYTES);
  const ciphertext = blob.slice(1 + IV_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(eventId) },
    key,
    ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
}

/** Recompute the content address of a stored blob (vault integrity check). */
export async function payloadHashOf(blob: Uint8Array): Promise<string> {
  return sha256hexBytes(blob);
}
