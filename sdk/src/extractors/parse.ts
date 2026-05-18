// Extractor rung 1 — detection.parse
//
// Parse-only from existing trace. Cheapest rung. Zero counterfactual
// coverage. High confidence on what the model verbalized in the trace.
//
// v0.2.0 implementation: pure-function extractor that looks for structured
// "chose X because Y" patterns in chain-of-thought text and emits an inferred
// Decision Event capturing the verbalized scaffold.
//
// Per spec §6.1, the param shape is:
//   - trace_source ('chain-of-thought' | 'structured-output' | 'tool-call-sequence')
//   - parse_strategy ('pattern-match' | 'regex-named-groups' | 'json-path')
//   - parse_strategy_version (e.g. 'v1.0')
//   - ontology_ref (e.g. 'ailedger-generic:v0.1.0')

import type { DetectionEvent } from '../types.js';
import type { DetectionParseParams } from '../types.js';
import type { DecisionTrace, ExtractionResult, ExtractionStatus, Extractor } from './types.js';

// Generic patterns matching "chose X because Y" / "selected X because Y" /
// "X (because Y)" shapes commonly found in chain-of-thought traces.
// Authority: gt-lab/docs/compliance-architecture/HANDOFF-decision-event-layer.md
// §"Three classes of decision signal" — class 1 (explicit).
const PARSE_PATTERNS: Array<{ regex: RegExp; choiceGroup: number; reasonGroup: number }> = [
  // "chose|chosen|choosing|selected ... because|since|as ..."
  {
    regex: /\b(?:cho(?:se|sen|osing)|selected|selecting|picking|picked)\s+([^.,;\n]{1,120})\s+(?:because|since|as|due to)\s+([^.\n]{1,300})/i,
    choiceGroup: 1,
    reasonGroup: 2,
  },
  // "X (because/since Y)"
  {
    regex: /\b([A-Z][\w\- ]{0,80})\s*\(\s*(?:because|since|as|due to)\s+([^)]{1,300})\)/,
    choiceGroup: 1,
    reasonGroup: 2,
  },
  // "decision: X. rationale: Y." (structured-output friendly)
  {
    regex: /\bdecision\s*:\s*([^.\n]{1,120})[.,;]\s*(?:rationale|reason)\s*:\s*([^.\n]{1,300})/i,
    choiceGroup: 1,
    reasonGroup: 2,
  },
];

function parseExplicitChoice(text: string): { choice: string; reason: string } | null {
  for (const { regex, choiceGroup, reasonGroup } of PARSE_PATTERNS) {
    const match = text.match(regex);
    if (match) {
      return {
        choice: match[choiceGroup].trim(),
        reason: match[reasonGroup].trim(),
      };
    }
  }
  return null;
}

/** Confidence heuristic: how trustworthy is a parsed explicit choice?
 *
 * - Long reason text + present choice → higher confidence
 * - Very short or empty reason → lower
 * - Choice longer than 80 chars → probably overfit match → lower
 *
 * Output range: [0.5, 0.95]. Cap deliberately well below 1.0 because a
 * verbalized scaffold is what the model SAID, not necessarily what drove
 * the decision. Stronger evidentiary value requires rungs 2-4.
 */
function parseConfidence(parsed: { choice: string; reason: string }): number {
  const choiceLen = parsed.choice.length;
  const reasonLen = parsed.reason.length;
  let conf = 0.7;
  if (reasonLen >= 50) conf += 0.1;
  if (reasonLen >= 120) conf += 0.05;
  if (choiceLen > 80) conf -= 0.1;
  if (reasonLen < 15) conf -= 0.15;
  if (choiceLen === 0 || reasonLen === 0) return 0.5;
  return Math.max(0.5, Math.min(0.95, conf));
}

export const parseExtractor: Extractor<DetectionParseParams> = {
  method: 'detection.parse',
  async extract(
    canonical: DetectionEvent,
    trace: DecisionTrace,
    params: DetectionParseParams,
  ): Promise<{ result: ExtractionResult; status: ExtractionStatus } | { result: null; status: Exclude<ExtractionStatus, 'ok'> }> {
    const startedAt = new Date();

    if (!trace.rawText || trace.rawText.trim().length === 0) {
      return { result: null, status: 'no-trace-available' };
    }

    // Only pattern-match strategy is implemented in v0.2.0. Other strategies
    // (regex-named-groups, json-path) require domain-specific config and are
    // v0.3.0 work.
    if (params.parse_strategy !== 'pattern-match') {
      return { result: null, status: 'rejected-by-rules' };
    }

    const parsed = parseExplicitChoice(trace.rawText);
    if (!parsed) {
      // No explicit-choice pattern found. The canonical decision was made
      // without a verbalized scaffold (or in a shape this extractor doesn't
      // recognize). Higher rungs (restructure / replay / perturb) may still
      // produce useful inference; rung 1 abstains cleanly.
      return { result: null, status: 'no-trace-available' };
    }

    const completedAt = new Date();
    const confidence = parseConfidence(parsed);

    const result: ExtractionResult = {
      anchorEventId: canonical.event_id,
      extractorMethod: 'detection.parse',
      extractorModel: `ailedger-sdk-parser:v1.0`,
      extractorParams: params,
      output: {
        evidence_type: 'verbalized-scaffold',
        verbalized_choice: parsed.choice,
        verbalized_reason: parsed.reason,
        parse_strategy: params.parse_strategy,
        parse_strategy_version: params.parse_strategy_version,
        trace_source: params.trace_source,
        canonical_decision_type: canonical.decision_type ?? null,
      },
      confidence,
      startedAt,
      completedAt,
    };

    return { result, status: 'ok' };
  },
};

export { parseExplicitChoice, parseConfidence };
