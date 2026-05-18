// Extractor rung 2 — detection.restructure
//
// A smaller model normalizes implicit decisions in the trace into the
// Decision Event schema. Moderate cost. Captures decisions encoded in
// trajectory (tool calls that foreclose downstream classes, implicit
// scaffold choices not verbalized explicitly).
//
// v0.2.0 scope: scaffold + types. Implementation requires an LLM client
// passed in by the caller (deferred so the SDK doesn't bind to a specific
// provider; v0.3.0 will ship Anthropic + OpenAI adapters).

import type { DetectionEvent } from '../types.js';
import type { DetectionRestructureParams } from '../types.js';
import type { DecisionTrace, ExtractionResult, Extractor } from './types.js';

/** Caller-supplied LLM client contract. The SDK does not include a fetch
 * call to any provider; consumers pass a function that takes the assembled
 * prompt and returns the structured output. Lets the SDK stay
 * provider-agnostic and lets callers route through whatever auth they
 * already have. */
export type LLMClient = (
  prompt: string,
  options: {
    model: string;
    temperature: number;
    seed: number;
    maxTokens: number;
  },
) => Promise<{ text: string; structured?: Record<string, unknown> }>;

/** Factory: build a rung-2 extractor with the caller's LLM client bound. */
export function makeRestructureExtractor(llm: LLMClient): Extractor<DetectionRestructureParams> {
  return {
    method: 'detection.restructure',
    async extract(
      canonical: DetectionEvent,
      trace: DecisionTrace,
      params: DetectionRestructureParams,
    ) {
      const startedAt = new Date();

      if (!trace.rawText && (!trace.toolCalls || trace.toolCalls.length === 0)) {
        return { result: null, status: 'no-trace-available' as const };
      }

      const prompt = buildRestructurePrompt(canonical, trace, params);

      let llmResponse: { text: string; structured?: Record<string, unknown> };
      try {
        llmResponse = await llm(prompt, {
          model: params.extractor_model,
          temperature: params.extractor_temperature,
          seed: params.extractor_seed,
          maxTokens: params.max_tokens,
        });
      } catch (err) {
        return {
          result: {
            anchorEventId: canonical.event_id,
            extractorMethod: 'detection.restructure',
            extractorModel: params.extractor_model,
            extractorParams: params,
            output: {
              evidence_type: 'restructure-error',
              error: String(err),
              prompt_template_ref: params.prompt_template_ref,
            },
            confidence: 0,
            startedAt,
            completedAt: new Date(),
          },
          status: 'rejected-by-rules' as const,
        };
      }

      const completedAt = new Date();

      const structured = llmResponse.structured ?? tryParseStructured(llmResponse.text);
      const confidence = restructureConfidence(structured);

      const result: ExtractionResult = {
        anchorEventId: canonical.event_id,
        extractorMethod: 'detection.restructure',
        extractorModel: params.extractor_model,
        extractorParams: params,
        output: {
          evidence_type: 'restructured-implicit',
          restructured: structured,
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

/** Default prompt template. Callers can override by supplying a different
 * prompt_template_ref + their own LLMClient. */
function buildRestructurePrompt(
  canonical: DetectionEvent,
  trace: DecisionTrace,
  params: DetectionRestructureParams,
): string {
  return `You are restructuring an AI decision trace into structured form.

Canonical Decision Event metadata:
- event_id: ${canonical.event_id}
- decision_type: ${canonical.decision_type ?? 'unspecified'}
- model_version: ${canonical.model_version ?? 'unspecified'}
- ontology: ${params.ontology_ref}

Trace (chain-of-thought / structured output):
"""
${trace.rawText}
"""

${trace.toolCalls && trace.toolCalls.length > 0 ? `Tool calls:
${JSON.stringify(trace.toolCalls, null, 2)}` : ''}

Extract the implicit decisions encoded in this trace. For each implicit
decision, return:
- decision_name: a short identifier
- options_considered: list of alternatives evident in the trace
- selected_option: which alternative was chosen
- evidence: the trace fragment that established the choice
- foreclosed: any downstream classes this decision rules out

Return as JSON only. If no structured implicit decisions can be extracted,
return {"decisions": [], "reason": "no-implicit-decisions-found"}.`;
}

function tryParseStructured(text: string): Record<string, unknown> {
  try {
    const trimmed = text.trim();
    const jsonStart = trimmed.indexOf('{');
    const jsonEnd = trimmed.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
      return { _parse_error: 'no-json-found', raw: text.slice(0, 500) };
    }
    return JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;
  } catch (err) {
    return { _parse_error: String(err), raw: text.slice(0, 500) };
  }
}

function restructureConfidence(structured: Record<string, unknown>): number {
  if (structured._parse_error) return 0.2;
  const decisions = structured.decisions;
  if (!Array.isArray(decisions)) return 0.4;
  if (decisions.length === 0) return 0.5;
  // Each well-formed decision raises confidence; cap at 0.9 since restructure
  // is interpretive (a smaller model normalizing implicit content).
  return Math.min(0.9, 0.6 + 0.05 * decisions.length);
}
