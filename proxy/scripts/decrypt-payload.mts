// Auditor-side payload decryption for the live demo (tenant hands over KEK access).
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FsVault } from '../src/vault/fs.ts';
import { unwrapDek } from '../src/vault/kek.ts';
import { openPayload } from '@ailedger/sdk';

const [, , eventId, payloadHash, outFile] = process.argv;
const vault = new FsVault(join(homedir(), '.ailedger-vault'));
const entry = await vault.get('jv-fleet', payloadHash);
if (!entry) throw new Error('payload not in vault');
const kek = new Uint8Array(readFileSync(join(homedir(), '.secrets', 'ailedger-node', 'kek-jv-fleet.bin')));
const dek = await unwrapDek(kek, entry.wrappedDek, payloadHash);
const payload = await openPayload(dek, entry.blob, eventId);
writeFileSync(outFile, JSON.stringify(payload, null, 1));
console.log(`payload for ${eventId} → ${outFile} (keys: ${Object.keys(payload).join(', ')})`);
