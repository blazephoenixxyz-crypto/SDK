// Lesson (c), asymmetric verdict: a sale that reverts CONDEMNs; an empty quote or a missing route only warns
// (NOT_MEASURED, never CONDEMN and never MEASURED); a provider limit is NOT_MEASURED; the text never calls a
// NOT_MEASURED result clear or safe. Each test names the mutant that turns it red ([Mxx]/[Rx], xray-ship/mut.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { measure, instrumentVerdict } from '../../src/xray/measure.js';
import { buildReport } from '../../src/xray/report.js';
import { runXray } from '../../src/xray/index.js';
import { fakeNode, TOKEN } from './fake.js';

// Same clean vector as verdict-falseclean.test.ts (copied: importing a test file would run its tests again).
const OK = () => ({ ok: true, gas: 40_000n, revertData: '0x' });
const clean = (k = 1n): any => ({
  unmeasured: 0n,
  quoteBuy: OK(), buy: OK(), buyHops: 1n, buyIn: 10_000n * k, buyPoolSent: 10_000n * k, buyDelivered: 9_972n * k,
  quoteSell: OK(), sellHops: 1n, sell: OK(), sellIn: 4_986n * k, sellPoolReceived: 4_986n * k, sellOut: 4_900n * k, sellTokenSelfDelta: 0n,
  transfer: OK(), transferSent: 100n * k, transferReceived: 100n * k,
  poolTransfer: OK(), poolTransferSent: 100n * k, poolTransferReceived: 100n * k,
});

const V = (r: any) => instrumentVerdict(measure(r), { maxTaxBps: 100 });
const SCALES = [1n, 10n ** 14n, 10n ** 18n];
const REVERT = { ok: false, gas: 31_337n, revertData: '0x08c379a0' };

for (const k of SCALES) {
  test(`[c] sale reverts at scale ${k}, direct sale not measured: CONDEMN [M12]`, () => {
    const r = clean(k); r.sell = { ...REVERT };
    const v = V(r);
    assert.equal(v.v, 'CONDEMN'); assert.equal(v.why, 'sell reverted');
  });
  for (const [name, q] of [['ok:false', { ok: false, gas: 40_000n, revertData: '0x' }], ['absent', undefined]] as const) {
    test(`[c] sell quote ${name} at scale ${k} with a failed sell step: NOT_MEASURED, never CONDEMN [M13]`, () => {
      const r = clean(k); r.quoteSell = q; r.sell = { ...REVERT };
      const m = measure(r);
      assert.equal(m.sellOk, null); assert.ok(m.notes.includes('no sell route at this block'));
      const v = V(r);
      assert.equal(v.status, 'NOT_MEASURED'); assert.equal(v.v, 'WARN');
    });
    test(`[c] buy quote ${name} at scale ${k} with an executed buy: NOT_MEASURED, never MEASURED [M14]`, () => {
      const r = clean(k); r.quoteBuy = q;
      const m = measure(r);
      assert.equal(m.buyOk, null); assert.ok(m.notes.includes('no buy route'));
      const v = V(r);
      assert.equal(v.status, 'NOT_MEASURED'); assert.equal(v.v, 'WARN');
    });
  }
}

// End to end on every rung of the fake node (exact values in happy.test.ts).
const IN = { chainId: 8453, token: TOKEN, amountIn: 10n ** 15n, maxTaxBps: 500 };
const down = { error: { code: -32601, message: 'the method eth_simulateV1 does not exist/is not available' } };
const refused = { error: { code: -32602, message: 'state override refused' } };
const RUNGS: Record<string, any> = { 'A:d4': {}, B: { 'A:d4': down, 'A:d2': down }, C: { 'A:d4': down, 'A:d2': down, B: refused } };
const UNSAFE = /\b(clear|clean|safe|secure|passed|verified|no risk|risk[- ]free|honeypot[- ]free|not a honeypot|audited)\b/i;
for (const [rung, probe] of Object.entries(RUNGS)) {
  test(`[c] ${rung}: Router sale reverts -> CONDEMN "sell reverted" [M12]`, async () => {
    const r = await runXray(fakeNode({ probe, sellRevert: true }).transport, IN);
    assert.equal(r.rung, rung); assert.equal(r.verdict, 'CONDEMN');
    assert.equal(r.instruments.find((i) => i.name === 'sim')!.reason, 'sell reverted');
  });
  test(`[c] ${rung}: no sell route -> WARN, sim NOT_MEASURED, text never says clear/safe [M13, R1]`, async () => {
    const r = await runXray(fakeNode({ probe, noSellRoute: true }).transport, IN);
    assert.equal(r.rung, rung); assert.equal(r.verdict, 'WARN');
    assert.equal(r.instruments.find((i) => i.name === 'sim')!.status, 'NOT_MEASURED');
    assert.ok(r.notMeasured.includes('sim'));
    assert.doesNotMatch(r.text, UNSAFE); assert.doesNotMatch(r.text, /^MEASURED/);
  });
}

// Provider limits (429, code 12, unavailable) reach the report as a scan that did not run: NOT_MEASURED.
const CTX = { X: '0x' + '22'.repeat(20), N: 100, fee: { gasPrice: 7n } };
const noScan = (why: string) => buildReport({ chainId: 8453, block: { number: 1, hash: '0x' + 'aa'.repeat(32), timestamp: 1n }, target: '0x' + '44'.repeat(20),
  amountIn: 10n ** 15n, maxTaxBps: 100, ctx: CTX, scan: { tier: null, rung: null, status: 'NOT_MEASURED', why } });
for (const why of ['provider unavailable: HTTP 429', 'provider unavailable: code 12 (limit)', 'provider unavailable', 'token has no code at the pinned block']) {
  test(`[c] scan not run (${why}): WARN, every instrument NOT_MEASURED, text never says clear/safe [R1]`, () => {
    const r = noScan(why);
    assert.equal(r.verdict, 'WARN');
    assert.deepEqual(r.notMeasured, ['sim', 'quoter', 'transfer']);
    for (const i of r.instruments) assert.equal(i.status, 'NOT_MEASURED', i.name);
    assert.ok(r.text.startsWith('WARN: '), r.text);
    assert.doesNotMatch(r.text, UNSAFE);
    assert.ok(r.text.includes(why));
  });
}
