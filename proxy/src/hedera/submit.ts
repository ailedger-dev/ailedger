// Node-side RecordSubmitter — wraps the guarded HCS submit with per-tenant
// topic/key resolution from the operator secrets directory (testnet posture;
// KMS custody lands in Phase 4). Node-only module: imports node:fs — never
// imported by the legacy Worker bundle.

import { PrivateKey, TopicId, type Client } from '@hashgraph/sdk';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RecordSubmitter } from './outbox.ts';
import { submitGuardedMessage } from './topics.ts';

interface TenantSecrets {
  tenantRef: string;
  network: string;
  topicId: string;
  submitKey: string;
}

export function loadTenantSecrets(tenantRef: string, network: string): TenantSecrets {
  const path = join(homedir(), '.secrets', 'hedera-tenants', `${tenantRef}.${network}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as TenantSecrets;
}

/**
 * Submitter resolving each tenant's topic + submitKey from
 * ~/.secrets/hedera-tenants/<ref>.<network>.json (provision-topics.mts).
 */
export function secretsSubmitter(client: Client, network: string): RecordSubmitter {
  const cache = new Map<string, { topicId: TopicId; submitKey: PrivateKey }>();
  return {
    async submit(tenantRef: string, encoded: Uint8Array) {
      let entry = cache.get(tenantRef);
      if (!entry) {
        const secrets = loadTenantSecrets(tenantRef, network);
        entry = {
          topicId: TopicId.fromString(secrets.topicId),
          submitKey: PrivateKey.fromStringDer(secrets.submitKey),
        };
        cache.set(tenantRef, entry);
      }
      const sequenceNumber = await submitGuardedMessage(
        client,
        entry.topicId,
        entry.submitKey,
        encoded,
      );
      return { sequenceNumber };
    },
  };
}
