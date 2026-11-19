// Offline ports of the verdict/measure tests proposed in X2-classes §4 (forge originals): quoteOnlyNeverMeasured,
// sellFeeByPairDelta and the report side of gasPriceNonZero. The fork halves (pinned blocks, live tokens) are not
// portable offline. Each test names the mutant that turns it red ([Mxx]/[Rx], xray-ship/mut.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { measure, instrumentVerdict } from '../../src/xray/measure.js';
import { combine } from '../../src/xray/lattice.js';
import { buildReport } from '../../src/xray/report.js';

const OK = () => ({ ok: true, gas: 40_000n, revertData: '0x' });
/** Clean Result at scale k (buy tax 0, partial sell of 10000k out of 19944k delivered, untaxed transfers). */
const clean = (k = 1n): any => ({
  unmeasured: 0n,
  quoteBuy: OK(), buy: OK(), buyHops: 1n, buyIn: 20_000n * k, buyPoolSent: 20_000n * k, buyDelivered: 19_944n * k, buyQuotedNet: 20_000n * k,
  quoteSell: OK(), sellHops: 1n, sell: OK(), sellIn: 10_000n * k, sellPoolReceived: 10_000n * k, sellOut: 9_900n * k, sellQuotedNet: 9_900n * k,
  sellTokenSelfDelta: 0n, transfer: OK(), transferSent: 100n * k, transferReceived: 100n * k,
  poolTransfer: OK(), poolTransferSent: 100n * k, poolTransferReceived: 100n * k,
});
const SCALES = [1n, 10n ** 14n, 10n ** 18n];
const CTX = { X: '0x' + '22'.repeat(20), N: 100, fee: { gasPrice: 7n } };
const rep = (result: any, amountIn: bigint, tier = 'A') => buildReport({ chainId: 8453, block: { number: 1, hash: '0x' + 'aa'.repeat(32), timestamp: 1n },
  target: '0x' + '44'.repeat(20), amountIn, maxTaxBps: 1000, ctx: CTX, scan: { tier, rung: tier === 'A' ? 'A:d4' : tier, status: 'RAN', result } });

// quoteOnlyNeverMeasured (x2): the Quoter priced both legs but the own simulation did not run the buy.
// A quote is not a measurement: the verdict is never MEASURED from previewPlan's netOut.
for (const amountIn of [1n, 10n ** 18n, 10n ** 21n]) {
  test(`[x2] quoteOnlyNeverMeasured at amountIn ${amountIn}: quoter MEASURED, sim NOT_MEASURED, verdict WARN [R3]`, () => {
    const r = clean(amountIn); r.buy = { ok: false, gas: 0n, revertData: '0x' };
    const out = rep(r, amountIn);
    assert.equal(out.instruments.find((i) => i.name === 'quoter')!.status, 'MEASURED');
    assert.equal(out.instruments.find((i) => i.name === 'sim')!.status, 'NOT_MEASURED');
    assert.equal(out.verdict, 'WARN');
    assert.ok(out.notMeasured.includes('sim'));
  });
}
test('[x2] quoteOnlyNeverMeasured in the lattice: the Quoter alone or with the transfer is at most WARN [L4]', () => {
  assert.equal(combine({ quoter: 'MEASURED' }), 'WARN');
  assert.equal(combine({ quoter: 'MEASURED', transfer: 'MEASURED' }), 'WARN');
});

// sellFeeByPairDelta (d5): the fee is charged only on the sale to the pair; wallet and pool transfers are
// untaxed. The sell tax is the pair's balance delta, exact, and the >= predicate holds at +-1 bps.
for (const k of SCALES) {
  for (const t of [0n, 300n, 500n, 999n, 1000n, 1001n, 1440n]) {
    const want = t >= 1000n ? 'CONDEMN' : 'MEASURED';
    test(`[x2] sellFeeByPairDelta at scale ${k}, pair-only fee ${t} bps vs maxTaxBps 1000: sellTaxSwapBps exact, ${want} [M2, M15]`, () => {
      const r = clean(k); r.sellPoolReceived = (10_000n - t) * k;
      const m = measure(r);
      assert.equal(m.sellTaxSwapBps, t); assert.equal(m.transferTaxBps, 0n); assert.equal(m.sellTaxBps, 0n); assert.equal(m.buyTaxBps, 0n);
      const v = instrumentVerdict(m, { maxTaxBps: 1000 });
      assert.equal(v.v, want);
      if (want === 'CONDEMN') assert.equal(v.why, `sellTaxSwapBps ${t} >= 1000`);
    });
  }
}

// gasPriceNonZero (a2), report side: the conditions carry the gas price used and the sender on every tier
// (the eth_call side is pinned in mt.test.ts). Tier C reads Multicall3 as the sender (origin with code).
for (const tier of ['A', 'B', 'C']) {
  test(`[x2] gasPriceNonZero: tier ${tier} report carries gasPrice 7 and the sender [R4]`, () => {
    const out = rep(clean(), 10n ** 15n, tier);
    for (const i of out.instruments) {
      assert.equal(i.conditions.gasPrice, 7n, i.name);
      assert.equal(i.conditions.sender, tier === 'C' ? '0xcA11bde05977b3631167028862bE2a173976CA11' : CTX.X, i.name);
    }
  });
}
