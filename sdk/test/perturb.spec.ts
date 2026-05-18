// Tests for rung 4 — detection.perturb
//
// Exercises: bounds_spec validation per strategy, perturbation
// generation, flip-detection, PerturbReport aggregation, protected-class
// confidence bonus.

import { describe, expect, it } from 'vitest';
import { makePerturbExtractor } from '../src/extractors/index.js';
import type {
  DetectionEvent,
  DetectionPerturbParams,
} from '../src/index.js';
import type { LLMClient } from '../src/extractors/index.js';

const CANONICAL: DetectionEvent = {
  event_id: '00000000-0000-0000-0000-00000000bbbb',
  timestamp: '2026-05-18T12:00:00.000000Z',
  tenant_id: '00000000-0000-0000-0000-000000000001',
  system_id: '00000000-0000-0000-0000-000000000002',
  decision_type: 'employment_screening',
  model_version: 'claude-opus-4-7',
  confidence: 0.85,
};

function makeParams(overrides: Partial<DetectionPerturbParams> = {}): DetectionPerturbParams {
  const defaults: DetectionPerturbParams = {
    extractor_model: 'claude-haiku-4-5-20251001',
    perturbation_strategy: 'lexical-substitution',
    perturbation_strategy_version: 'v1.0',
    perturbation_count: 5,
    bounds_spec: { synonym_source: 'wordnet-3.1', fields: ['summary'] },
    prompt_template_ref: 'perturb:v1',
    ontology_ref: 'ailedger-generic:v0.1.0',
    holdout_fields: ['protected_class'],
  };
  return { ...defaults, ...overrides };
}

describe('makePerturbExtractor', () => {
  it('rejects missing bounds_spec keys per strategy', async () => {
    const llm: LLMClient = async () => ({ text: 'advance' });
    const perturb = makePerturbExtractor(llm);
    const { result, status } = await perturb.extract(
      CANONICAL,
      { rawText: 'employment decision' },
      makeParams({ bounds_spec: { fields: ['summary'] } }),
    );
    expect(status).toBe('rejected-by-rules');
    expect(result?.output.evidence_type).toBe('perturb-error');
    expect(result?.output.error).toContain('synonym_source');
  });

  it('returns no-trace-available for empty input', async () => {
    const llm: LLMClient = async () => ({ text: 'advance' });
    const perturb = makePerturbExtractor(llm);
    const { result, status } = await perturb.extract(
      CANONICAL,
      { rawText: '' },
      makeParams(),
    );
    expect(status).toBe('no-trace-available');
    expect(result).toBeNull();
  });

  it('runs all perturbations + detects flips against original choice', async () => {
    let i = 0;
    const llm: LLMClient = async () => {
      i += 1;
      // Of 5 perturbations: 3 return "advance" (matching original), 2 return "reject" (flip)
      return { text: i <= 3 ? 'advance' : 'reject' };
    };
    const perturb = makePerturbExtractor(llm);
    const { result, status } = await perturb.extract(
      CANONICAL,
      { rawText: 'Decision: advance. Rationale: candidate meets thresholds.' },
      makeParams(),
    );
    expect(status).toBe('ok');
    expect(result?.output.evidence_type).toBe('perturb-boundary-map');
    const report = result?.output.report as {
      total_perturbations: number;
      flip_count: number;
      flip_rate: number;
      flipped_examples: unknown[];
    };
    expect(report.total_perturbations).toBe(5);
    expect(report.flip_count).toBe(2);
    expect(report.flip_rate).toBeCloseTo(0.4, 2);
    expect(report.flipped_examples).toHaveLength(2);
    expect(result?.output.original_choice).toBe('advance');
  });

  it('validates each of the four strategies has its own required-keys check', async () => {
    const llm: LLMClient = async () => ({ text: 'x' });
    const perturb = makePerturbExtractor(llm);
    const strategies: Array<{ s: DetectionPerturbParams['perturbation_strategy']; bounds_spec: Record<string, unknown> }> = [
      { s: 'entity-swap', bounds_spec: { entity_types: ['person'] } }, // missing swap_pool
      { s: 'numeric-bounded-jitter', bounds_spec: { fields: ['age'] } }, // missing relative_bound
      { s: 'protected-class-flip', bounds_spec: { attributes: ['gender'] } }, // missing value_pool
    ];
    for (const { s, bounds_spec } of strategies) {
      const { status, result } = await perturb.extract(
        CANONICAL,
        { rawText: 'some trace' },
        makeParams({ perturbation_strategy: s, bounds_spec }),
      );
      expect(status).toBe('rejected-by-rules');
      expect(result?.output.evidence_type).toBe('perturb-error');
    }
  });

  it('gives protected-class-flip strategy a confidence bonus', async () => {
    const llm: LLMClient = async () => ({ text: 'approve' });
    const perturb = makePerturbExtractor(llm);

    const { result: lexicalResult } = await perturb.extract(
      CANONICAL,
      { rawText: 'Decision: approve.' },
      makeParams({ perturbation_count: 20 }),
    );

    const { result: pcResult } = await perturb.extract(
      CANONICAL,
      { rawText: 'Decision: approve.' },
      makeParams({
        perturbation_strategy: 'protected-class-flip',
        perturbation_count: 20,
        bounds_spec: { attributes: ['race', 'gender'], value_pool: { race: ['a', 'b'], gender: ['x', 'y'] } },
      }),
    );

    expect(pcResult?.confidence).toBeGreaterThan(lexicalResult?.confidence ?? 0);
  });

  it('captures LLM errors as sample-level errors without aborting the run', async () => {
    let i = 0;
    const llm: LLMClient = async () => {
      i += 1;
      if (i === 3) throw new Error('LLM timeout');
      return { text: 'approve' };
    };
    const perturb = makePerturbExtractor(llm);
    const { result, status } = await perturb.extract(
      CANONICAL,
      { rawText: 'Decision: approve.' },
      makeParams(),
    );
    expect(status).toBe('ok');
    const samples = result?.output.all_samples as Array<{ output: string }>;
    expect(samples).toHaveLength(5);
    expect(samples.find((s) => s.output.includes('error'))?.output).toContain('LLM timeout');
  });
});
