// Extractors module — public API
//
// The 4-rung method ladder per param canonicalization spec v1.0.
// v0.2.0 ships rung 1 (parse) full implementation + rung 2 (restructure)
// scaffold + stubs for rungs 3-4.

export { parseExtractor, parseExplicitChoice, parseConfidence } from './parse.js';
export { makeRestructureExtractor } from './restructure.js';
export type { LLMClient } from './restructure.js';

export type {
  DecisionTrace,
  ExtractionResult,
  ExtractionStatus,
  Extractor,
} from './types.js';

// v0.3.0 stubs — rung 3 + rung 4 documented at module level but not yet
// implemented. The shape mirrors makeRestructureExtractor (factory taking an
// LLM client) since replay + perturb both need sampling against an LLM.
//
// makeReplayExtractor(llm): Extractor<DetectionReplayParams>
//   Re-samples the canonical decision at configured branch points across a
//   temperature_grid x seed_grid. Output: distribution over alternatives.
//
// makePerturbExtractor(llm): Extractor<DetectionPerturbParams>
//   Applies bounded prompt perturbations (lexical-substitution, entity-swap,
//   numeric-bounded-jitter, protected-class-flip) and maps the decision
//   boundary. Output: counterfactual map showing which input changes flip
//   the decision.
