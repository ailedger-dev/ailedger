#!/usr/bin/env -S npx tsx
//
// AILedger SDK end-to-end smoke test.
//
// Emits ONE canonical Detection Event + ONE inferred Detection Event
// against the configured proxy. Verifies the response carries populated
// hash_chain_prev + hash_chain_self.
//
// Usage:
//   AILEDGER_API_KEY=agl_sk_xxx \
//   AILEDGER_TENANT_ID=00000000-0000-0000-0000-000000000000 \
//   AILEDGER_SYSTEM_ID=00000000-0000-0000-0000-000000000000 \
//   AILEDGER_BASE_URL=https://proxy.ailedger.dev \
//   npx tsx scripts/smoke-test.ts
//
// Defaults to https://proxy.ailedger.dev. Override AILEDGER_BASE_URL for
// staging or local dev.

import { randomUUID } from 'node:crypto';
import { DetectionEventClient } from '../src/index.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const baseUrl = process.env.AILEDGER_BASE_URL ?? 'https://proxy.ailedger.dev';
  const apiKey = requireEnv('AILEDGER_API_KEY');
  const tenantId = requireEnv('AILEDGER_TENANT_ID');
  const systemId = requireEnv('AILEDGER_SYSTEM_ID');

  const client = new DetectionEventClient({ baseUrl, apiKey, tenantId, systemId });

  // ─── Test 1: canonical Detection Event ────────────────────────────────
  const canonicalEventId = randomUUID();
  console.log(`[1/2] Emitting canonical Detection Event ${canonicalEventId}`);

  const canonical = await client.emit({
    eventId: canonicalEventId,
    rawInputs: {
      applicant_phenotype: { age_band: '25_34', credential_count: 3 },
      job_posting_id: 'smoke-test-job-001',
    },
    modelVersion: 'smoke-test-model@v0',
    decisionType: 'employment_screening',
    subjectId: 'smoke-test-subject-pseudonym',
    output: { decision: 'advance', confidence_label: 'high' },
    confidence: 0.8523,
    humanInLoop: false,
    protectedClassContext: { age_band: '25_34', age_band_source: 'direct' },
    protectedClassCollectionMethod: 'direct',
    flagsRaised: [],
    requiredActions: [],
    actionsTaken: [],
  });

  console.log('  event_id:', canonical.event_id);
  console.log('  hash_chain_prev:', canonical.hash_chain_prev);
  console.log('  hash_chain_self:', canonical.hash_chain_self);
  console.log('  confidence (normalized):', canonical.confidence);

  if (!canonical.hash_chain_self) {
    console.error('FAIL: server did not populate hash_chain_self');
    process.exit(2);
  }
  if (canonical.confidence !== 0.8523) {
    console.error(
      `FAIL: confidence normalization off (expected 0.8523, got ${canonical.confidence})`,
    );
    process.exit(2);
  }

  // ─── Test 2: inferred Detection Event ─────────────────────────────────
  const inferredEventId = randomUUID();
  console.log(`\n[2/2] Emitting inferred Detection Event ${inferredEventId} anchored to ${canonicalEventId}`);

  const inferred = await client.emitInferred({
    eventId: inferredEventId,
    anchorEventId: canonicalEventId,
    extractorMethod: 'detection.parse',
    extractorModel: 'claude-haiku-4-5-20251001',
    extractorParams: {
      trace_source: 'chain-of-thought',
      parse_strategy: 'pattern-match',
      parse_strategy_version: 'v1.0',
      ontology_ref: 'ailedger-generic:v0.1.0',
    },
    extractionStartedAt: new Date(),
    extractionComputeMs: 42,
    output: { extracted_reason: 'credential_count >= 3 triggered advance' },
    confidence: 0.92,
    flagsRaised: [],
    requiredActions: [],
    actionsTaken: [],
  });

  console.log('  event_id:', inferred.event_id);
  console.log('  extractor_method:', inferred.extractor_method);
  console.log('  extractor_params_hash:', inferred.extractor_params_hash);
  console.log('  anchor_event_id:', inferred.anchor_event_id);
  console.log('  hash_chain_prev:', inferred.hash_chain_prev);
  console.log('  hash_chain_self:', inferred.hash_chain_self);

  if (!inferred.hash_chain_self) {
    console.error('FAIL: server did not populate hash_chain_self on inferred event');
    process.exit(2);
  }
  if (inferred.hash_chain_prev !== canonical.hash_chain_self) {
    console.error(
      'FAIL: inferred.hash_chain_prev does not match canonical.hash_chain_self ' +
        '(chain linkage broken)',
    );
    console.error('  inferred.hash_chain_prev:', inferred.hash_chain_prev);
    console.error('  canonical.hash_chain_self:', canonical.hash_chain_self);
    process.exit(2);
  }

  console.log('\nPASS: both events landed; chain linkage verified.');
}

main().catch((err) => {
  console.error('\nERROR:', err);
  if (err.detail) {
    console.error('Detail:', JSON.stringify(err.detail, null, 2));
  }
  process.exit(1);
});
