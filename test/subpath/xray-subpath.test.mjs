// Run by `npm run test:subpath` after the build: the public subpath resolves to the built bundle (self-reference through "exports").
import test from 'node:test';
import assert from 'node:assert/strict';
import { xrayStart, combine, REQUIRED } from '@blazephoenix/sdk/xray';

test('@blazephoenix/sdk/xray resolves from dist and is sans-IO', () => {
  const s = xrayStart({ chainId: 8453, token: '0x' + '44'.repeat(20), amountIn: 10n ** 15n, maxTaxBps: 100 });
  assert.deepEqual(s.need[0], { method: 'eth_chainId', params: [] });
  assert.deepEqual([...REQUIRED], ['sim', 'quoter', 'transfer']);
  assert.equal(combine({ sim: 'MEASURED', quoter: 'MEASURED' }), 'WARN');
});
