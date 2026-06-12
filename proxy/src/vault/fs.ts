// Filesystem vault — Node self-host backend. Never imported by the Worker.
//
// Layout: <root>/<tenantRef>/<payloadHash>.blob and .dek (wrapped DEK).
// payloadHash and tenantRef are validated before touching the filesystem so
// neither can traverse paths.

import { mkdirSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { VaultEntry, VaultStore } from './types.ts';

const HEX64 = /^[0-9a-f]{64}$/;
const TENANT = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

export class FsVault implements VaultStore {
  // No TS parameter properties — Node strip-only mode rejects them.
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private dir(tenantRef: string): string {
    if (!TENANT.test(tenantRef)) throw new Error(`invalid tenant ref: ${tenantRef}`);
    const dir = join(this.root, tenantRef);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private paths(tenantRef: string, payloadHash: string): { blob: string; dek: string } {
    if (!HEX64.test(payloadHash)) throw new Error(`invalid payload hash: ${payloadHash}`);
    const dir = this.dir(tenantRef);
    return { blob: join(dir, `${payloadHash}.blob`), dek: join(dir, `${payloadHash}.dek`) };
  }

  async put(tenantRef: string, payloadHash: string, entry: VaultEntry): Promise<void> {
    const p = this.paths(tenantRef, payloadHash);
    await writeFile(p.blob, entry.blob, { mode: 0o600 });
    await writeFile(p.dek, entry.wrappedDek, { mode: 0o600 });
  }

  async get(tenantRef: string, payloadHash: string): Promise<VaultEntry | null> {
    const p = this.paths(tenantRef, payloadHash);
    try {
      const [blob, wrappedDek] = await Promise.all([readFile(p.blob), readFile(p.dek)]);
      return { blob: new Uint8Array(blob), wrappedDek: new Uint8Array(wrappedDek) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(tenantRef: string, payloadHash: string): Promise<void> {
    const p = this.paths(tenantRef, payloadHash);
    await rm(p.blob, { force: true });
    await rm(p.dek, { force: true });
  }
}
