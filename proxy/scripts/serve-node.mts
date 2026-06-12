// Self-host evidence relay — the portable app on Node. Cloudflare is a
// deployment choice, not a dependency: this process is a complete ingest
// node (HTTP → vault → outbox); pair it with outbox-drain.mts for sealing.
//
//   serve                     start the relay (AILEDGER_PORT, default 8788)
//   add-tenant <ref>          generate an API key for a tenant. The key is
//                             written to ~/.secrets/ailedger-node/apikey-<ref>.txt
//                             (0600) — NEVER printed to stdout.
//
// State:
//   ~/.secrets/ailedger-node/tenants.json    { sha256(apiKey) → tenantRef }
//   ~/.secrets/ailedger-node/kek-<ref>.bin   per-tenant KEK (created on demand)
//   ~/.ailedger-vault/<ref>/                 sealed payloads + wrapped DEKs
//   ~/.ailedger-outbox/                      queued items awaiting drain

import { serve } from '@hono/node-server';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { FsOutboxStore } from '../src/hedera/store-fs.ts';
import { FsVault } from '../src/vault/fs.ts';
import { KEK_BYTES, type KekProvider } from '../src/vault/kek.ts';

const NODE_DIR = join(homedir(), '.secrets', 'ailedger-node');
const TENANTS_PATH = join(NODE_DIR, 'tenants.json');
const VAULT_ROOT = process.env.AILEDGER_VAULT_DIR ?? join(homedir(), '.ailedger-vault');
const OUTBOX_ROOT = process.env.AILEDGER_OUTBOX_DIR ?? join(homedir(), '.ailedger-outbox');

async function sha256hexStr(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function loadTenants(): Record<string, string> {
  if (!existsSync(TENANTS_PATH)) return {};
  return JSON.parse(readFileSync(TENANTS_PATH, 'utf8')) as Record<string, string>;
}

const fsKekProvider: KekProvider = {
  async getKek(tenantRef: string): Promise<Uint8Array> {
    mkdirSync(NODE_DIR, { recursive: true, mode: 0o700 });
    const path = join(NODE_DIR, `kek-${tenantRef}.bin`);
    if (!existsSync(path)) {
      const kek = new Uint8Array(KEK_BYTES);
      crypto.getRandomValues(kek);
      writeFileSync(path, kek, { mode: 0o600 });
      console.log(`generated KEK for tenant ${tenantRef} → ${path}`);
    }
    return new Uint8Array(readFileSync(path));
  },
};

async function addTenant(tenantRef: string): Promise<void> {
  mkdirSync(NODE_DIR, { recursive: true, mode: 0o700 });
  const tenants = loadTenants();
  if (Object.values(tenants).includes(tenantRef)) {
    console.error(`tenant ${tenantRef} already has a key — refusing to overwrite.`);
    process.exit(2);
  }
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const apiKey = `alk_${Array.from(raw)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
  tenants[await sha256hexStr(apiKey)] = tenantRef;
  writeFileSync(TENANTS_PATH, JSON.stringify(tenants, null, 2) + '\n', { mode: 0o600 });
  const keyPath = join(NODE_DIR, `apikey-${tenantRef}.txt`);
  writeFileSync(keyPath, apiKey + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`tenant ${tenantRef} registered; api key → ${keyPath} (not printed)`);
}

function startServer(): void {
  const tenants = loadTenants();
  if (Object.keys(tenants).length === 0) {
    console.error(`no tenants registered — run: serve-node.mts add-tenant <ref>`);
    process.exit(2);
  }
  const app = createApp({
    vault: new FsVault(VAULT_ROOT),
    keks: fsKekProvider,
    outbox: { store: new FsOutboxStore(OUTBOX_ROOT), submitter: neverSubmit },
    authenticate: async (apiKey) => tenants[await sha256hexStr(apiKey)] ?? null,
  });
  const port = Number(process.env.AILEDGER_PORT ?? 8788);
  serve({ fetch: app.fetch, port });
  console.log(`evidence relay (self-host) listening on :${port}`);
  console.log(`vault=${VAULT_ROOT} outbox=${OUTBOX_ROOT}`);
}

// The relay only ENQUEUES; sealing is the drainer's job (separate process,
// holds the Hedera keys). This stub makes that boundary explicit.
const neverSubmit = {
  submit(): Promise<{ sequenceNumber: number }> {
    return Promise.reject(new Error('relay does not submit — run outbox-drain.mts'));
  },
};

const [, , cmd, ...args] = process.argv;
if (cmd === 'add-tenant') {
  if (!args[0]) {
    console.error('usage: serve-node.mts add-tenant <tenant-ref>');
    process.exit(2);
  }
  await addTenant(args[0]);
} else {
  startServer();
}
