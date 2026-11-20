// V5 on a constant-product pair (2026-11-20). The fake's curve mode quotes as the deployed Quoter 1.0.0 does (Base
// 0x4cEF0615614B212895F45Aa1D4833B16666E18d3, BlazePhoenixQuoter.sol:163-165, :184-185: the 28 bps protocol fee and the
// safety buffer both rounded down) and executes as the Router 1.0.0 does (Base 0x2a779f9Be49aac57495A8B6467Cc325a8a47Eb9f,
// BlazePhoenixRouter.sol:410-422: fee = floor(min(received, quoted gross) * 28 / 1e4) on the output; :546-583: a
// fee-on-transfer token is priced on balance - reserve) on x*y=k with a 30 bps pair fee, reserves following every swap.
// The oracle below is the test's own: its own getAmountOut, fee and tax arithmetic, never a function of src/.
// Gamut: token tax 0 / 300 bps on rungs A:d4 (with the later sale) and C; safety buffer 0 / 1 bps; tier B boundary
// x + 10 vs maxTaxBps at maxTaxBps 11 / 500 / 1000 / 10000 on the buy and on the sale.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runXray } from '../../src/xray/index.js';
import { measure, instrumentVerdict } from '../../src/xray/measure.js';
import { fakeNode, TOKEN } from './fake.js';

const BPS = 10_000n;
const RT = 10n ** 21n, RW = 10n ** 18n, BUY_IN = 10n ** 15n; // the fake's curve reserves (token, WETH) and the buy size
const IN = { chainId: 8453, token: TOKEN, amountIn: BUY_IN, maxTaxBps: 500 };
const down = { error: { code: -32601, message: 'the method eth_simulateV1 does not exist/is not available' } };
const refused = { error: { code: -32602, message: 'state override refused' } };
const RUNGS: Record<string, any> = { 'A:d4': {}, C: { 'A:d4': down, 'A:d2': down, B: refused } };

// ---- oracle (independent of src/)
const getAmountOut = (i: bigint, rIn: bigint, rOut: bigint) => (i * 997n * rOut) / (rIn * 1000n + i * 997n);
const up = (n: bigint, d: bigint) => (n + d - 1n) / d; // n >= 0
const afterFee = (v: bigint, gross: bigint) => v - ((v < gross ? v : gross) * 28n) / BPS; // Router 1.0.0, rounded down
const quoted = (gross: bigint, sBps: bigint) => { const a = gross - (gross * 28n) / BPS, b = (a * sBps) / BPS; return a > b ? a - b : 0n; };
const taxed = (v: bigint, t: bigint) => v - (v * t) / BPS;
const loss = (got: bigint, sent: bigint) => up(BPS * (sent - got), sent); // got <= sent here
const max = (a: bigint, b: bigint) => (a > b ? a : b);
function oracle(t: bigint, laterSale: boolean) {
  let rt = RT, rw = RW;
  const P = getAmountOut(BUY_IN, rw, rt), D = afterFee(taxed(P, t), P), Qb = quoted(P, 0n); rt -= P; rw += BUY_IN;
  const net = P - (P * 28n) / BPS, buyTax = up(BPS * (net - D), net), buyEcon = loss(D, Qb);
  const S = (D * 5_000n) / BPS, got = taxed(S, t), out = getAmountOut(got, rt, rw), gS = getAmountOut(S, rt, rw);
  const sellOut = afterFee(out, gS), Qs = quoted(gS, 0n);
  rt += got; rw -= out;
  const swap = loss(got, S), sellEcon = loss(sellOut, Qs);
  const left = D - S, tA = (left * 1_000n) / BPS, pA = (left * 1_000n) / BPS, rem = left - tA - pA;
  const o: Record<string, bigint | null> = { buyTaxBps: max(buyTax, buyEcon), buyEconBps: buyEcon, sellTaxSwapBps: max(swap, sellEcon), sellEconBps: sellEcon,
    sellOut, transferTaxBps: loss(taxed(tA, t), tA), sellTaxBps: loss(taxed(pA, t), pA), quoteBufferBps: 0n,
    sellLaterTaxSwapBps: null, sellLaterEconBps: null, sellLaterOut: null };
  let status = 'MEASURED', overCredit = false;
  if (laterSale) {
    // The transfer to the pair left taxed(pA) above the reserve. A plain token is priced on the amount and the excess
    // stays out; a fee-on-transfer token is priced on balance - reserve, so the later sale takes that excess too, gets
    // more than its quote and is an over-credit: NOT_MEASURED (conservative, TIER_LIMITS 'A').
    const g2 = taxed(rem, t), realIn = t === 0n ? rem : g2 + taxed(pA, t), gL = getAmountOut(rem, rt, rw);
    const lo = afterFee(getAmountOut(realIn, rt, rw), gL), Ql = quoted(gL, 0n);
    if (lo > Ql) { status = 'NOT_MEASURED'; overCredit = true; }
    const e = lo > Ql ? null : loss(lo, Ql);
    Object.assign(o, { sellLaterTaxSwapBps: e === null ? loss(g2, rem) : max(loss(g2, rem), e), sellLaterEconBps: e, sellLaterOut: lo });
  }
  return { o, status, overCredit };
}
const sim = (r: any) => r.instruments.find((i: any) => i.name === 'sim');
const show = (r: any) => { const s = sim(r), v = s.values; return `${r.verdict} ${r.rung} sim=${s.status}(${s.reason}) buy=${v.buyTaxBps}/${v.buyEconBps} swap=${v.sellTaxSwapBps}/${v.sellEconBps} pt=${v.sellTaxBps} tr=${v.transferTaxBps} later=${v.sellLaterTaxSwapBps}/${v.sellLaterEconBps} hidden=${v.hiddenTax}`; };

// Mutants that turn these red: the fake quoting fee-less (hiddenTax, NOT_MEASURED); anchorStill() or selfStill() on the
// transfer to the pair returning false (sellTaxBps null, NOT_MEASURED); economics() reading a non-zero buffer as 0 is
// caught below; ROUND_BPS 0 does not matter here (econ <= token-side on a concave pair).
for (const [rung, probe] of Object.entries(RUNGS)) {
  for (const t of [0n, 300n]) test(`[V5-curve] ${rung} x*y=k, token tax ${t} bps, buffer 0: exact values, MEASURED unless the later sale is over-credited`, async () => {
    const r: any = await runXray(fakeNode({ probe, taxBps: t, curve: {} }).transport, IN);
    console.log(`V5-curve ${rung} t=${t}: ${show(r)}`);
    assert.equal(r.rung, rung);
    const v = sim(r).values, { o: want, status, overCredit } = oracle(t, rung === 'A:d4');
    assert.equal(sim(r).status, status, sim(r).reason); assert.equal(r.verdict, status === 'MEASURED' ? 'MEASURED' : 'WARN');
    if (overCredit) assert.equal(sim(r).reason, 'receiver credited more than sent');
    for (const [k, x] of Object.entries(want)) assert.equal(v[k], x, k);
    assert.equal(v.hiddenTax, false); assert.equal(v.overCredit, overCredit);
  });
}

// F1: a quote with a safety buffer under-states the output, so at A/C a non-zero buffer is never MEASURED.
// Mutant: economics() accepting any buffer (quoteBufferBps = 0n at A/C) -> MEASURED (red on the 300 bps rows).
// At tax 0 the buffer also makes the economic reading negative (delivered > quoted): NOT_MEASURED by the negative backstop.
for (const [rung, probe] of Object.entries(RUNGS)) {
  test(`[V5-curve-buffer] ${rung} x*y=k, token tax 300 bps, safety buffer 1 bps: NOT_MEASURED (buffer)`, async () => {
    const r: any = await runXray(fakeNode({ probe, taxBps: 300n, curve: { safetyBps: 1n } }).transport, IN);
    console.log(`V5-curve-buffer ${rung}: ${show(r)}`);
    assert.equal(r.rung, rung); assert.equal(sim(r).status, 'NOT_MEASURED');
    // A:d4: the later sale's over-credit (see the oracle) is reported first, so only rung C pins the buffer reason.
    assert.equal(sim(r).reason, rung === 'C' ? 'quote safety buffer not 0' : 'receiver credited more than sent');
    assert.equal(sim(r).values.quoteBufferBps, null);
  });
  test(`[V5-curve-buffer] ${rung} x*y=k, token tax 0, safety buffer 1 bps: NOT_MEASURED`, async () => {
    const r: any = await runXray(fakeNode({ probe, taxBps: 0n, curve: { safetyBps: 1n } }).transport, IN);
    console.log(`V5-curve-buffer0 ${rung}: ${show(r)}`);
    assert.equal(r.rung, rung); assert.equal(sim(r).status, 'NOT_MEASURED');
    assert.equal(sim(r).values.quoteBufferBps, null);
  });
}

// Owner decision 2 (tier B): MEASURED needs x + 10 < maxTaxBps; x + 10 >= maxTaxBps is NOT_MEASURED; x >= maxTaxBps CONDEMNs.
// Probe Result with the quotes net of the fee (as the Quoter), x on the buy or on the sale, every economic reading = x.
// Mutants: `>=` -> `>` in the buffer check (row max-10 MEASURED); quoteBufferBps 0 at B (row max-10 MEASURED);
// `x >= maxTaxBps` -> `>` in the CONDEMN loop (row max not CONDEMN).
const OK = () => ({ ok: true, gas: 40_000n, revertData: '0x' });
const P = 10n ** 18n, S = 4_986n * 10n ** 14n, QS = 4_986n * 10n ** 11n;
const resB = (side: 'buy' | 'sell', x: bigint): any => ({ tier: 'B', unmeasured: 0n, quoteBuy: OK(), buy: OK(), buyHops: 1n, buyIn: 10n ** 15n,
  buyPoolSent: P, buyDelivered: side === 'buy' ? (P * (BPS - x) * 9_972n) / (BPS * BPS) : 9_972n * 10n ** 14n, buyQuotedNet: 9_972n * 10n ** 14n,
  quoteSell: OK(), sellHops: 1n, sell: OK(), sellIn: S, sellPoolReceived: side === 'sell' ? S - (S * x) / BPS : S,
  sellOut: side === 'sell' ? QS - (QS * x) / BPS : QS, sellQuotedNet: QS, sellTokenSelfDelta: 0n,
  transfer: OK(), transferSent: 10n ** 16n, transferReceived: 10n ** 16n, poolTransfer: OK(), poolTransferSent: 10n ** 16n, poolTransferReceived: 10n ** 16n });
for (const mx of [11n, 500n, 1_000n, 10_000n]) {
  for (const side of ['buy', 'sell'] as const) {
    const k = side === 'buy' ? 'buyTaxBps' : 'sellTaxSwapBps';
    for (const [x, want] of [[mx - 11n, 'MEASURED'], [mx - 10n, 'NOT_MEASURED'], [mx, 'CONDEMN']] as const) {
      test(`[V5-B-edge] tier B, ${k} ${x} vs maxTaxBps ${mx} (x + 10 ${x + 10n < mx ? '<' : '>='} max): ${want}`, () => {
        const m = measure(resB(side, x), { tier: 'B' }); const v = instrumentVerdict(m, { maxTaxBps: mx });
        assert.equal(m[k], x, k); assert.equal(m.quoteBufferBps, 10n); assert.equal(m.sellTaxBps, null);
        assert.equal(v.status, want, v.why);
        if (want === 'NOT_MEASURED') assert.equal(v.why, `${k} ${x} + quote buffer 10 >= ${mx}`);
        if (want === 'CONDEMN' && x < BPS) assert.equal(v.why, `${k} ${x} >= ${mx}`);
      });
    }
  }
}
