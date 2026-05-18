// Extractor rung 3 — detection.replay
//
// Re-samples the canonical decision at configured branch points across a
// temperature_grid × seed_grid. Output: distribution over alternatives.
//
// High cost; high counterfactual coverage. Captures decision robustness:
// would the model have made the same choice under different sampling
// conditions? Where are the branch points where small perturbations flip
// the outcome?
//
// v0.2.0 scope: scaffold + types. Sampling runs against caller-supplied
// LLMClient. The SDK does not include a fetch call to any specific
// provider — consumers wire whatever auth they already use.

import type { DetectionEvent } from '../types.js';
import type { DetectionReplayParams } from '../types.js';
import type { DecisionTrace, ExtractionResult, Extractor } from './types.js';
import type { LLMClient } from './restructure.js';

/** A single replay sample at one (branch_point, temperature, seed) combo. */
interface ReplaySample {
  branch_point: string;
  temperature: number;
  seed: number;
  output: string;
  parsed_choice?: string;
}

/** Distribution over choices observed across the full grid. */
interface ReplayDistribution {
  branch_point: string;
  samples: number;
  unique_outcomes: number;
  outcome_counts: Record<string, number>;
  modal_outcome: string;
  modal_share: number;
  divergence_score: number;
}

/** Factory: build a rung-3 extractor with the caller's LLMClient bound. */
export function makeReplayExtractor(llm: LLMClient): Extractor<DetectionReplayParams> {
  return {
    method: 'detection.replay',
    async extract(
      canonical: DetectionEvent,
      trace: DecisionTrace,
      params: DetectionReplayParams,
    ) {
      const startedAt = new Date();

      if (!trace.rawText && (!trace.toolCalls || trace.toolCalls.length === 0)) {
        return { result: null, status: 'no-trace-available' as const };
      }

      // Validate grid invariant per spec §6.3: replay_count must equal
      // temperature_grid.length × seed_grid.length × branch_points.length.
      // The SDK canonicalize.ts also enforces this; redundant check here
      // catches misuse before any LLM calls fire.
      const expected = params.temperature_grid.length * params.seed_grid.length * params.branch_points.length;
      if (params.replay_count !== expected) {
        throw new Error(
          `detection.replay invariant violated: replay_count=${params.replay_count} ` +
          `but temperature_grid(${params.temperature_grid.length}) × ` +
          `seed_grid(${params.seed_grid.length}) × ` +
          `branch_points(${params.branch_points.length}) = ${expected}`,
        );
      }

      // Run the grid. For each (branch_point, temperature, seed) tuple,
      // execute one LLM call. Collect all samples.
      const samples: ReplaySample[] = [];
      const errors: Array<{ branch_point: string; temperature: number; seed: number; error: string }> = [];

      for (const branch of params.branch_points) {
        for (const temp of params.temperature_grid) {
          for (const seed of params.seed_grid) {
            const prompt = buildReplayPrompt(canonical, trace, branch, params);
            try {
              const response = await llm(prompt, {
                model: params.extractor_model,
                temperature: temp,
                seed,
                maxTokens: 1000,
              });
              samples.push({
                branch_point: branch,
                temperature: temp,
                seed,
                output: response.text,
                parsed_choice: parseChoiceFromOutput(response.text),
              });
            } catch (err) {
              errors.push({
                branch_point: branch,
                temperature: temp,
                seed,
                error: String(err),
              });
            }
          }
        }
      }

      const completedAt = new Date();

      // Aggregate distributions per branch_point.
      const distributions: ReplayDistribution[] = params.branch_points.map((branch) =>
        aggregateDistribution(branch, samples),
      );

      // Overall confidence: how stable is the canonical decision under
      // resampling? Higher modal-share across all branch points → higher
      // confidence the canonical was robust; lower → the canonical sat
      // near a decision boundary.
      const confidence = replayConfidence(distributions);

      const result: ExtractionResult = {
        anchorEventId: canonical.event_id,
        extractorMethod: 'detection.replay',
        extractorModel: params.extractor_model,
        extractorParams: params,
        output: {
          evidence_type: 'replay-distribution',
          distributions,
          total_samples: samples.length,
          error_count: errors.length,
          errors: errors.length > 0 ? errors : undefined,
          prompt_template_ref: params.prompt_template_ref,
          ontology_ref: params.ontology_ref,
          canonical_decision_type: canonical.decision_type ?? null,
        },
        confidence,
        startedAt,
        completedAt,
      };

      return { result, status: 'ok' as const };
    },
  };
}

function buildReplayPrompt(
  canonical: DetectionEvent,
  trace: DecisionTrace,
  branchPoint: string,
  params: DetectionReplayParams,
): string {
  return `You are re-sampling an AI decision at a specific branch point.

Canonical Decision Event:
- event_id: ${canonical.event_id}
- decision_type: ${canonical.decision_type ?? 'unspecified'}
- ontology: ${params.ontology_ref}

Original trace (truncated):
"""
${trace.rawText.slice(0, 2000)}
"""

Branch point to re-sample: "${branchPoint}"

Generate the decision at this branch point. Return ONLY the chosen option, one line, no rationale.`;
}

/** Best-effort extraction of the choice from a re-sample response. */
function parseChoiceFromOutput(text: string): string {
  const firstLine = text.trim().split('\n')[0].trim();
  // Strip common prefixes that models add
  const stripped = firstLine.replace(/^(decision|choice|option|answer)\s*:\s*/i, '').trim();
  return stripped.slice(0, 200);
}

function aggregateDistribution(branchPoint: string, samples: ReplaySample[]): ReplayDistribution {
  const forBranch = samples.filter((s) => s.branch_point === branchPoint && s.parsed_choice);
  const counts: Record<string, number> = {};
  for (const s of forBranch) {
    const key = s.parsed_choice ?? '<unparsed>';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const total = forBranch.length || 1;
  const sortedOutcomes = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const modalOutcome = sortedOutcomes[0]?.[0] ?? '<no-samples>';
  const modalShare = (sortedOutcomes[0]?.[1] ?? 0) / total;

  // Divergence score: 1 - modal_share; higher = more variability across the grid.
  // Range [0, 1]. 0 = canonical robust; 1 = nearly uniform alternatives.
  const divergenceScore = 1 - modalShare;

  return {
    branch_point: branchPoint,
    samples: forBranch.length,
    unique_outcomes: Object.keys(counts).length,
    outcome_counts: counts,
    modal_outcome: modalOutcome,
    modal_share: modalShare,
    divergence_score: divergenceScore,
  };
}

function replayConfidence(distributions: ReplayDistribution[]): number {
  if (distributions.length === 0) return 0;
  // Confidence = average modal share across branch points.
  // High modal share at every branch = canonical decision was robust.
  // Low modal share at any branch = canonical sat on a decision boundary.
  const avgModalShare = distributions.reduce((sum, d) => sum + d.modal_share, 0) / distributions.length;
  // Cap at 0.85 — replay is sampling-based; the residual 0.15 acknowledges
  // grid coverage isn't exhaustive. Spec §6.3 invariant ensures grid was
  // declared explicitly so the user is aware of the coverage.
  return Math.min(0.85, Math.max(0.1, avgModalShare));
}
