// Mirror-message parsing — decode raw topic messages into typed records.
//
// Pure module: bytes in, typed records out. The app-chain hash is computed
// over the ORIGINAL message bytes (never a re-serialization — JSON round-trips
// don't preserve bytes; hashing re-encoded JSON would silently fork the chain
// check).
//
// reg-1 parsing duplicates proxy/src/hedera/topics-format.ts minimally;
// consolidation into the spec package is a Phase 5 item.

export interface MirrorMessage {
  sequence_number: number;
  consensus_timestamp: string;
  message: string; // base64
}

export interface ParsedRecord {
  seq: number;
  consensusTs: string;
  bytes: Uint8Array;
  /** SHA-256 hex of bytes — the app-chain link value for the NEXT record. */
  recordHash: string;
  body:
    | { v: 'ode-2'; [k: string]: unknown }
    | { v: 'ode-2b'; [k: string]: unknown }
    | { v: 'reg-1'; [k: string]: unknown }
    | { v: 'unknown'; raw: string };
}

export function decodeBase64(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function sha256hexOf(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function parseMirrorMessage(msg: MirrorMessage): Promise<ParsedRecord> {
  const bytes = decodeBase64(msg.message);
  const recordHash = await sha256hexOf(bytes);
  let body: ParsedRecord['body'];
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (parsed.v === 'ode-2' || parsed.v === 'ode-2b' || parsed.v === 'reg-1') {
      body = parsed as ParsedRecord['body'];
    } else {
      body = { v: 'unknown', raw: new TextDecoder().decode(bytes).slice(0, 256) };
    }
  } catch {
    body = { v: 'unknown', raw: `<binary ${bytes.byteLength}B>` };
  }
  return {
    seq: msg.sequence_number,
    consensusTs: msg.consensus_timestamp,
    bytes,
    recordHash,
    body,
  };
}

export interface TenantAnnouncement {
  tenantRef: string;
  topicId: string;
  submitPubkey: string;
  announcedSeq: number;
}

/** Extract a reg-1 tenant-created announcement, or null for other registry rows. */
export function asTenantAnnouncement(rec: ParsedRecord): TenantAnnouncement | null {
  const b = rec.body as Record<string, unknown>;
  if (b.v !== 'reg-1' || b.kind !== 'tenant-created') return null;
  if (typeof b.tenant_ref !== 'string' || typeof b.topic_id !== 'string') return null;
  return {
    tenantRef: b.tenant_ref,
    topicId: b.topic_id,
    submitPubkey: String(b.submit_pubkey ?? ''),
    announcedSeq: rec.seq,
  };
}
