// Extractor rung 4 — detection.perturb
//
// Applies bounded prompt perturbations and maps the decision boundary.
// Highest cost; highest counterfactual coverage. Captures decision
// fairness + robustness under controlled input variation.
//
// Four perturbation strategies (per spec §6.4):
//   - lexical-substitution: synonym swaps within a held-out field
//   - entity-swap: replace named entities (preserving entity-type)
//   - numeric-bounded-jitter: vary numeric inputs within a declared bound
//   - protected-class-flip: swap protected-class attributes (race, gender,
//     age band, etc.) to test for disparate-impact at the individual case
//
// v0.2.0 scope: scaffold with the four-strategy dispatcher + bounds-spec
// validation. Each strategy emits perturbed prompts that the caller's
// LLMClient runs; results map to a counterfactual boundary report.

import type { DetectionEvent } from '../types.js';
import type { DetectionPerturbParams } from '../types.js';
import type { DecisionTrace, ExtractionResult, Extractor } from './types.js';
import type { LLMClient } from './restructure.js';

interface PerturbedSample {
  perturbation_id: string;
  strategy: string;
  perturbation_description: string;
  output: string;
  parsed_choice?: string;
  flipped: boolean;
}

interface PerturbReport {
  strategy: string;
  total_perturbations: number;
  flip_count: number;
  flip_rate: number;
  flipped_examples: Array<{
    perturbation_description: string;
    output: string;
  }>;
}

export function makePerturbExtractor(llm: LLMClient): Extractor<DetectionPerturbParams> {
  return {
    method: 'detection.perturb',
    async extract(
      canonical: DetectionEvent,
      trace: DecisionTrace,
      params: DetectionPerturbParams,
    ) {
      const startedAt = new Date();

      if (!trace.rawText && (!trace.toolCalls || trace.toolCalls.length === 0)) {
        return { result: null, status: 'no-trace-available' as const };
      }

      // Validate bounds_spec presence per strategy
      const validationError = validateBoundsSpec(params);
      if (validationError) {
        return {
          result: {
            anchorEventId: canonical.event_id,
            extractorMethod: 'detection.perturb',
            extractorModel: params.extractor_model,
            extractorParams: params,
            output: {
              evidence_type: 'perturb-error',
              error: validationError,
              strategy: params.perturbation_strategy,
            },
            confidence: 0,
            startedAt,
            completedAt: new Date(),
          },
          status: 'rejected-by-rules' as const,
        };
      }

      // Get the original choice from the trace (best-effort)
      const originalChoice = extractOriginalChoice(trace);

      // Generate N perturbations using the configured strategy
      const perturbations = generatePerturbations(trace, params);

      // Run each perturbation through the LLM
      const samples: PerturbedSample[] = [];
      for (const perturbation of perturbations) {
        const prompt = buildPerturbPrompt(canonical, perturbation.perturbedTrace, params);
        try {
          const response = await llm(prompt, {
            model: params.extractor_model,
            temperature: 0,
            seed: 42,
            maxTokens: 500,
          });
          const parsedChoice = parseChoiceFromOutput(response.text);
          samples.push({
            perturbation_id: perturbation.id,
            strategy: params.perturbation_strategy,
            perturbation_description: perturbation.description,
            output: response.text,
            parsed_choice: parsedChoice,
            flipped: parsedChoice !== originalChoice && originalChoice !== '<unknown>',
          });
        } catch (err) {
          samples.push({
            perturbation_id: perturbation.id,
            strategy: params.perturbation_strategy,
            perturbation_description: perturbation.description,
            output: `<error: ${err}>`,
            flipped: false,
          });
        }
      }

      const completedAt = new Date();

      const flippedSamples = samples.filter((s) => s.flipped);
      const report: PerturbReport = {
        strategy: params.perturbation_strategy,
        total_perturbations: samples.length,
        flip_count: flippedSamples.length,
        flip_rate: samples.length > 0 ? flippedSamples.length / samples.length : 0,
        flipped_examples: flippedSamples.slice(0, 5).map((s) => ({
          perturbation_description: s.perturbation_description,
          output: s.output,
        })),
      };

      const confidence = perturbConfidence(report, params);

      const result: ExtractionResult = {
        anchorEventId: canonical.event_id,
        extractorMethod: 'detection.perturb',
        extractorModel: params.extractor_model,
        extractorParams: params,
        output: {
          evidence_type: 'perturb-boundary-map',
          report,
          original_choice: originalChoice,
          all_samples: samples,
          strategy_version: params.perturbation_strategy_version,
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

function validateBoundsSpec(params: DetectionPerturbParams): string | null {
  if (!params.bounds_spec || typeof params.bounds_spec !== 'object') {
    return 'bounds_spec must be a non-empty object';
  }
  const requiredKeys: Record<DetectionPerturbParams['perturbation_strategy'], string[]> = {
    'lexical-substitution': ['synonym_source', 'fields'],
    'entity-swap': ['entity_types', 'swap_pool'],
    'numeric-bounded-jitter': ['fields', 'relative_bound'],
    'protected-class-flip': ['attributes', 'value_pool'],
  };
  const needed = requiredKeys[params.perturbation_strategy] ?? [];
  for (const key of needed) {
    if (!(key in params.bounds_spec)) {
      return `bounds_spec missing required key '${key}' for strategy '${params.perturbation_strategy}'`;
    }
  }
  return null;
}

interface Perturbation {
  id: string;
  description: string;
  perturbedTrace: DecisionTrace;
}

function generatePerturbations(trace: DecisionTrace, params: DetectionPerturbParams): Perturbation[] {
  // v0.2.0: strategy-specific perturbation logic is STUBBED.
  // Each strategy generator returns N candidate perturbations of the trace.
  // Real implementation requires synonym dictionaries, entity recognizers,
  // numeric bound calculators, and protected-class value pools — all of
  // which need ontology / domain context that doesn't fit in the SDK core.
  //
  // The dispatcher here returns placeholder perturbations that exercise
  // the LLM-call + flip-detection + report pipeline. v0.3.0 wires real
  // strategy generators (likely as caller-supplied augmentations).

  const perturbations: Perturbation[] = [];
  for (let i = 0; i < params.perturbation_count; i++) {
    perturbations.push({
      id: `perturb-${params.perturbation_strategy}-${i}`,
      description: `${params.perturbation_strategy} variation ${i + 1} (v0.2.0 stub generator)`,
      perturbedTrace: {
        ...trace,
        rawText: trace.rawText + `\n\n[PERTURBATION ${i + 1} via ${params.perturbation_strategy}]`,
      },
    });
  }
  return perturbations;
}

function buildPerturbPrompt(canonical: DetectionEvent, perturbedTrace: DecisionTrace, params: DetectionPerturbParams): string {
  return `You are re-running an AI decision with a perturbed input.

Canonical Decision Event:
- event_id: ${canonical.event_id}
- decision_type: ${canonical.decision_type ?? 'unspecified'}
- ontology: ${params.ontology_ref}

Perturbation strategy: ${params.perturbation_strategy} (v${params.perturbation_strategy_version})

Perturbed trace:
"""
${perturbedTrace.rawText.slice(0, 2500)}
"""

Holdout fields (do not consider these): ${params.holdout_fields.join(', ') || 'none'}

Generate the decision. Return ONLY the chosen option, one line, no rationale.`;
}

function extractOriginalChoice(trace: DecisionTrace): string {
  // Best-effort: look for "decision: X" or "chose X" patterns in the trace
  const decisionMatch = trace.rawText.match(/\b(?:decision|chose|chosen|selected)\s*:?\s*([^.,;\n]{1,80})/i);
  return decisionMatch ? decisionMatch[1].trim() : '<unknown>';
}

function parseChoiceFromOutput(text: string): string {
  const firstLine = text.trim().split('\n')[0].trim();
  const stripped = firstLine.replace(/^(decision|choice|option|answer)\s*:\s*/i, '').trim();
  return stripped.slice(0, 200);
}

function perturbConfidence(report: PerturbReport, params: DetectionPerturbParams): number {
  // Confidence semantics for perturb are inverted from typical:
  // - Low flip rate = canonical is robust = HIGH evidentiary confidence
  // - High flip rate = canonical is fragile = the report is evidence of
  //   fragility, which is itself ALSO high evidentiary value (just not
  //   evidence FOR the canonical being correct)
  //
  // We surface flip_rate directly in output; confidence here represents
  // "how confident are we in the boundary map produced," not "how confident
  // are we in the canonical decision." Higher samples = higher confidence.
  if (report.total_perturbations === 0) return 0;
  // protected-class-flip strategy carries higher evidentiary weight for
  // disparate-impact detection; bump confidence.
  let base = Math.min(0.8, 0.4 + 0.01 * report.total_perturbations);
  if (params.perturbation_strategy === 'protected-class-flip') {
    base = Math.min(0.9, base + 0.1);
  }
  return base;
}
