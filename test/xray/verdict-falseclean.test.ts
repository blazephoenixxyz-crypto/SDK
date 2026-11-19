// Lesson (a), false clean: no path reaches MEASURED with a sell tax that was not measured or that is at or
// above the threshold, and the lattice infimum does not depend on order (V-X1 C2-a, C2-b, C2-f).
// Vectors are synthetic probe Results with every other quantity clean, so each test isolates one input.
// Each test names the mutant that turns it red ([Mxx], xray-ship/mut.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { measure, instrumentVerdict, UM, type Measure } from '../../src/xray/measure.js';
import { meet, combine } from '../../src/xray/lattice.js';
import { tierVerdict } from '../../src/xray/tiers.js';

const OK = () => ({ ok: true, gas: 40_000n, revertData: '0x' });
/**
 * A clean Result at scale k: buy tax 0 (D = P * (1 - 28 bps)), half of the bought amount sold with no swap-side
 * tax (partial sell, so the round trip is not measured, as in the real probe: sellFracBps 5000), wallet and pool
 * transfers untaxed. MEASURED at any maxTaxBps > 0.
 */
const clean = (k = 1n): any => ({
  unmeasured: 0n,
  quoteBuy: OK(), buy: OK(), buyHops: 1n, buyIn: 10_000n * k, buyPoolSent: 10_000n * k, buyDelivered: 9_972n * k,
  quoteSell: OK(), sellHops: 1n, sell: OK(), sellIn: 4_986n * k, sellPoolReceived: 4_986n * k, sellOut: 4_900n * k, sellTokenSelfDelta: 0n,
  transfer: OK(), transferSent: 100n * k, transferReceived: 100n * k,
  poolTransfer: OK(), poolTransferSent: 100n * k, poolTransferReceived: 100n * k,
});
/** Full sell (S == D): the round trip is measured as 1 - sellOut / buyIn, here exactly lossBps. */
const fullSell = (k: bigint, lossBps: bigint): any => {
  const r = clean(k);
  Object.assign(r, { sellIn: r.buyDelivered, sellPoolReceived: r.buyDelivered, sellOut: (10_000n - lossBps) * k });
  return r;
};
const SCALES = [1n, 10n ** 14n, 10n ** 18n];
const V = (r: any, maxTaxBps = 100) => instrumentVerdict(measure(r), { maxTaxBps });

for (const k of SCALES) {
  test(`[fixture] clean vector at scale ${k} is MEASURED with every tax exactly 0`, () => {
    const m = measure(clean(k));
    for (const f of ['buyTaxBps', 'sellTaxBps', 'sellTaxSwapBps', 'transferTaxBps'] as const) assert.equal(m[f], 0n, f);
    assert.equal(m.roundTripLossBps, null);
    assert.deepEqual(V(clean(k)), { v: 'MEASURED', status: 'MEASURED', why: 'buy, sell and transfers measured' });
  });
}

// (i) The exact C2-f vector (sub/V-X1.md:68): sell ok, sellOut 1 wei, sellIn 500, pool received 5 -> sellTaxSwapBps
// 9900; transfer to the pool 100/100 -> sellTaxBps 0; maxTaxBps 100. The prototype said MEASURED. [M2]
test('(i) C2-f exact vector: sellTaxSwapBps 9900 with a clean pool transfer CONDEMNs at maxTaxBps 100', () => {
  const r = clean();
  Object.assign(r, { sellIn: 500n, sellPoolReceived: 5n, sellOut: 1n, poolTransferSent: 100n, poolTransferReceived: 100n });
  const m = measure(r);
  assert.equal(m.sellTaxBps, 0n); assert.equal(m.sellTaxSwapBps, 9_900n); assert.equal(m.buyTaxBps, 0n); assert.equal(m.sellOut, 1n);
  const v = instrumentVerdict(m, { maxTaxBps: 100 });
  assert.equal(v.v, 'CONDEMN'); assert.equal(v.why, 'sellTaxSwapBps 9900 >= 100');
});
test('(i) C2-f with a full sell (roundTripLossBps 9999): CONDEMN by the swap-side tax', () => {
  const r = fullSell(1n, 9_999n); r.sellPoolReceived = 99n;
  const m = measure(r);
  assert.equal(m.roundTripLossBps, 9_999n); assert.equal(m.sellTaxSwapBps, 9_901n); assert.equal(m.sellTaxBps, 0n);
  assert.equal(instrumentVerdict(m, { maxTaxBps: 100 }).v, 'CONDEMN');
});

// (ii) The swap-side sell tax not measured is NOT_MEASURED, never MEASURED. [M8]
for (const k of SCALES) {
  test(`(ii) sale executed but sellIn 0 at scale ${k} (swap-side tax not measurable): NOT_MEASURED`, () => {
    const r = clean(k); r.sellIn = 0n;
    const m = measure(r);
    assert.equal(m.sellOk, true); assert.equal(m.sellTaxSwapBps, null); assert.equal(m.sellTaxBps, 0n);
    const v = V(r);
    assert.equal(v.status, 'NOT_MEASURED'); assert.equal(v.v, 'WARN');
  });
}
test('(ii) a Measure with any one sell/buy tax null is NOT_MEASURED, whichever it is [M8]', () => {
  const m0 = measure(clean());
  for (const f of ['buyTaxBps', 'sellTaxBps', 'sellTaxSwapBps'] as const) {
    const m: Measure = { ...m0, [f]: null };
    const v = instrumentVerdict(m, { maxTaxBps: 100 });
    assert.equal(v.status, 'NOT_MEASURED', f); assert.equal(v.v, 'WARN', f);
  }
});
for (const [name, bits] of [['POOL_SELL', UM.POOL_SELL], ['BAL_X', UM.BAL_X], ['POOL_SELL|BAL_X', UM.POOL_SELL | UM.BAL_X], ['POOL_BUY', UM.POOL_BUY]] as const) {
  test(`(ii) unmeasured flag ${name}: the sell/buy tax it hides is null and the verdict is NOT_MEASURED [M9]`, () => {
    const r = clean(); r.unmeasured = bits;
    const v = V(r);
    assert.equal(v.status, 'NOT_MEASURED'); assert.notEqual(v.v, 'MEASURED');
  });
}

// (iii) Round-trip loss at or above the threshold: never MEASURED. It includes pool fees and price impact, so it
// does not condemn alone: WARN. One below the threshold stays MEASURED. [M10, M11]
for (const k of SCALES) {
  for (const [loss, want] of [[99n, 'MEASURED'], [100n, 'WARN'], [101n, 'WARN'], [9_999n, 'WARN']] as const) {
    test(`(iii) full sell at scale ${k}, roundTripLossBps ${loss} vs maxTaxBps 100: ${want}`, () => {
      const m = measure(fullSell(k, loss));
      assert.equal(m.roundTripLossBps, loss); assert.equal(m.sellTaxSwapBps, 0n); assert.equal(m.buyTaxBps, 0n);
      const v = instrumentVerdict(m, { maxTaxBps: 100 });
      assert.equal(v.v, want); assert.equal(v.status, want);
      if (want === 'WARN') assert.match(v.why, new RegExp(`roundTripLossBps ${loss} >= 100`));
    });
  }
}

// (iv) meet/combine/tierVerdict are the infimum, independent of order. Oracle: a literal rank table, not the code.
const RANKS: Record<string, number> = { CONDEMN: 0, WARN: 1, MEASURED: 2 };
const NAMES = ['CONDEMN', 'WARN', 'MEASURED'];
const VALUES: unknown[] = ['CONDEMN', 'WARN', 'MEASURED', '???', 'toString', '__proto__', 'constructor', undefined, null];
const rank = (x: unknown) => (typeof x === 'string' && Object.hasOwn(RANKS, x) ? RANKS[x] : 1);
const inf = (xs: unknown[]) => NAMES[Math.min(2, ...xs.map(rank))];
const perms = <T>(a: T[]): T[][] => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
const TRIPLES = VALUES.flatMap((a) => VALUES.flatMap((b) => VALUES.map((c) => [a, b, c])));

test('(iv) meet folded over every permutation of every triple is the infimum [L1, L6]', () => {
  for (const t of TRIPLES) for (const p of perms(t)) {
    assert.equal(p.reduce((v: unknown, x) => meet(v, x), 'MEASURED'), inf(t), JSON.stringify(p));
    assert.equal(meet(p[0], meet(p[1], p[2])), meet(meet(p[0], p[1]), p[2]), JSON.stringify(p));
  }
});
test('(iv) combine over sim/quoter/transfer in every insertion order is the infimum; own __proto__ key counts [L1, L6]', () => {
  const K = ['sim', 'quoter', 'transfer'];
  for (const t of TRIPLES) for (const order of perms([0, 1, 2])) {
    const o = Object.fromEntries(order.map((i) => [K[i], t[i]]));
    assert.equal(combine(o), inf(t), JSON.stringify(order.map((i) => [K[i], t[i]])));
    const withProto = Object.fromEntries([...order.map((i) => [K[i], t[i]]), ['__proto__', 'CONDEMN']]);
    assert.equal(combine(withProto), 'CONDEMN');
  }
});
test('(iv) tierVerdict uses the same meet: every insertion order of A/B/C gives the infimum [T1, L6]', () => {
  const T = ['A', 'B', 'C'];
  for (const t of TRIPLES) for (const order of perms([0, 1, 2])) {
    const o = Object.fromEntries(order.map((i) => [T[i], t[i]]));
    const ran = t.filter((x) => x !== undefined && x !== null);
    const want = ran.length === 0 ? 'WARN' : inf(ran);
    assert.equal(tierVerdict(o).v, want, JSON.stringify(order.map((i) => [T[i], t[i]])));
    assert.equal(tierVerdict(o).v, combine({ sim: tierVerdict(o).v, quoter: 'MEASURED', transfer: 'MEASURED' }));
  }
});
