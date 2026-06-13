// JCS golden-vector guard — extends the jcs-canary (proxy/scripts/jcs-canary.mjs)
// from one fixed vector to the shared corpus at testdata/jcs-golden-vectors.json.
// A `canonicalize` bump that changes any byte of output fails here before it can
// fork chain hashes. The Python CLI enforces the same corpus (test_canonical.py).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import canonicalize from 'canonicalize';

type Vector = { name: string; input: unknown; expected: string };

const vectorsPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'testdata',
  'jcs-golden-vectors.json',
);
const corpus = JSON.parse(readFileSync(vectorsPath, 'utf8')) as { vectors: Vector[] };

describe('JCS golden vectors (parity with testdata corpus)', () => {
  it('has the expected corpus shape', () => {
    expect(corpus.vectors.length).toBeGreaterThanOrEqual(7);
  });

  for (const vector of corpus.vectors) {
    it(`matches: ${vector.name}`, () => {
      expect(canonicalize(vector.input as Parameters<typeof canonicalize>[0])).toBe(
        vector.expected,
      );
    });
  }
});
