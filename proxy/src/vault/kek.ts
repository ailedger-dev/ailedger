// Per-tenant KEK → per-event DEK wrapping (portable webcrypto).
//
// Custody model (plan, locked): every event's payload is sealed with a fresh
// DEK; the DEK is wrapped by the tenant's KEK. Erasure = destroy the wrapped
// DEK (and/or the payload blob). KEK custody is operator-side in Phase 1 and
// migrates to customer KMS in Phase 4 — these helpers don't care where the
// KEK bytes come from (KekProvider is injected).
//
// Wrap format: version(0x01) ‖ iv(12) ‖ AES-256-GCM(kek, dek, aad=payloadHash).
// Binding the payloadHash as AAD means a wrapped DEK cannot be silently
// re-pointed at a different blob.

export const KEK_BYTES = 32;
const WRAP_VERSION = 0x01;
const IV_BYTES = 12;

export interface KekProvider {
  /** Return the tenant's 32-byte KEK (creating it if the backend allows). */
  getKek(tenantRef: string): Promise<Uint8Array>;
}

async function importKek(kek: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  if (kek.byteLength !== KEK_BYTES) {
    throw new Error(`KEK must be ${KEK_BYTES} bytes, got ${kek.byteLength}`);
  }
  return crypto.subtle.importKey('raw', kek.slice(), { name: 'AES-GCM' }, false, [usage]);
}

export async function wrapDek(
  kek: Uint8Array,
  dek: Uint8Array,
  payloadHash: string,
): Promise<Uint8Array> {
  const key = await importKek(kek, 'encrypt');
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(payloadHash) },
      key,
      dek.slice(),
    ),
  );
  const out = new Uint8Array(1 + IV_BYTES + ct.byteLength);
  out[0] = WRAP_VERSION;
  out.set(iv, 1);
  out.set(ct, 1 + IV_BYTES);
  return out;
}

export async function unwrapDek(
  kek: Uint8Array,
  wrapped: Uint8Array,
  payloadHash: string,
): Promise<Uint8Array> {
  if (wrapped.byteLength < 1 + IV_BYTES + 16) throw new Error('wrapped DEK too short');
  if (wrapped[0] !== WRAP_VERSION) {
    throw new Error(`unsupported DEK wrap version 0x${wrapped[0].toString(16)}`);
  }
  const key = await importKek(kek, 'decrypt');
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: wrapped.slice(1, 1 + IV_BYTES),
      additionalData: new TextEncoder().encode(payloadHash),
    },
    key,
    wrapped.slice(1 + IV_BYTES),
  );
  return new Uint8Array(plaintext);
}
