// File-backed OutboxStore — Node self-host mode. Never imported by the Worker.
//
// One file per key under <root>/, filename = encodeURIComponent(key);
// list() decodes and sorts by the ORIGINAL key so queue ordering matches the
// in-memory and KV implementations. Values carry an optional expiry for
// lease TTLs.

import { mkdirSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OutboxStore } from './outbox.ts';

interface Stored {
  value: string;
  expiresAtMs: number | null;
}

export class FsOutboxStore implements OutboxStore {
  // No TS parameter properties — Node strip-only mode rejects them.
  private readonly root: string;
  private readonly now: () => number;

  constructor(root: string, now: () => number = Date.now) {
    this.root = root;
    this.now = now;
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  private path(key: string): string {
    return join(this.root, encodeURIComponent(key));
  }

  async get(key: string): Promise<string | null> {
    try {
      const stored = JSON.parse(await readFile(this.path(key), 'utf8')) as Stored;
      if (stored.expiresAtMs !== null && this.now() >= stored.expiresAtMs) {
        await rm(this.path(key), { force: true });
        return null;
      }
      return stored.value;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async put(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void> {
    const stored: Stored = {
      value,
      expiresAtMs: opts?.ttlSeconds ? this.now() + opts.ttlSeconds * 1000 : null,
    };
    await writeFile(this.path(key), JSON.stringify(stored), { mode: 0o600 });
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const names = await readdir(this.root);
    return names
      .map((n) => decodeURIComponent(n))
      .filter((k) => k.startsWith(prefix))
      .sort();
  }
}
