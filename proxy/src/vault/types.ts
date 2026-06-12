// Vault — content-addressed private-payload storage (interface + memory impl).
//
// The vault holds the PRIVATE half of every event: the sealed payload blob
// (addressed by payload_hash = SHA-256(blob)) plus its wrapped DEK. Backends:
// memory (tests), fs (Node self-host, fs.ts), R2/S3 (SaaS tier, lands at the
// Worker cutover). Deleting an entry + its wrapped DEK is the physical half
// of erasure; the on-chain record's commitments become informationless once
// the DEK and salts are gone.

export interface VaultEntry {
  blob: Uint8Array;
  wrappedDek: Uint8Array;
}

export interface VaultStore {
  put(tenantRef: string, payloadHash: string, entry: VaultEntry): Promise<void>;
  get(tenantRef: string, payloadHash: string): Promise<VaultEntry | null>;
  /** Physical erasure of one payload (blob + wrapped DEK together). */
  delete(tenantRef: string, payloadHash: string): Promise<void>;
}

export class MemoryVault implements VaultStore {
  private data = new Map<string, VaultEntry>();
  private key(t: string, h: string) {
    return `${t}/${h}`;
  }
  async put(tenantRef: string, payloadHash: string, entry: VaultEntry): Promise<void> {
    this.data.set(this.key(tenantRef, payloadHash), entry);
  }
  async get(tenantRef: string, payloadHash: string): Promise<VaultEntry | null> {
    return this.data.get(this.key(tenantRef, payloadHash)) ?? null;
  }
  async delete(tenantRef: string, payloadHash: string): Promise<void> {
    this.data.delete(this.key(tenantRef, payloadHash));
  }
}
