// Hedera topic conventions — memos and registry announcements (pure module).
//
// Deliberately free of @hashgraph/sdk imports so it can be unit-tested in the
// workers vitest pool and later reused by the indexer. SDK-touching code
// lives in topics.ts (Node-side operator tooling).
//
// Topic taxonomy (per the Hedera rails plan / ADR-016):
//   tenant topic        — the tenant's Logbook (ode-2 records). memo binds it
//                         to the tenant ref; submitKey gates writes.
//   registry.tenants    — event-sourced control plane: tenant-created
//                         announcements (this module defines the message).
//   registry.keys       — key grants/revocations/rotations (Phase 3+).
//   registry.schema     — schema-version announcements.
//   checkpoints         — cross-topic monthly checkpoint roots.

import canonicalize from 'canonicalize';

/** HCS topic memo hard limit (bytes). */
export const TOPIC_MEMO_MAX_BYTES = 100;
export const REGISTRY_NAMES = ['tenants', 'keys', 'schema'] as const;
export type RegistryName = (typeof REGISTRY_NAMES)[number];

const TENANT_REF_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** Validate the operator-chosen tenant ref (slug, not a secret, lands in a public memo). */
export function assertTenantRef(tenantRef: string): void {
  if (!TENANT_REF_RE.test(tenantRef)) {
    throw new Error(
      `tenant ref ${JSON.stringify(tenantRef)} must match ${TENANT_REF_RE} (lowercase slug, 3-64 chars)`,
    );
  }
}

function assertMemoBytes(memo: string): string {
  const bytes = new TextEncoder().encode(memo).byteLength;
  if (bytes > TOPIC_MEMO_MAX_BYTES) {
    throw new Error(`topic memo is ${bytes} bytes > ${TOPIC_MEMO_MAX_BYTES} limit: ${memo}`);
  }
  return memo;
}

export function tenantTopicMemo(tenantRef: string): string {
  assertTenantRef(tenantRef);
  return assertMemoBytes(`ailedger/ode-2 tenant=${tenantRef}`);
}

export function registryTopicMemo(name: RegistryName): string {
  return assertMemoBytes(`ailedger/registry/${name} v1`);
}

export function checkpointsTopicMemo(): string {
  return assertMemoBytes('ailedger/checkpoints v1');
}

/** Tenant-created announcement — message #N on registry.tenants. */
export interface TenantCreatedAnnouncement {
  v: 'reg-1';
  kind: 'tenant-created';
  tenant_ref: string;
  topic_id: string;
  /** Raw hex of the tenant topic's submit public key (public by definition). */
  submit_pubkey: string;
  admin_threshold: number;
  /** SHA-256 hex fingerprints of the admin public keys (not the keys themselves). */
  admin_key_fingerprints: string[];
}

const TOPIC_ID_RE = /^\d+\.\d+\.\d+$/;
const HEX64 = /^[0-9a-f]{64}$/;

export function buildTenantCreatedAnnouncement(params: {
  tenantRef: string;
  topicId: string;
  submitPubkeyHex: string;
  adminThreshold: number;
  adminKeyFingerprints: string[];
}): { announcement: TenantCreatedAnnouncement; encoded: Uint8Array } {
  assertTenantRef(params.tenantRef);
  if (!TOPIC_ID_RE.test(params.topicId)) throw new Error(`invalid topic id: ${params.topicId}`);
  if (!/^[0-9a-f]{64,66}$/.test(params.submitPubkeyHex)) {
    throw new Error('submit_pubkey must be raw hex (64 chars ed25519 / 66 compressed ecdsa)');
  }
  if (params.adminKeyFingerprints.some((f) => !HEX64.test(f))) {
    throw new Error('admin key fingerprints must be 64-char sha256 hex');
  }
  if (
    !Number.isInteger(params.adminThreshold) ||
    params.adminThreshold < 1 ||
    params.adminThreshold > params.adminKeyFingerprints.length
  ) {
    throw new Error('admin_threshold must be an integer within the key-list size');
  }
  const announcement: TenantCreatedAnnouncement = {
    v: 'reg-1',
    kind: 'tenant-created',
    tenant_ref: params.tenantRef,
    topic_id: params.topicId,
    submit_pubkey: params.submitPubkeyHex.toLowerCase(),
    admin_threshold: params.adminThreshold,
    admin_key_fingerprints: params.adminKeyFingerprints.map((f) => f.toLowerCase()),
  };
  const jcs = canonicalize(announcement as Parameters<typeof canonicalize>[0]);
  if (jcs === undefined) throw new Error('announcement is not JCS-serializable');
  const encoded = new TextEncoder().encode(jcs);
  if (encoded.byteLength > 1024) {
    throw new Error(`announcement is ${encoded.byteLength} bytes > 1024 (single HCS message)`);
  }
  return { announcement, encoded };
}

/** Parse + validate a registry.tenants message (indexer/list-side). */
export function parseTenantCreatedAnnouncement(bytes: Uint8Array): TenantCreatedAnnouncement {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  if (parsed.v !== 'reg-1' || parsed.kind !== 'tenant-created') {
    throw new Error(`not a reg-1 tenant-created announcement: ${JSON.stringify(parsed).slice(0, 80)}`);
  }
  // Re-build through the validator so malformed announcements are rejected
  // with the same rules used at publish time.
  const { announcement } = buildTenantCreatedAnnouncement({
    tenantRef: String(parsed.tenant_ref),
    topicId: String(parsed.topic_id),
    submitPubkeyHex: String(parsed.submit_pubkey),
    adminThreshold: Number(parsed.admin_threshold),
    adminKeyFingerprints: (parsed.admin_key_fingerprints as string[]) ?? [],
  });
  return announcement;
}
