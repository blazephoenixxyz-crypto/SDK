// Red-first for the X1-tiers-4 order: (a) a sell quote with no route, (b) a probe step that did not run
// ((c) is in rpc.test.ts). Plus the IC7 runtime pin.
// Each test names the mutant that turns it red (sub/W2-core.tsv, W2-core-3).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeFunctionResult, keccak256 } from 'viem';
import { PROBE_ABI, PROBE_KECCAK, PROBE_RUNTIME } from '../../src/xray/probe.js';
import { measure, instrumentVerdict } from '../../src/xray/measure.js';

const dir = new URL('./golden/', import.meta.url);
const base = () => {
  const g = JSON.parse(fs.readFileSync(new URL('synth-fot5-fullsell.json', dir), 'utf8'));
  const r = decodeFunctionResult({ abi: PROBE_ABI as any, functionName: 'probe', data: g.returnData }) as any;
  r.sellPoolReceived = (BigInt(r.sellIn) * 9_500n) / 10_000n; // 5 % swap-side tax: MEASURED at 1000 bps
  return r;
};
const V = (r: any) => instrumentVerdict(measure(r), { maxTaxBps: 1000 });
const noSale = (r: any) => { r.sellIn = 0n; r.sellOut = 0n; r.sellPoolReceived = 0n; r.sellQuotedNet = 0n; return r; };

test('[IC7] PROBE_RUNTIME hashes to the literal pin', () => {
  assert.equal(keccak256(PROBE_RUNTIME), PROBE_KECCAK);
});

// (a) XRayProbe._sell returns early when the sell quote has 0 hops: the sale never ran.
for (const sellHops of [0n, undefined]) {
  test(`(a) sell quote ok with sellHops ${sellHops}: NOT_MEASURED, never CONDEMN "sell reverted" [M-a]`, () => {
    const r = noSale(base()); r.sellHops = sellHops; r.sell = { ok: false, gas: 30_000n, revertData: '0x' };
    const m = measure(r);
    assert.equal(m.sellOk, null);
    const v = V(r);
    assert.equal(v.v, 'WARN'); assert.equal(v.status, 'NOT_MEASURED');
  });
}
test('(a) one hop and a real sell revert still CONDEMNs (the fix is not a blanket)', () => {
  const r = noSale(base()); r.sellHops = 1n; r.sell = { ok: false, gas: 30_000n, revertData: '0x' };
  assert.equal(V(r).v, 'CONDEMN');
});

// (b) Step without `ran` and gas 0 = not run (XRayProbe.sol:439-441 measures gas as g0 - gasleft() > 0
// for any call that ran); never read as a revert.
const NOT_RUN = { ok: false, gas: 0n, revertData: '0x' };
test('(b) sell step not run: NOT_MEASURED, never CONDEMN [M-b]', () => {
  const r = noSale(base()); r.sell = { ...NOT_RUN };
  assert.equal(measure(r).sellOk, null);
  const v = V(r); assert.equal(v.v, 'WARN'); assert.equal(v.status, 'NOT_MEASURED');
});
test('(b) explicit ran:false is not run; ran:true with gas 0 is a revert', () => {
  const r1 = noSale(base()); r1.sell = { ok: false, gas: 5n, revertData: '0x', ran: false };
  assert.equal(measure(r1).sellOk, null);
  const r2 = noSale(base()); r2.sell = { ok: false, gas: 0n, revertData: '0x', ran: true };
  assert.equal(V(r2).v, 'CONDEMN');
});
test('(b) pool transfer not run: not CONDEMN "transfer to the pool reverted" [M-b]', () => {
  const r = base(); r.poolTransfer = { ...NOT_RUN };
  assert.equal(measure(r).poolTransferOk, null);
  assert.notEqual(V(r).v, 'CONDEMN');
});
test('(b) wallet transfer not run: NOT_MEASURED, not "wallet transfer reverted" [M-b]', () => {
  const r = base(); r.transfer = { ...NOT_RUN };
  const v = V(r); assert.equal(v.status, 'NOT_MEASURED');
});
test('(b) buy not run: buyOk null [M-b]', () => {
  const r = base(); r.buy = { ...NOT_RUN };
  assert.equal(measure(r).buyOk, null);
  assert.equal(V(r).status, 'NOT_MEASURED');
});
test('(b) direct sale not run: directSellOk null, never "reverted" [M-b]', () => {
  const r = base(); r.unmeasured = BigInt(r.unmeasured) & ~64n; r.direct = { ...NOT_RUN }; r.directPool = '0x' + '11'.repeat(20); r.directOut = 0n;
  assert.equal(measure(r).directSellOk, null);
});
