// Tests for the 4-rung extractor module (sdk/src/extractors/)

import { describe, expect, it } from 'vitest';
import {
  parseExtractor,
  parseExplicitChoice,
  parseConfidence,
  makeRestructureExtractor,
} from '../src/extractors/index.js';
import type { DetectionEvent, DetectionParseParams, DetectionRestructureParams } from '../src/index.js';
import type { LLMClient } from '../src/extractors/index.js';

const CANONICAL: DetectionEvent = {
  event_id: '00000000-0000-0000-0000-00000000aaaa',
  timestamp: '2026-05-18T12:00:00.000000Z',
  tenant_id: '00000000-0000-0000-0000-000000000001',
  system_id: '00000000-0000-0000-0000-000000000002',
  decision_type: 'employment_screening',
  model_version: 'claude-opus-4-7',
  confidence: 0.85,
};

const PARSE_PARAMS: DetectionParseParams = {
  trace_source: 'chain-of-thought',
  parse_strategy: 'pattern-match',
  parse_strategy_version: 'v1.0',
  ontology_ref: 'ailedger-generic:v0.1.0',
};

describe('parseExplicitChoice', () => {
  it('matches "chose X because Y"', () => {
    const out = parseExplicitChoice(
      'After reviewing the candidate, I chose advance because the credentials match three required tags.',
    );
    expect(out).not.toBeNull();
    expect(out?.choice.toLowerCase()).toContain('advance');
    expect(out?.reason.toLowerCase()).toContain('credentials');
  });

  it('matches "decision: X. rationale: Y."', () => {
    const out = parseExplicitChoice(
      'Decision: hire. Rationale: candidate met all four required qualifications.',
    );
    expect(out).not.toBeNull();
    expect(out?.choice.toLowerCase()).toContain('hire');
  });

  it('returns null when no pattern matches', () => {
    expect(parseExplicitChoice('the model output some text but no decision rationale')).toBeNull();
  });
});

describe('parseConfidence', () => {
  it('clamps to [0.5, 0.95]', () => {
    expect(parseConfidence({ choice: 'x', reason: 'y' })).toBeGreaterThanOrEqual(0.5);
    expect(
      parseConfidence({
        choice: 'short',
        reason:
          'a very long reason that goes on for more than 120 characters which should bump confidence near the upper bound of the cap at 0.95 ish',
      }),
    ).toBeLessThanOrEqual(0.95);
  });

  it('drops confidence on overlong choice', () => {
    const longChoice = 'x'.repeat(120);
    expect(parseConfidence({ choice: longChoice, reason: 'medium-length reason here' })).toBeLessThan(0.7);
  });
});

describe('parseExtractor', () => {
  it('returns ok + structured result for a parseable trace', async () => {
    const { result, status } = await parseExtractor.extract(
      CANONICAL,
      { rawText: 'I chose advance because the candidate met three required tags.' },
      PARSE_PARAMS,
    );
    expect(status).toBe('ok');
    expect(result).not.toBeNull();
    expect(result?.anchorEventId).toBe(CANONICAL.event_id);
    expect(result?.extractorMethod).toBe('detection.parse');
    expect(result?.output.evidence_type).toBe('verbalized-scaffold');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('returns no-trace-available for empty text', async () => {
    const { result, status } = await parseExtractor.extract(
      CANONICAL,
      { rawText: '' },
      PARSE_PARAMS,
    );
    expect(status).toBe('no-trace-available');
    expect(result).toBeNull();
  });

  it('returns rejected-by-rules for non-implemented strategies', async () => {
    const { result, status } = await parseExtractor.extract(
      CANONICAL,
      { rawText: 'some text' },
      { ...PARSE_PARAMS, parse_strategy: 'regex-named-groups' },
    );
    expect(status).toBe('rejected-by-rules');
    expect(result).toBeNull();
  });

  it('returns no-trace-available when no pattern matches', async () => {
    const { result, status } = await parseExtractor.extract(
      CANONICAL,
      { rawText: 'unstructured trace content with no choice markers' },
      PARSE_PARAMS,
    );
    expect(status).toBe('no-trace-available');
    expect(result).toBeNull();
  });
});

describe('makeRestructureExtractor', () => {
  const RESTRUCTURE_PARAMS: DetectionRestructureParams = {
    extractor_model: 'claude-haiku-4-5-20251001',
    extractor_temperature: 0,
    extractor_seed: 42,
    prompt_template_ref: 'restructure:v1',
    ontology_ref: 'ailedger-generic:v0.1.0',
    max_tokens: 2000,
  };

  it('calls the supplied LLM client + parses structured response', async () => {
    const llm: LLMClient = async () => ({
      text: '{"decisions": [{"decision_name": "narrow-differential", "options_considered": ["dx-a", "dx-b"], "selected_option": "dx-a", "evidence": "lab values rule out b", "foreclosed": []}]}',
    });
    const restructure = makeRestructureExtractor(llm);
    const { result, status } = await restructure.extract(
      CANONICAL,
      { rawText: 'differential narrowed from a/b to a based on lab values' },
      RESTRUCTURE_PARAMS,
    );
    expect(status).toBe('ok');
    expect(result).not.toBeNull();
    expect(result?.extractorMethod).toBe('detection.restructure');
    expect(result?.output.evidence_type).toBe('restructured-implicit');
    const restructured = result?.output.restructured as { decisions?: unknown[] };
    expect(restructured.decisions).toHaveLength(1);
  });

  it('falls back to status=ok with parse-error on malformed LLM JSON', async () => {
    const llm: LLMClient = async () => ({ text: 'not json at all' });
    const restructure = makeRestructureExtractor(llm);
    const { result, status } = await restructure.extract(
      CANONICAL,
      { rawText: 'some trace' },
      RESTRUCTURE_PARAMS,
    );
    expect(status).toBe('ok');
    expect(result).not.toBeNull();
    const restructured = result?.output.restructured as { _parse_error?: string };
    expect(restructured._parse_error).toBeDefined();
    expect(result?.confidence).toBeLessThanOrEqual(0.3);
  });

  it('returns no-trace-available when both rawText and toolCalls are empty', async () => {
    const llm: LLMClient = async () => ({ text: '{}' });
    const restructure = makeRestructureExtractor(llm);
    const { result, status } = await restructure.extract(
      CANONICAL,
      { rawText: '' },
      RESTRUCTURE_PARAMS,
    );
    expect(status).toBe('no-trace-available');
    expect(result).toBeNull();
  });
});
