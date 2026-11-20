// X-Ray measure + verdict: parity with deep-xray@8d6e81c goldens, plus the V-X1 defects fixed in the port.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeFunctionResult, encodeFunctionResult, keccak256, toFunctionSelector, toHex } from 'viem';
import { PROBE_ABI, PROBE_KECCAK } from '../../src/xray/probe.js';
import { measure, instrumentVerdict, ROUTE_TEXT } from '../../src/xray/measure.js';
import { combine, meet, REQUIRED } from '../../src/xray/lattice.js';

const S = (o: unknown) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
const dir = new URL('./golden/', import.meta.url);
const goldens = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
const load = (f: string) => JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8'));
const fn = (PROBE_ABI as readonly any[]).find((x) => x.name === 'probe');
// Intentional divergences from measure.mjs (V-X1 defects): new output field sellOut (defect 3); the later-sale
// fields of tier A (V2).
const NEW_FIELDS = ['sellOut', 'sellLaterOk', 'sellLaterTaxSwapBps', 'sellLaterOut', 'laterRequired'];
// synth-fot5-fullsell: sellTaxSwapBps 5015 was ignored by instrumentVerdict (false clean, V-X1 C2-f).
const INTENTIONAL: Record<string, Record<string, string>> = { 'synth-fot5-fullsell.json': { '1000': 'CONDEMN' } };
// Measure fields that differ on purpose from the JS producer (2026-11-20). V8: no round-trip guard, so
// roundTripLossBps is null and the 'partial sell' note is gone. V7: a pool transfer that ran is read (ok true)
// whatever its sent amount; its tax stays null here because the flags hide the receiver delta.
const INTENTIONAL_MEASURE: Record<string, Record<string, unknown>> = {
  'synth-fot5-fullsell.json': { roundTripLossBps: null },
  'synth-v4-sell-unmeasured.json': { notes: [], poolTransferOk: true },
  'v2-halfsell-direct-56632746.json': { notes: [] },
};
// V5 (2026-11-20): the expected Measure is regenerated, the inputs are not. The probe ABI is frozen and carries no
// quote safetyBuffer, no pt:s/pt:o reads and no pool reserves, so no vector can gain them without inventing data:
// quoteBufferBps stays null and the transfer to the pair is not identifiable at A/C (sellTaxBps null). The verdicts
// are unchanged (the loop below still compares them to the JS producer). The V5 fields are computed here from the
// vector, never copied from the port's output:
// - buy (Router 1.0.0, BlazePhoenixRouter.sol:410-422, fee rounded down): net = P - floor(P * 28 / 1e4); D > net is an
//   over-credit (tax null). The two on-chain vectors hit net to the wei, so the producer's buyTaxBps 0 must stand.
// - econ: ceil((quotedNet - got) * 1e4 / quotedNet); got > quotedNet in wei is null + overCredit.
// - taxFloorBps: the largest token-side reading the JS producer made (sellTaxSwapBps, sellTaxBps).
const NOTE_BUF = 'a quote safety buffer is not 0 or not read: the economic tax is not identifiable';
const NOTE_PT = 'transfer to the pair: token contract balance not measured: swap-side tax not identifiable';
const NOTE_OC_BUY = 'buy: buyer credited more than the pool sent net of the fee: tax not identifiable';
const V5_NONE = { buyEconBps: null, sellEconBps: null, sellLaterEconBps: null, quoteBufferBps: null, hiddenTax: false, overCredit: false, pairTransferCovered: true, taxFloorBps: null };
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
function v5(f: string, gm: Record<string, any>, r: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...V5_NONE };
  const pre: string[] = [], post: string[] = [];
  const econ = (got: bigint, k: string): string | null => {
    const q = BigInt(r[k]);
    if (got > q) { out.overCredit = true; post.push(`${k}: received more than quoted: economic tax not identifiable`); return null; }
    return String(ceil((q - got) * 10_000n, q));
  };
  if (gm.buyOk === true && gm.buyTaxBps !== null) {
    const D = BigInt(r.buyDelivered), P = BigInt(r.buyPoolSent), net = P - (P * 28n) / 10_000n;
    if (D > net) { out.overCredit = true; out.buyTaxBps = null; out.buyTaxGrossBps = null; pre.push(NOTE_OC_BUY); }
    else out.buyEconBps = econ(D, 'buyQuotedNet');
  }
  if (gm.sellTaxBps !== null) { out.sellTaxBps = null; post.unshift(NOTE_PT); }
  if (gm.sellOk === true) out.sellEconBps = econ(BigInt(r.sellOut), 'sellQuotedNet');
  const reads = [gm.sellTaxSwapBps, gm.sellTaxBps].filter((x) => x !== null).map((x) => BigInt(x));
  if (reads.length) out.taxFloorBps = String(reads.reduce((m, x) => (x > m ? x : m)));
  if (gm.buyOk === true) post.push(NOTE_BUF);
  out.notes = [...pre, ...((INTENTIONAL_MEASURE[f]?.notes as string[] | undefined) ?? gm.notes), ...post];
  return out;
}

test('probe ABI is frozen: selector and full fragment hash', () => {
  assert.equal(toFunctionSelector(fn), '0x61153369');
  assert.equal(keccak256(toHex(JSON.stringify(fn))), '0x226d34ecb830f8b67c639d1c7ef81ac83047d86d3e76385a0ba179858392fa3b');
});
test('ten golden vectors are present', () => { assert.equal(goldens.length, 10); });
for (const f of goldens) {
  test(`golden ${f}: decode, re-encode, measure and verdict match the JS producer`, () => {
    const g = load(f);
    assert.equal(g.probeKeccak, PROBE_KECCAK);
    const r = decodeFunctionResult({ abi: PROBE_ABI as any, functionName: 'probe', data: g.returnData }) as any;
    assert.deepEqual(S(r), g.result);
    assert.equal(encodeFunctionResult({ abi: PROBE_ABI as any, functionName: 'probe', result: r }), g.returnData);
    const m = S(measure(r));
    for (const k of NEW_FIELDS) delete m[k];
    assert.deepEqual(m, { ...g.measure, ...INTENTIONAL_MEASURE[f], ...v5(f, g.measure, S(r)) });
    for (const [t, v] of Object.entries(g.verdict)) {
      const want = (INTENTIONAL[f]?.[t] ?? v) as string;
      assert.equal(instrumentVerdict(measure(r), { maxTaxBps: Number(t) }).v, want, `t=${t}`);
    }
  });
}

const base = () => {
  const g = load(goldens.find((f) => f.startsWith('synth-fot5-fullsell'))!);
  const r = decodeFunctionResult({ abi: PROBE_ABI as any, functionName: 'probe', data: g.returnData }) as any;
  r.sellPoolReceived = (BigInt(r.sellIn) * 9_500n) / 10_000n; // a 5 % swap-side tax, below 1000 bps
  // V5 at A/C, derived from the vector: quotes with safetyBuffer 0, the buy delivered and quoted net of the 28 bps fee
  // rounded down (Router 1.0.0 BlazePhoenixRouter.sol:410-422, Quoter 1.0.0 BlazePhoenixQuoter.sol:163-165; the synth
  // vector was credited above that, an over-credit), the sale quoted at the concave bound out * sellIn / poolReceived (economic tax
  // <= swap-side tax), and the token's own balance and the pair's anchor balance still across the transfer to the pair.
  const P = BigInt(r.buyPoolSent);
  return Object.assign(r, { buyDelivered: P - (P * 28n) / 10_000n, buyQuotedNet: P - (P * 28n) / 10_000n, buySafetyBuffer: 0n, sellSafetyBuffer: 0n,
    sellQuotedNet: (BigInt(r.sellOut) * BigInt(r.sellIn)) / r.sellPoolReceived, poolTransferTokenSelfDelta: 0n, poolTransferPairAnchorDelta: 0n });
};
test('baseline (fot5 full sell, 5 % swap-side tax) is MEASURED at 1000 bps (fixture sanity)', () => {
  assert.equal(instrumentVerdict(measure(base()), { maxTaxBps: 1000 }).v, 'MEASURED');
});
test('maxTaxBps is an owner decision: missing throws', () => {
  assert.throws(() => instrumentVerdict(measure(base()), {} as any), /owner decision/);
});
test('route-only sale keeps the exact ROUTE_TEXT', () => { assert.match(ROUTE_TEXT, /limit of our route/); });

// Defect 2 (IC3): absent is never measured.
test('IC3: Result without the unmeasured field is NOT_MEASURED, never ?? 0', () => {
  const r = base(); delete r.unmeasured;
  const v = instrumentVerdict(measure(r), { maxTaxBps: 1000 });
  assert.notEqual(v.v, 'MEASURED'); assert.equal(v.status, 'NOT_MEASURED');
});
test('IC3: transferOk null (transfer reverted without data, sent 0) is NOT_MEASURED', () => {
  const r = base(); r.transferSent = 0n; r.transfer = { ok: false, gas: 0n, revertData: '0x' };
  const m = measure(r); assert.equal(m.transferOk, null);
  const v = instrumentVerdict(m, { maxTaxBps: 1000 });
  assert.equal(v.v, 'WARN'); assert.equal(v.status, 'NOT_MEASURED');
});
// Defect 3: false clean through the sell leg.
test('sell that returns 0 wei CONDEMNs', () => {
  const r = base(); r.sellOut = 0n;
  assert.equal(instrumentVerdict(measure(r), { maxTaxBps: 1000 }).v, 'CONDEMN');
});
test('sell that returns 1 wei with sellTaxSwapBps 9900 is not MEASURED', () => {
  const r = base(); r.sellOut = 1n; r.sellPoolReceived = (BigInt(r.sellIn) * 100n) / 10_000n;
  const m = measure(r); assert.ok(m.sellTaxSwapBps! >= 9900n);
  assert.notEqual(instrumentVerdict(m, { maxTaxBps: 1000 }).v, 'MEASURED');
});
for (const t of [1000, 1001, 999]) {
  test(`sellTaxSwapBps at the threshold edge (${t} vs 1000) follows the >= predicate`, () => {
    const r = base(); r.sellPoolReceived = (BigInt(r.sellIn) * BigInt(10_000 - t)) / 10_000n;
    const m = measure(r);
    const v = instrumentVerdict(m, { maxTaxBps: 1000 }).v;
    assert.equal(v === 'CONDEMN', m.sellTaxSwapBps! >= 1000n);
  });
}
// Defects 1, 2 and 4: one lattice producer.
test('IC4: meet is the infimum and does not depend on order', () => {
  for (const [a, b] of [['CONDEMN', '???'], ['???', 'CONDEMN']]) assert.equal(meet(a, b), 'CONDEMN');
  assert.equal(combine({ sim: 'CONDEMN', quoter: '???' }), 'CONDEMN');
  assert.equal(combine({ quoter: '???', sim: 'CONDEMN' }), 'CONDEMN');
  assert.equal(combine({ sim: 'MEASURED', quoter: '???' }), 'WARN');
});
test('IC3: prototype keys are unknown, never MEASURED', () => {
  for (const k of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    assert.equal(meet('MEASURED', k), 'WARN', k);
    assert.equal(combine({ sim: k, quoter: 'MEASURED' }), 'WARN', k);
  }
});
test('IC4: the mandatory set R is fixed; a missing one gives at most WARN', () => {
  assert.deepEqual([...REQUIRED], ['sim', 'quoter', 'transfer']);
  assert.equal(combine({ sim: 'MEASURED' }), 'WARN');
  assert.equal(combine({}), 'WARN');
  assert.equal(combine({ sim: 'MEASURED', quoter: 'MEASURED', transfer: 'MEASURED' }), 'MEASURED');
  assert.equal(combine(Object.create({ sim: 'MEASURED', quoter: 'MEASURED', transfer: 'MEASURED' })), 'WARN');
});
test('IC5: optional (third-party) inputs only lower the verdict', () => {
  const R = { sim: 'MEASURED', quoter: 'MEASURED', transfer: 'MEASURED' };
  assert.equal(combine(R, ['MEASURED']), 'MEASURED');
  assert.equal(combine(R, ['CONDEMN']), 'CONDEMN');
  assert.equal(combine({ sim: 'CONDEMN', quoter: 'CONDEMN' }, ['MEASURED']), 'CONDEMN');
  assert.equal(combine(R, ['toString']), 'WARN');
});
