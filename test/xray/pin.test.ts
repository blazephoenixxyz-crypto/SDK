// Pin hardening (W2-core-5, orchestrator decisions a, b): frozen deployments; the pinned-block code batch also
// reads the token and Multicall3. Token without code -> NOT_MEASURED; Multicall3 with a foreign codehash -> tier C
// unavailable (never MEASURED through it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runXray } from '../../src/xray/index.js';
import { XRAY_DEPLOYMENTS } from '../../src/xray/ctx.js';
import { MC3 } from '../../src/xray/abi.js';
import { fakeNode, TOKEN } from './fake.js';

const IN = { chainId: 8453, token: TOKEN, amountIn: 10n ** 15n, maxTaxBps: 500 };
const down = { error: { code: -32601, message: 'the method eth_simulateV1 does not exist/is not available' } };

test('(a) XRAY_DEPLOYMENTS is deeply frozen: no caller swaps an address or a pin, nor adds a chain', () => {
  assert.ok(Object.isFrozen(XRAY_DEPLOYMENTS));
  for (const d of Object.values(XRAY_DEPLOYMENTS)) assert.ok(Object.isFrozen(d));
  const before = XRAY_DEPLOYMENTS[8453].router;
  assert.throws(() => { (XRAY_DEPLOYMENTS as any)[8453].router = '0x' + '00'.repeat(20); }, TypeError);
  assert.throws(() => { (XRAY_DEPLOYMENTS as any)[8453].rh = '0x' + '00'.repeat(32); }, TypeError);
  assert.throws(() => { (XRAY_DEPLOYMENTS as any)[10] = { ...XRAY_DEPLOYMENTS[8453] }; }, TypeError);
  assert.equal(XRAY_DEPLOYMENTS[8453].router, before);
  assert.equal((XRAY_DEPLOYMENTS as any)[10], undefined);
});

test('(b) the pinned code batch reads router, quoter, token and Multicall3 at the pinned block hash', async () => {
  const f = fakeNode();
  await runXray(f.transport, IN);
  const codes = f.reqs.filter((r) => r.method === 'eth_getCode');
  assert.deepEqual(codes.map((r) => String(r.params[0]).toLowerCase()),
    [XRAY_DEPLOYMENTS[8453].router, XRAY_DEPLOYMENTS[8453].quoter, TOKEN, MC3].map((a) => a.toLowerCase()));
  const pinned = f.reqs.find((r) => r.method === 'eth_getBlockByNumber')!;
  assert.ok(codes.every((r) => (r.params[1] as any).blockHash && (r.params[1] as any).blockHash.length === 66), String(pinned.params[0]));
});

test('(b) token without code at the pinned block -> NOT_MEASURED, no simulation asked', async () => {
  const f = fakeNode({ tokenCode: '0x' });
  const r = await runXray(f.transport, IN);
  assert.equal(r.verdict, 'WARN');
  assert.equal(r.rung, null);
  assert.deepEqual(r.notMeasured, ['sim', 'quoter', 'transfer']);
  assert.match(r.instruments[0].reason, /token has no code/);
  assert.equal(f.reqs.filter((q) => q.method === 'eth_simulateV1' || q.method === 'eth_call').length, 0);
});

test('(b) Multicall3 with a foreign codehash: tier C unavailable, A/B down -> NOT_MEASURED, never MEASURED via C', async () => {
  const f = fakeNode({ mc3Code: '0x6001', probe: { 'A:d4': down, 'A:d2': down, B: { error: { code: -32602, message: 'state override refused' } } } });
  const r = await runXray(f.transport, IN);
  assert.equal(r.rung, null);
  assert.equal(r.verdict, 'WARN');
  assert.match(r.instruments[0].reason, /Multicall3/);
  assert.equal(f.reqs.filter((q) => q.method === 'eth_call' && String((q.params[0] as any).to).toLowerCase() === MC3.toLowerCase()).length, 0);
});

test('(b) Multicall3 with a foreign codehash does not touch tier A', async () => {
  const r = await runXray(fakeNode({ mc3Code: '0x6001' }).transport, IN);
  assert.equal(r.rung, 'A:d4');
  assert.equal(r.instruments.find((i) => i.name === 'quoter')!.status, 'MEASURED');
  assert.doesNotMatch(r.text, /Multicall3/);
});

test('(b) control: real Multicall3, A/B down -> tier C measures', async () => {
  const f = fakeNode({ probe: { 'A:d4': down, 'A:d2': down, B: { error: { code: -32602, message: 'state override refused' } } } });
  const r = await runXray(f.transport, IN);
  assert.equal(r.rung, 'C');
});
