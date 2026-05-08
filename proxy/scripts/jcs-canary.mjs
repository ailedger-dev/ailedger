// JCS canary — guards threat model §6.8.
//
// 2026-04-29 incident: a silent CI deploy regression dropped `canonicalize`
// from node_modules and broke chain integrity for ~24 hours. Even with the
// dependency present, a canonicalize bump that changed JCS output would
// silently fork future hashes from the on-chain history.
//
// This script computes JCS for a fixed input and aborts the deploy if the
// output differs from the byte-for-byte expected value. Run BEFORE
// `wrangler deploy` in CI (see .github/workflows/deploy.yml).
import canonicalize from 'canonicalize';

const input = { z: 1, a: { y: 2, x: [3, 1, 2] }, b: 'test' };
const expected = '{"a":{"x":[3,1,2],"y":2},"b":"test","z":1}';
const actual = canonicalize(input);

if (actual !== expected) {
  console.error('JCS canary FAILED');
  console.error('expected:', expected);
  console.error('actual:  ', actual);
  process.exit(1);
}

console.log('JCS canary OK');
