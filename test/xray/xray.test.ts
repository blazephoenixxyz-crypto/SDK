// xrayStart / xrayStep / runXray (DEEP §3.0): exact requests without id, state bound to the input, fail closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { xrayStart, xrayStep, runXray, XrayError } from '../../src/xray/index.js';

const IN = { chainId: 8453, token: '0x' + '44'.repeat(20), amountIn: 10n ** 15n, maxTaxBps: 100 };
const first = () => { const s = xrayStart(IN); assert.ok('need' in s); return s; };
const code = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof XrayError ? e.code : String(e); } return 'no throw'; };

test('first batch: chainId, latest block number, gas price; exact {method, params}, no id', () => {
  assert.deepEqual(first().need, [{ method: 'eth_chainId', params: [] }, { method: 'eth_blockNumber', params: [] }, { method: 'eth_gasPrice', params: [] }]);
  assert.equal(first().state.block, null);
});

test('state_mismatch: tampered inputHash, tampered input, foreign version, recorded answers of the wrong size', () => {
  const s = first().state;
  assert.equal(code(() => xrayStep({ ...s, inputHash: '0x' + '00'.repeat(32) }, [])), 'state_mismatch');
  assert.equal(code(() => xrayStep({ ...s, input: { ...(s.input as any), token: '0x' + '55'.repeat(20) } }, [])), 'state_mismatch');
  assert.equal(code(() => xrayStep({ ...s, v: 2 } as any, [])), 'state_mismatch');
  assert.equal(code(() => xrayStep({ ...s, answers: [[{ result: '0x2105' }]] }, [])), 'state_mismatch');
  assert.equal(code(() => xrayStep({ ...s, block: { number: '1', hash: '0x' + '00'.repeat(32) } }, [])), 'state_mismatch');
});

test('bad_responses and bad_input fail closed', () => {
  assert.equal(code(() => xrayStep(first().state, [{ result: '0x2105' }])), 'bad_responses');
  assert.equal(code(() => xrayStart({ ...IN, chainId: 999 })), 'bad_input');
  assert.equal(code(() => xrayStart({ ...IN, amountIn: 0n })), 'bad_input');
  assert.equal(code(() => xrayStart({ ...IN, token: 'nope' })), 'bad_input');
  assert.equal(code(() => xrayStart({ ...IN, maxTaxBps: undefined } as any)), 'bad_input');
});

test('pin fails closed: wrong chain id, router codehash mismatch', () => {
  const s = first();
  assert.match(code(() => xrayStep(s.state, [{ result: '0x1' }, { result: '0x64' }, { result: '0x1' }])), /chainId mismatch/);
  const s2 = xrayStep(s.state, [{ result: '0x2105' }, { result: '0x64' }, { result: '0x1' }]);
  assert.ok('need' in s2);
  assert.deepEqual(s2.need.map((r) => r.params[0]), ['0x5a', '0x5b', '0x5c', '0x5d', '0x5e', '0x5f']);
  const hs = s2.need.map((_, k) => ({ result: { number: '0x' + (90 + k).toString(16), hash: '0x' + 'aa'.repeat(32), timestamp: '0x1' } }));
  const s3 = xrayStep(s2.state, hs);
  assert.ok('need' in s3);
  assert.deepEqual(s3.need[0].params[1], { blockHash: '0x' + 'aa'.repeat(32) });
  assert.match(code(() => xrayStep(s3.state, [{ result: '0x00' }, { result: '0x00' }, { result: '0x00' }, { result: '0x00' }])), /codehash mismatch/);
});

test('runXray: the transport is the only I/O and must answer every request', async () => {
  const seen: unknown[] = [];
  await assert.rejects(runXray(async (b) => { seen.push(b); return []; }, IN), (e: unknown) => e instanceof XrayError && e.code === 'bad_responses');
  assert.equal(seen.length, 1);
});
