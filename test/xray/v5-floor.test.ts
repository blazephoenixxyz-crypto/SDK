// V5 lower-bound floor and wei over-credit rules, at the Result level. Oracle written here: the floor is
// ceil(10000 * lost / sent) of the transfer to the pair, compared with maxTaxBps; any reading where the receiver
// got 1 wei more than sent or quoted is NOT_MEASURED 'receiver credited more than sent', never MEASURED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measure, instrumentVerdict } from '../../src/xray/measure.js';
const BPS = 10_000n;
const OK = () => ({ ok: true, gas: 40_000n, revertData: '0x' });
const S = 10n ** 16n, Q = 4_986n * 10n ** 11n, IN = 4_986n * 10n ** 14n, NET = 9_972n * 10n ** 14n;
// tier B, everything clean, quotes = delivery (same vector as v5-swapback resB)
const resB = (o: any = {}): any => ({ tier: 'B', unmeasured: 0n, quoteBuy: OK(), buy: OK(), buyHops: 1n, buyIn: 10n ** 15n, buyPoolSent: 10n ** 18n,
  buyDelivered: NET, buyQuotedNet: NET, quoteSell: OK(), sellHops: 1n, sell: OK(), sellIn: IN,
  sellPoolReceived: IN, sellOut: Q, sellQuotedNet: Q, sellTokenSelfDelta: 0n,
  transfer: OK(), transferSent: S, transferReceived: S, poolTransfer: OK(), poolTransferSent: S, poolTransferReceived: S, ...o });
// tier C: buffers read 0, the pair transfer's token self delta and pair anchor delta read and still
const resC = (o: any = {}): any => resB({ tier: 'C', buySafetyBuffer: 0n, sellSafetyBuffer: 0n, poolTransferTokenSelfDelta: 0n, poolTransferPairAnchorDelta: 0n, ...o });
// tier A: tier C plus the later sale, clean
const resA = (o: any = {}): any => resC({ tier: 'A', quoteLater: { ok: true }, sellLater: OK(), sellLaterIn: IN, sellLaterPoolReceived: IN,
  sellLaterOut: Q, sellLaterQuotedNet: Q, sellLaterTokenSelfDelta: 0n, sellLaterSafetyBuffer: 0n, ...o });
const V = (r: any, max = 1000) => { const m = measure(r, { tier: r.tier }); return { m, v: instrumentVerdict(m, { maxTaxBps: max }) }; };
const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
const OVER = 'receiver credited more than sent';

test('[V5-floor ctl] tiers A, B and C clean vectors are MEASURED', () => {
  for (const r of [resA(), resB(), resC()]) assert.equal(V(r).v.status, 'MEASURED', r.tier);
});

// Q4-a. Mutant 5i-F1 (floor(x) of the transfer to the pair removed): MEASURED at B.
test('[Q4-a] tier B: 99% tax on a plain transfer to the pair (router sale exempt) is CONDEMN by the floor', () => {
  const got = S / 100n, want = ceil(BPS * (S - got), S);
  const { m, v } = V(resB({ poolTransferReceived: got }));
  assert.equal(want, 9_900n); assert.equal(m.taxFloorBps, want);
  assert.equal(v.status, 'CONDEMN'); assert.equal(v.why, `taxFloorBps ${want} >= 1000`);
});

// Q4-b. Fee taken from the amount and kept by the token: the pair delta alone already floors at 9900.
test('[Q4-b] tier C: 99% transfer-to-pair tax kept by the token (self +fee) is CONDEMN by the floor', () => {
  const fee = (S * 9_900n) / BPS;
  const { m, v } = V(resC({ poolTransferReceived: S - fee, poolTransferTokenSelfDelta: fee }));
  assert.equal(m.sellTaxBps, null); assert.equal(m.taxFloorBps, 9_900n);
  assert.equal(v.status, 'CONDEMN'); assert.equal(v.why, 'taxFloorBps 9900 >= 1000');
});

// Q4-b2. Fee charged on top: the pair gets the full amount, the token keeps fee more from the sender. Only the token's
// own balance shows it. Mutant 5i-F2 (selfFloor of the transfer to the pair removed): NOT_MEASURED, never CONDEMN.
for (const [feeBps, want] of [[9_900n, 'CONDEMN'], [1_000n, 'CONDEMN'], [999n, 'NOT_MEASURED'], [1n, 'NOT_MEASURED']] as const) {
  test(`[Q4-b2] tier C: ${feeBps} bps fee on top of the transfer to the pair, pair credited in full: ${want}`, () => {
    const fee = (S * feeBps) / BPS;
    const { m, v } = V(resC({ poolTransferTokenSelfDelta: fee }));
    assert.equal(m.taxFloorBps, ceil(BPS * fee, S)); assert.equal(m.sellTaxBps, null);
    assert.equal(v.status, want, v.why);
    if (want === 'CONDEMN') assert.equal(v.why, `taxFloorBps ${feeBps} >= 1000`);
  });
}

// Q1-c. Buyer credited 1 wei above pool-sent net of the fee; the quote matches the delivery, so only the buy rule sees it.
// Mutant 5i-B1 (buy `if (D > net)` -> `if (false)`): MEASURED.
test('[Q1-c] tier C: buy delivered 1 wei above pool-sent net of fee is NOT_MEASURED, never MEASURED', () => {
  const { m, v } = V(resC({ buyDelivered: NET + 1n, buyQuotedNet: NET + 1n }));
  assert.equal(m.overCredit, true); assert.equal(m.buyTaxBps, null);
  assert.equal(v.status, 'NOT_MEASURED'); assert.equal(v.why, OVER);
});

// Q1-d. Sale delivered 1 wei more than a 0-buffer quote. Mutant 5i-E1 (sell econ via lossBps, no wei rule): MEASURED.
test('[Q1-d] tier C: sellOut 1 wei above a 0-buffer quote is NOT_MEASURED, never MEASURED', () => {
  const { m, v } = V(resC({ sellOut: Q + 1n }));
  assert.equal(m.sellEconBps, null); assert.equal(m.overCredit, true);
  assert.equal(v.status, 'NOT_MEASURED'); assert.equal(v.why, OVER);
});

// Later sale +1 wei (tier A). Out above the quote: mutant 5i-E2 (later econ via lossBps) -> MEASURED.
// Pool credited above what was sold: mutant X3l (later sale bypasses tax()) -> MEASURED.
test('[V5-later+1] tier A: later sellOut 1 wei above its quote is NOT_MEASURED', () => {
  const { m, v } = V(resA({ sellLaterOut: Q + 1n }));
  assert.equal(m.sellLaterEconBps, null); assert.equal(m.overCredit, true);
  assert.equal(v.status, 'NOT_MEASURED'); assert.equal(v.why, OVER);
});
test('[V5-later+1] tier A: later pool credited 1 wei above the amount sold is NOT_MEASURED', () => {
  const { m, v } = V(resA({ sellLaterPoolReceived: IN + 1n }));
  assert.equal(m.sellLaterTaxSwapBps, null); assert.equal(m.overCredit, true);
  assert.equal(v.status, 'NOT_MEASURED'); assert.equal(v.why, OVER);
});
