// Extractors module — public API
//
// The 4-rung method ladder per param canonicalization spec v1.0.
// v0.2.0 ships rung 1 (parse) full implementation + rungs 2-4 scaffolds
// (caller-supplied LLMClient).

export { parseExtractor, parseExplicitChoice, parseConfidence } from './parse.js';
export { makeRestructureExtractor } from './restructure.js';
export { makeReplayExtractor } from './replay.js';
export { makePerturbExtractor } from './perturb.js';
export type { LLMClient } from './restructure.js';

export type {
  DecisionTrace,
  ExtractionResult,
  ExtractionStatus,
  Extractor,
} from './types.js';
