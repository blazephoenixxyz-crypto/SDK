import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lowest } from '../../src/find/onchain/kinds.js';

// Mutant: lowest = xs.length ? Math.min(...xs) : null -> RangeError on the 200,000-entry list.
// Mutant: x > lo -> the highest is returned. Mutant: return xs[0] ?? null -> first, not lowest.
test('[extreme] lowest of 200,000 venue blocks does not overflow the argument limit', () => {
  const xs = Array.from({ length: 200_000 }, (_, i) => 1_000_000 - i);
  assert.equal(lowest(xs), 800_001);
});
test('[range] lowest: empty, one, unordered, duplicates', () => {
  assert.equal(lowest([]), null);
  assert.equal(lowest([7]), 7);
  assert.equal(lowest([9, 3, 5]), 3);
  assert.equal(lowest([4, 2, 2, 8]), 2);
});
