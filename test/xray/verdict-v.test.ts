// Fresh-verifier false cleans (V-verif, 2026-11-20): every test asserts the expected verdict and was red at e10e351,
// except [V8], which pins the decision to drop the round-trip guard (green there on a half sale, red on its mutant).
// Rule: no path reaches MEASURED unless the sell tax was read; in doubt the result is NOT_MEASURED.
// Each test names the mutant that turns it red ([Vxx], xray-ship/mut.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { measure, instrumentVerdict, UM } from '../../src/xray/measure.js';
import { buildReport } from '../../src/xray/report.js';
import { TIER_UNCOVERED, TIER_LIMITS, toResult } from '../../src/xray/tiers.js';
import { xrayStart, XrayError } from '../../src/xray/index.js';

const OK = () => ({ ok: true, gas: 40_000n, revertData: '0x' });
/** Quoter netOut after the protocol fee, the fee rounded up (BlazePhoenixQuoter.sol:353): what the Router delivers. */
const afterFee = (gross: bigint) => gross - (gross * 28n + 9_999n) / 10_000n;
/** A pool price as [wei out, tokens in]: the quote for S tokens is S * wei / tokens, set by the scenario, never by the output. */
type Rate = readonly [bigint, bigint];
const price = (s: bigint, [w, t]: Rate) => (s * w) / t;
/** The clean vector's untaxed prices: 4986 tokens sold for 4990 wei, the later sale 4786 for 4700. */
const SELL: Rate = [4_990n, 4_986n], LATER: Rate = [4_700n, 4_786n];
/**
 * The V5 quantities at tier A/C: every quote with safetyBuffer 0, buyQuotedNet the pool output after the 28 bps fee,
 * each sale quoted at the pool price the scenario declares (never read from sellOut / sellLaterOut), and the token's own
 * balance and the pair's anchor balance still across the transfer to the pair.
 */
const quoted = (r: any, sell: Rate = SELL, later: Rate = LATER): any => {
  Object.assign(r, { buyQuotedNet: afterFee(r.buyPoolSent), buySafetyBuffer: 0n, sellSafetyBuffer: 0n,
    sellQuotedNet: price(r.sellIn, sell), poolTransferTokenSelfDelta: 0n, poolTransferPairAnchorDelta: 0n });
  if (r.sellLaterOut !== undefined) Object.assign(r, { sellLaterSafetyBuffer: 0n, sellLaterQuotedNet: price(r.sellLaterIn, later) });
  return r;
};
/** Clean Result: buy 10000 -> 9972 delivered, half sold (4986 -> 4990 wei out), untaxed transfers. */
const clean = (k = 1n): any => quoted({
  unmeasured: 0n,
  quoteBuy: OK(), buy: OK(), buyHops: 1n, buyIn: 10_000n * k, buyPoolSent: 10_000n * k, buyDelivered: 9_972n * k,
  quoteSell: OK(), sellHops: 1n, sell: OK(), sellIn: 4_986n * k, sellPoolReceived: 4_986n * k, sellOut: 4_990n * k, sellTokenSelfDelta: 0n,
  transfer: OK(), transferSent: 100n * k, transferReceived: 100n * k,
  poolTransfer: OK(), poolTransferSent: 100n * k, poolTransferReceived: 100n * k,
});
/** Tier A adds the later sale of the remainder at B+N. */
const cleanA = (k = 1n): any => quoted({ ...clean(k), tier: 'A', quoteLater: { ok: true }, sellLater: OK(),
  sellLaterIn: 4_786n * k, sellLaterPoolReceived: 4_786n * k, sellLaterOut: 4_700n * k, sellLaterTokenSelfDelta: 0n });
const CTX = { X: '0x' + '11'.repeat(20), N: 100, fee: { gasPrice: 1n } };
const rep = (result: any, tier = 'A', maxTaxBps: any = 100) => buildReport({ chainId: 8453, block: { number: 1, hash: '0x' + 'aa'.repeat(32), timestamp: 1n },
  target: '0x' + '44'.repeat(20), amountIn: 10n ** 15n, maxTaxBps, ctx: CTX,
  scan: { tier, rung: tier === 'A' ? 'A:d4' : tier, status: 'RAN', result, uncovered: TIER_UNCOVERED[tier], limits: (TIER_LIMITS as any)[tier] } });
const V = (r: any, maxTaxBps: any = 100) => instrumentVerdict(measure(r), { maxTaxBps });

test('[V0] controls: clean B and clean A with the later sale are MEASURED with exact values', () => {
  assert.equal(V(clean()).status, 'MEASURED');
  const a = measure(cleanA());
  assert.equal(a.sellLaterOk, true); assert.equal(a.sellLaterTaxSwapBps, 0n); assert.equal(a.sellLaterOut, 4_700n);
  assert.equal(instrumentVerdict(a, { maxTaxBps: 100 }).status, 'MEASURED');
  assert.equal(rep(cleanA(), 'A').verdict, 'MEASURED');
  assert.equal(rep(clean(), 'B').verdict, 'MEASURED');
});

// V1: tier B with balanceOf(Y) unreadable (UM_BAL_Y): the wallet tax is null, never a MEASURED transfer. [V1, V1r]
test('[V1] wallet transfer with an unmeasured receiver delta is NOT_MEASURED', () => {
  const r = clean(); r.unmeasured = UM.BAL_Y; r.transferReceived = 1n;
  const m = measure(r);
  assert.equal(m.transferOk, true); assert.equal(m.transferTaxBps, null);
  assert.equal(V(r).status, 'NOT_MEASURED');
  const out = rep(r, 'B');
  assert.notEqual(out.verdict, 'MEASURED');
  assert.equal(out.instruments.find((i) => i.name === 'transfer')!.status, 'NOT_MEASURED');
});

// V2: tier A runs a later sale at B+N (class b2: sells blocked after N blocks); the verdict reads it. [V2, V2t, V2r]
test('[V2] tier A: later sale reverted CONDEMNs', () => {
  const r = cleanA(); r.sellLater = { ok: false, gas: 60_000n, revertData: '0x08c379a0' };
  delete r.sellLaterIn; delete r.sellLaterOut; delete r.sellLaterPoolReceived;
  assert.equal(V(r).v, 'CONDEMN'); assert.equal(V(r).why, 'later sell reverted');
  assert.equal(rep(r, 'A').verdict, 'CONDEMN');
});
test('[V2] tier A: later sale with the pool receiving 50 of 4986 CONDEMNs on the later swap-side tax', () => {
  // The pool paid 1 wei for the 50 tokens it got: that price quotes the 4986 sold at 99 wei (economic tax 9899 <= 9900).
  const r = quoted(Object.assign(cleanA(), { sellLaterIn: 4_986n, sellLaterOut: 1n, sellLaterPoolReceived: 50n }), SELL, [1n, 50n]);
  assert.equal(r.sellLaterQuotedNet, 99n);
  assert.equal(measure(r).sellLaterTaxSwapBps, 9_900n);
  assert.equal(V(r).v, 'CONDEMN');
});
test('[V2] tier A: later sale delivering 0 wei CONDEMNs', () => {
  const r = cleanA(); r.sellLaterOut = 0n;
  assert.equal(V(r).why, 'later sell delivered 0 wei');
});
test('[V2] tier A: later sale not run or not measured is NOT_MEASURED, never MEASURED', () => {
  for (const f of [(r: any) => { delete r.sellLater; }, (r: any) => { r.sellLater = { ok: false, ran: false, gas: null, revertData: '0x' }; },
    (r: any) => { delete r.sellLaterPoolReceived; }, (r: any) => { delete r.sellLaterOut; }, (r: any) => { r.quoteLater = { ok: false }; delete r.sellLater; }]) {
    const r = cleanA(); f(r);
    assert.equal(V(r).status, 'NOT_MEASURED');
    assert.notEqual(rep(r, 'A').verdict, 'MEASURED');
  }
  // The scan's tier decides, not a field of the Result.
  const r = cleanA(); delete r.tier; delete r.sellLater;
  assert.notEqual(rep(r, 'A').verdict, 'MEASURED');
});
test('[V2] toResult: an unreadable pool balance around the later sale leaves the later pool delta unmeasured', () => {
  const u = (v: bigint) => ({ ok: true, gas: null, ret: '0x' + v.toString(16).padStart(64, '0') });
  const bad = { ok: false, ret: '0x' };
  const m: any = { sellLater: { ok: true, gas: 1n, ret: '0x' }, 'lateA:x': u(1000n), 'lateA:w': u(0n), 'lateA:s': u(0n), 'lateA:p0': bad,
    'lateB:x': u(0n), 'lateB:w': u(990n), 'lateB:s': u(0n), 'lateB:p0': u(1000n) };
  const r = toResult({}, {}, m, 'A');
  assert.equal(r.sellLaterIn, 1000n); assert.equal(r.sellLaterPoolReceived, undefined);
});

// V3: swapback (token contract balance fell during the sale) or the token's own balance unreadable: the pool delta
// is not the seller's tax, so the swap-side sell tax is null. [V3, V3b]
test('[V3] swapback (sellTokenSelfDelta < 0) leaves the swap-side sell tax unmeasured', () => {
  const r = clean(); Object.assign(r, { sellPoolReceived: 5_493n, sellTokenSelfDelta: -507n, sellOut: 2_450n });
  assert.equal(measure(r).sellTaxSwapBps, null);
  // V5: the same-state quote for the 4986 sold (4990) is still read; the seller got 2450, an anchor-side loss of
  // ceil(2540 * 10000 / 4990) = 5091 bps, which CONDEMNs (more conservative than the token-side NOT_MEASURED).
  assert.deepEqual(V(r), { v: 'CONDEMN', status: 'CONDEMN', why: 'sellEconBps 5091 >= 100' });
  delete r.sellQuotedNet;
  assert.equal(V(r).status, 'NOT_MEASURED');
});
test('[V3b] token self balance unmeasured (UM.SELF) or absent leaves the swap-side sell tax unmeasured', () => {
  const r = clean(); r.unmeasured = UM.SELF; r.sellPoolReceived = 5_493n;
  assert.equal(measure(r).sellTaxSwapBps, null);
  assert.equal(V(r).status, 'NOT_MEASURED');
  const r2 = clean(); delete r2.sellTokenSelfDelta;
  assert.equal(V(r2).status, 'NOT_MEASURED');
});

// V4/V9: maxTaxBps is an integer in [1, 10000]; anything else is refused, never read as a threshold. [V4, V4i]
test('[V4] maxTaxBps outside [1, 10000] or not an integer is refused', () => {
  for (const t of [10_001, 1e30, 0, -1, NaN, 1.5, '100', '0x64', true, false, null, 10_001n, 0n]) {
    assert.throws(() => V(clean(), t), RangeError, `instrumentVerdict ${String(t)}`);
    let c = 'no throw';
    try { xrayStart({ chainId: 8453, token: '0x' + '44'.repeat(20), amountIn: 1n, maxTaxBps: t as any }); } catch (e) { c = e instanceof XrayError ? e.code : String(e); }
    assert.equal(c, 'bad_input', `xrayStart ${String(t)}`);
  }
  for (const t of [1, 10_000, 1n, 10_000n]) assert.doesNotThrow(() => V(clean(), t));
});
test('[V4b] report text names the threshold', () => {
  assert.match(rep(clean(), 'A', 100).text, /maxTaxBps 100\b/);
});

// V5: the report carries what the tier cannot cover and its limits, in the fields and in the text. [V5]
test('[V5] tier B and C reports carry uncovered and limits', () => {
  for (const tier of ['B', 'C']) {
    const out: any = rep(clean(), tier);
    assert.deepEqual(out.uncovered, TIER_UNCOVERED[tier]); assert.deepEqual(out.limits, (TIER_LIMITS as any)[tier]);
    assert.match(out.text, new RegExp(`not covered at tier ${tier}: ${TIER_UNCOVERED[tier].join(', ')}`));
  }
});

// V6: WETH or the seller's token balance unreadable: sellOut is not measured, so it is NOT_MEASURED, never "0 wei". [V6]
test('[V6] sellOut with WETH or BAL_X unmeasured is NOT_MEASURED, not CONDEMN', () => {
  for (const u of [UM.WETH, UM.BAL_X]) {
    const r = clean(); r.unmeasured = u; r.sellOut = 0n;
    assert.equal(measure(r).sellOut, null);
    assert.equal(V(r).status, 'NOT_MEASURED');
  }
});

// V7: a transfer that ran and reverted with empty data is a revert, whatever the sent amount. [V7]
test('[V7] pool transfer reverted with empty data CONDEMNs; wallet transfer reverted with empty data WARNs', () => {
  const r = clean(); r.poolTransfer = { ok: false, gas: 30_000n, revertData: '0x' }; r.poolTransferSent = 0n; r.poolTransferReceived = 0n;
  assert.equal(V(r).why, 'transfer to the pool reverted');
  const w = clean(); w.transfer = { ok: false, gas: 30_000n, revertData: '0x' }; w.transferSent = 0n; w.transferReceived = 0n;
  assert.equal(V(w).why, 'wallet transfer reverted');
});

// V8 (decision 2026-11-20): no round-trip guard. ETH out vs ETH in mixes the pool fees and price impact with the
// tax, and the sell tax is read directly (V2, V3), so roundTripLossBps is null and never moves the verdict. [V8]
test('[V8] no round-trip guard: roundTripLossBps is null at every scale and an ETH-only loss leaves the verdict', () => {
  const r = clean();
  assert.equal(measure(r).roundTripLossBps, null);
  assert.equal(V(r).status, 'MEASURED');
  // Loss in WETH only: the pool's price is 1 wei for the 4986 sold, and the same-state quote prices that too. Token deltas clean: not a tax reading.
  r.sellOut = 1n; quoted(r, [1n, 4_986n]); assert.equal(r.sellQuotedNet, 1n);
  assert.equal(measure(r).roundTripLossBps, null);
  assert.equal(V(r).status, 'MEASURED');
  for (const k of [1n, 10n ** 6n, 10n ** 18n]) assert.equal(measure(clean(k)).roundTripLossBps, null, `k=${k}`);
});

// M4: the wallet-transfer guard stays even though a null transferTaxBps also stops the verdict (V1): a Measure
// with the transfer not run is NOT_MEASURED by that guard, whatever tax value it carries. [M4]
test('[M4] wallet transfer not run is NOT_MEASURED by its own guard, even with a transfer tax present', () => {
  for (const ok of [null, undefined] as const) {
    const m = { ...measure(clean()), transferOk: ok as any, transferTaxBps: 0n };
    const v = instrumentVerdict(m, { maxTaxBps: 100 });
    assert.equal(v.status, 'NOT_MEASURED'); assert.equal(v.why, 'wallet transfer not measured');
  }
});
