// VERIF-5L test gaps (2026-11-20): guards no test could fail at e1c6390. Each test is green there and red under the
// named mutant (mut.mjs ids 5l-M9b, 5l-M10, 5l-M21).
import test from 'node:test';
import assert from 'node:assert/strict';
import { measure, instrumentVerdict } from '../../src/xray/measure.js';
const OK = () => ({ ok: true, gas: 40_000n, revertData: '0x' });
const Q = 4_986n * 10n ** 11n, IN = 4_986n * 10n ** 14n, S = 10n ** 16n;
const resC = (o: any = {}): any => ({ tier: 'C', unmeasured: 0n, quoteBuy: OK(), buy: OK(), buyHops: 1n, buyIn: 10n ** 15n, buyPoolSent: 10n ** 18n,
  buyDelivered: 9_972n * 10n ** 14n, buyQuotedNet: 9_972n * 10n ** 14n, quoteSell: OK(), sellHops: 1n, sell: OK(), sellIn: IN,
  sellPoolReceived: IN, sellOut: Q, sellQuotedNet: Q, sellTokenSelfDelta: 0n, transfer: OK(), transferSent: S, transferReceived: S,
  poolTransfer: OK(), poolTransferSent: S, poolTransferReceived: S, buySafetyBuffer: 0n, sellSafetyBuffer: 0n,
  poolTransferTokenSelfDelta: 0n, poolTransferPairAnchorDelta: 0n, ...o });
const resA = (o: any = {}): any => resC({ tier: 'A', quoteLater: { ok: true }, sellLater: OK(), sellLaterIn: IN, sellLaterPoolReceived: IN,
  sellLaterOut: Q, sellLaterQuotedNet: Q, sellLaterTokenSelfDelta: 0n, sellLaterSafetyBuffer: 0n, ...o });
const V = (r: any, max = 1000) => { const m = measure(r, { tier: r.tier }); return { m, v: instrumentVerdict(m, { maxTaxBps: max }) }; };

// Mutant M9b (measure.ts anchorStill: absent -> true): MEASURED.
for (const tier of ['A', 'C'] as const) test(`[VERIF-anchor-absent] tier ${tier}: pair anchor delta unread is NOT_MEASURED, never MEASURED`, () => {
  const mk = tier === 'A' ? resA : resC;
  assert.equal(V(mk()).v.status, 'MEASURED');
  for (const a of [undefined, null]) {
    const { m, v } = V(mk({ poolTransferPairAnchorDelta: a }));
    assert.equal(m.sellTaxBps, null); assert.equal(v.status, 'NOT_MEASURED'); assert.equal(v.why, 'a tax was not measured');
  }
});
// Mutant M10 (later sale floor(x) removed): NOT_MEASURED instead of CONDEMN. Later pool credited 50 % of what was sold
// while the token's own balance fell (swapback): the tax is not identifiable, its lower bound 5000 >= 1000 condemns.
test('[VERIF-later-floor] tier A: later pool delta 50 % with a self swapback is CONDEMN by the floor', () => {
  const { m, v } = V(resA({ sellLaterPoolReceived: IN / 2n, sellLaterTokenSelfDelta: -1n }));
  assert.equal(m.sellLaterTaxSwapBps, null); assert.equal(m.taxFloorBps, 5000n);
  assert.equal(v.status, 'CONDEMN'); assert.equal(v.why, 'taxFloorBps 5000 >= 1000');
});
// Mutant M21 (selfFloor ceil -> floor): 999.5 bps on top of the transfer to the pair rounds up to 1000 = max -> CONDEMN.
test('[VERIF-selffloor-ceil] tier C: self rise of 999.5 bps on the transfer to the pair floors at 1000 (rounded up)', () => {
  const { m, v } = V(resC({ poolTransferTokenSelfDelta: (S * 9_995n) / 100_000n }));
  assert.equal(m.taxFloorBps, 1000n); assert.equal(v.status, 'CONDEMN');
});
