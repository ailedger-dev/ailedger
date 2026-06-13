// Hedera client factory — Node-side operator tooling (provisioning scripts,
// outbox drainer). Productizes the two operational lessons from the Phase 0
// spike (ADR-016):
//
//   1. Bare-hex private keys are ambiguous (ED25519 vs ECDSA) and portal
//      accounts are commonly ECDSA — naive parsing fails precheck with
//      INVALID_SIGNATURE. The key type is resolved by matching candidate
//      parsings against the account's key on file at the mirror node.
//   2. The mirror REST base is network-derived but overridable
//      (HEDERA_MIRROR_REST) for self-hosted mirrors.
//
// Workers-runtime compatibility of @hashgraph/sdk submits is evaluated in the
// outbox task — nothing in the legacy Worker imports this module.

import { AccountId, Client, PrivateKey } from '@hashgraph/sdk';

export interface HederaEnvConfig {
  network: string;
  operatorId: string;
  operatorKey: string;
  mirrorRest: string;
}

/** Pure env extraction — testable without network or SDK state. */
export function readHederaEnv(env: Record<string, string | undefined>): HederaEnvConfig {
  const network = env.HEDERA_NETWORK ?? 'testnet';
  const operatorId = env.HEDERA_OPERATOR_ID;
  const operatorKey = env.HEDERA_OPERATOR_KEY;
  if (!operatorId || !operatorKey) {
    throw new Error(
      'HEDERA_OPERATOR_ID / HEDERA_OPERATOR_KEY not set — source ~/.secrets/hedera-testnet.env',
    );
  }
  return {
    network,
    operatorId,
    operatorKey,
    mirrorRest: env.HEDERA_MIRROR_REST ?? `https://${network}.mirrornode.hedera.com`,
  };
}

/**
 * Resolve a private-key string to the interpretation that matches the
 * account's public key on file at the mirror node (ADR-016 lesson #1).
 * Falls back to the first parseable interpretation if the mirror is
 * unreachable; throws if nothing parses or nothing matches.
 */
export async function resolveOperatorKey(
  mirrorRest: string,
  accountId: string,
  keyStr: string,
): Promise<PrivateKey> {
  const cleaned = keyStr.startsWith('0x') ? keyStr.slice(2) : keyStr;
  const candidates: PrivateKey[] = [];
  for (const parse of [
    PrivateKey.fromStringDer,
    PrivateKey.fromStringECDSA,
    PrivateKey.fromStringED25519,
  ]) {
    try {
      candidates.push(parse.call(PrivateKey, cleaned));
    } catch {
      // not this encoding
    }
  }
  if (candidates.length === 0) {
    throw new Error('operator key is not parseable as DER, ECDSA, or ED25519');
  }
  try {
    const res = await fetch(`${mirrorRest}/api/v1/accounts/${accountId}`);
    if (res.ok) {
      const body = (await res.json()) as { key?: { key?: string } };
      const onFile = body.key?.key?.toLowerCase();
      if (onFile) {
        const match = candidates.find(
          (c) => c.publicKey.toStringRaw().toLowerCase() === onFile,
        );
        if (match) return match;
        throw new Error(
          `no parseable interpretation of the operator key matches account ${accountId}'s key on file`,
        );
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('on file')) throw err;
    // mirror unreachable — fall through
  }
  return candidates[0];
}

export async function createHederaClient(config: HederaEnvConfig): Promise<Client> {
  const client = Client.forName(config.network);
  client.setOperator(
    AccountId.fromString(config.operatorId),
    await resolveOperatorKey(config.mirrorRest, config.operatorId, config.operatorKey),
  );
  return client;
}
