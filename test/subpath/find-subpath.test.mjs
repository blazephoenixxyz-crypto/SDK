// Run by `npm run test:subpath` after the build: the public subpath resolves to the built bundle (self-reference through "exports"),
// as ESM and as CJS, and runs with an injected reader and fetch (no network, no RPC).
// Mutant: fromDexscreener returns ok:true on a thrown search -> the sources assertion is red (ERR_ASSERTION).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { findToken, WARNINGS, lookalike } from '@blazephoenix/sdk/find';

const require = createRequire(import.meta.url);

test('@blazephoenix/sdk/find resolves from dist (ESM and CJS) and reports a failed index without pretending', async () => {
  const cjs = require('@blazephoenix/sdk/find');
  assert.equal(typeof cjs.findToken, 'function');
  assert.equal(cjs.WARNINGS.notSafety, WARNINGS.notSafety);
  assert.equal(lookalike('РЕРЕ').suspicious, true);
  const down = async () => { throw new Error('offline'); };
  const reader = { hasCode: async () => true, erc20: async () => ({ symbol: null, name: null, decimals: null }), balanceOf: async () => null, usdValue: async () => { throw new Error('not called'); } };
  const r = await findToken({ query: 'PEPE', chainId: 8453, reader, fetch: down });
  assert.deepEqual(r.candidates, []);
  assert.deepEqual(r.sources.map((s) => [s.name, s.ok]), [['coingecko', false], ['dexscreener', false]]);
  assert.equal(r.warnings[0], WARNINGS.mostLiquid);
  assert.ok(!('selected' in r) && !('best' in r));
});
