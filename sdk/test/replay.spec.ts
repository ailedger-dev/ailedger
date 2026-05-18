// Tests for rung 3 — detection.replay
//
// Exercises: grid invariant validation, full grid run, distribution
// aggregation per branch point, confidence calc, error handling.

import { describe, expect, it } from 'vitest';
import { makeReplayExtractor } from '../src/extractors/index.js';
import type {
  DetectionEvent,
  DetectionReplayParams,
} from '../src/index.js';
import type { LLMClient } from '../src/extractors/index.js';

const CANONICAL: DetectionEvent = {
  event_id: '00000000-0000-0000-0000-00000000aaaa',
  timestamp: '2026-05-18T12:00:00.000000Z',
  tenant_id: '00000000-0000-0000-0000-000000000001',
  system_id: '00000000-0000-0000-0000-000000000002',
  decision_type: 'credit_screening',
  model_version: 'claude-opus-4-7',
  confidence: 0.85,
};

function makeParams(overrides: Partial<DetectionReplayParams> = {}): DetectionReplayParams {
  const defaults: DetectionReplayParams = {
    extractor_model: 'claude-haiku-4-5-20251001',
    replay_count: 6,
    temperature_grid: [0, 0.5, 1.0],
    seed_grid: [42, 7],
    prompt_template_ref: 'replay:v1',
    ontology_ref: 'ailedger-generic:v0.1.0',
    branch_points: ['final-decision'],
  };
  return { ...defaults, ...overrides };
}

describe('makeReplayExtractor', () => {
  it('throws on grid invariant violation', async () => {
    const llm: LLMClient = async () => ({ text: 'approve' });
    const replay = makeReplayExtractor(llm);
    const params = makeParams({ replay_count: 99 });
    await expect(
      replay.extract(CANONICAL, { rawText: 'some trace' }, params),
    ).rejects.toThrow(/invariant violated/);
  });

  it('returns no-trace-available for empty input', async () => {
    const llm: LLMClient = async () => ({ text: 'approve' });
    const replay = makeReplayExtractor(llm);
    const { result, status } = await replay.extract(
      CANONICAL,
      { rawText: '' },
      makeParams(),
    );
    expect(status).toBe('no-trace-available');
    expect(result).toBeNull();
  });

  it('runs the full grid + aggregates distribution', async () => {
    let callCount = 0;
    const llm: LLMClient = async () => {
      callCount += 1;
      // 5 of 6 say "approve", 1 says "deny" — modal share 5/6 ≈ 0.83
      return { text: callCount === 3 ? 'deny' : 'approve' };
    };
    const replay = makeReplayExtractor(llm);
    const { result, status } = await replay.extract(
      CANONICAL,
      { rawText: 'credit decision based on score' },
      makeParams(),
    );
    expect(status).toBe('ok');
    expect(callCount).toBe(6);
    expect(result?.extractorMethod).toBe('detection.replay');
    expect(result?.output.evidence_type).toBe('replay-distribution');
    const distributions = result?.output.distributions as Array<{
      branch_point: string;
      samples: number;
      modal_outcome: string;
      modal_share: number;
      divergence_score: number;
    }>;
    expect(distributions).toHaveLength(1);
    expect(distributions[0].samples).toBe(6);
    expect(distributions[0].modal_outcome).toBe('approve');
    expect(distributions[0].modal_share).toBeCloseTo(5 / 6, 2);
    expect(distributions[0].divergence_score).toBeCloseTo(1 / 6, 2);
  });

  it('confidence reflects modal stability', async () => {
    // Robust canonical: all 6 samples return the same value → modal share 1.0
    const robustLlm: LLMClient = async () => ({ text: 'approve' });
    const robustReplay = makeReplayExtractor(robustLlm);
    const { result: robustResult } = await robustReplay.extract(
      CANONICAL,
      { rawText: 'trace' },
      makeParams(),
    );
    expect(robustResult?.confidence).toBeGreaterThanOrEqual(0.85);

    // Fragile canonical: half approve, half deny → modal share 0.5
    let toggle = false;
    const fragileLlm: LLMClient = async () => {
      toggle = !toggle;
      return { text: toggle ? 'approve' : 'deny' };
    };
    const fragileReplay = makeReplayExtractor(fragileLlm);
    const { result: fragileResult } = await fragileReplay.extract(
      CANONICAL,
      { rawText: 'trace' },
      makeParams(),
    );
    expect(fragileResult?.confidence).toBeLessThan(0.6);
  });

  it('captures errors without crashing the run', async () => {
    let callCount = 0;
    const llm: LLMClient = async () => {
      callCount += 1;
      if (callCount === 2) throw new Error('LLM transient failure');
      return { text: 'approve' };
    };
    const replay = makeReplayExtractor(llm);
    const { result, status } = await replay.extract(
      CANONICAL,
      { rawText: 'trace' },
      makeParams(),
    );
    expect(status).toBe('ok');
    expect(result?.output.error_count).toBe(1);
    const errors = result?.output.errors as Array<{ error: string }>;
    expect(errors[0].error).toContain('LLM transient failure');
  });

  it('handles multiple branch points independently', async () => {
    let i = 0;
    const llm: LLMClient = async () => {
      i += 1;
      // First 6 calls (branch 'a'): all approve. Next 6 (branch 'b'): mixed.
      if (i <= 6) return { text: 'approve' };
      return { text: i % 2 === 0 ? 'approve' : 'deny' };
    };
    const replay = makeReplayExtractor(llm);
    const params = makeParams({
      replay_count: 12,
      branch_points: ['a', 'b'],
    });
    const { result, status } = await replay.extract(
      CANONICAL,
      { rawText: 'trace' },
      params,
    );
    expect(status).toBe('ok');
    const distributions = result?.output.distributions as Array<{
      branch_point: string;
      modal_share: number;
    }>;
    expect(distributions).toHaveLength(2);
    const a = distributions.find((d) => d.branch_point === 'a');
    const b = distributions.find((d) => d.branch_point === 'b');
    expect(a?.modal_share).toBe(1.0);
    expect(b?.modal_share).toBe(0.5);
  });
});
