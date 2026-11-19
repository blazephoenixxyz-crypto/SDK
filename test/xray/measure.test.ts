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
// Intentional divergences from measure.mjs (V-X1 defects): new output field sellOut (defect 3).
const NEW_FIELDS = ['sellOut'];
// synth-fot5-fullsell: sellTaxSwapBps 5015 was ignored by instrumentVerdict (false clean, V-X1 C2-f).
const INTENTIONAL: Record<string, Record<string, string>> = { 'synth-fot5-fullsell.json': { '1000': 'CONDEMN' } };

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
    assert.deepEqual(m, g.measure);
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
  return r;
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
