// V5 guards: hidden economic tax, quote safety buffers, pair-transfer deltas read by toResult. Each block names the mutant it kills.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionResult } from 'viem';
import { measure, instrumentVerdict } from '../../src/xray/measure.js';
import { toResult } from '../../src/xray/tiers.js';
import { QUOTER_ABI } from '../../src/xray/abi.js';
const BPS = 10_000n;
const OK = () => ({ ok: true, gas: 40_000n, revertData: '0x' });
const Q = 4_986n * 10n ** 11n;
const resC = (o: any = {}): any => ({ tier: 'C', unmeasured: 0n, quoteBuy: OK(), buy: OK(), buyHops: 1n, buyIn: 10n ** 15n, buyPoolSent: 10n ** 18n,
  buyDelivered: 9_972n * 10n ** 14n, buyQuotedNet: 9_972n * 10n ** 14n, quoteSell: OK(), sellHops: 1n, sell: OK(), sellIn: 4_986n * 10n ** 14n,
  sellPoolReceived: 4_986n * 10n ** 14n, sellOut: Q, sellQuotedNet: Q, sellTokenSelfDelta: 0n,
  transfer: OK(), transferSent: 10n ** 16n, transferReceived: 10n ** 16n, poolTransfer: OK(), poolTransferSent: 10n ** 16n, poolTransferReceived: 10n ** 16n,
  buySafetyBuffer: 0n, sellSafetyBuffer: 0n, poolTransferTokenSelfDelta: 0n, poolTransferPairAnchorDelta: 0n, ...o });
const resA = (o: any = {}): any => resC({ tier: 'A', quoteLater: { ok: true }, sellLater: OK(), sellLaterIn: 4_986n * 10n ** 14n, sellLaterPoolReceived: 4_986n * 10n ** 14n,
  sellLaterOut: Q, sellLaterQuotedNet: Q, sellLaterTokenSelfDelta: 0n, sellLaterSafetyBuffer: 0n, ...o });
const V = (r: any, max = 1000) => { const m = measure(r, { tier: r.tier }); return { m, v: instrumentVerdict(m, { maxTaxBps: max }) }; };
// oracle: seller gets Q * (1 - e) of a quote Q, token-side clean (x = 0). hidden iff e > 0 + 1.
// Mutants: M4 (verdict hiddenTax line removed) -> rows 500/50/2 MEASURED; M15 (ROUND_BPS 100) -> rows 50/2 MEASURED; ROUND_BPS 0 -> row 1 NOT_MEASURED.
for (const [e, want] of [[500n, 'NOT_MEASURED'], [50n, 'NOT_MEASURED'], [2n, 'NOT_MEASURED'], [1n, 'MEASURED']] as const) {
  test(`[V-hidden<max] tier C: sale econ ${e} bps over token-side 0 (below maxTaxBps 1000): ${want}`, () => {
    const { m, v } = V(resC({ sellOut: Q - (Q * e) / BPS }));
    console.log(`hidden e=${e}: ${v.status} (${v.why}) swap=${m.sellTaxSwapBps} econ=${m.sellEconBps}`);
    assert.equal(m.sellEconBps, e); assert.equal(v.status, want, v.why);
    if (want === 'NOT_MEASURED') assert.equal(v.why, 'economic tax above the token-side reading');
  });
}
// Mutant M14 (every -> some): one buffer 0, the other not -> MEASURED.
for (const k of ['buySafetyBuffer', 'sellSafetyBuffer'] as const) test(`[V-buf-one] tier C: only ${k} = 1: NOT_MEASURED`, () => {
  const { m, v } = V(resC({ [k]: 1n })); assert.equal(m.quoteBufferBps, null); assert.equal(v.why, 'quote safety buffer not 0');
});
// Mutant M16 (later buffer not required at A).
test('[V-buf-later] tier A: only sellLaterSafetyBuffer = 1: NOT_MEASURED', () => {
  assert.equal(V(resA()).v.status, 'MEASURED');
  const { m, v } = V(resA({ sellLaterSafetyBuffer: 1n })); assert.equal(m.quoteBufferBps, null); assert.equal(v.why, 'quote safety buffer not 0');
});
// toResult: absent stays absent (M31/M32), and each quote's safetyBuffer is carried (M23-25).
const u = (v: bigint) => ({ ok: true, gas: null, ret: '0x' + v.toString(16).padStart(64, '0') });
const bad = { ok: false, gas: null, ret: '0x' };
test('[V-pt-absent] toResult: an unreadable pt:s1 / pt:o1 leaves the pair-transfer deltas absent, never 0', () => {
  const m: any = { poolTransfer: { ok: true, gas: 1n, ret: '0x' }, 'pt:s0': u(5n), 'pt:s1': bad, 'pt:o0': u(7n), 'pt:o1': bad };
  const r = toResult({}, {}, m, 'C');
  assert.equal(r.poolTransferTokenSelfDelta, undefined); assert.equal(r.poolTransferPairAnchorDelta, undefined);
  const m2: any = { ...m, 'pt:s1': u(5n), 'pt:o1': u(9n) }; const r2 = toResult({}, {}, m2, 'C');
  assert.equal(r2.poolTransferTokenSelfDelta, 0n); assert.equal(r2.poolTransferPairAnchorDelta, 2n);
});
function zero(p: any): any {
  if (p.type.endsWith('[]')) return [];
  if (p.type === 'tuple') return Object.fromEntries(p.components.map((c: any) => [c.name, zero(c)]));
  if (p.type === 'bool') return false; if (p.type === 'address') return '0x0000000000000000000000000000000000000000';
  if (p.type === 'bytes') return '0x'; if (p.type === 'bytes32') return '0x' + '00'.repeat(32); return 0n;
}
const QO: any = (QUOTER_ABI as any)[0].outputs;
const qret = (sb: bigint) => { const pv = zero(QO[0]); pv.canExecute = true; pv.netOut = 1000n; pv.safetyBuffer = sb;
  return { ok: true, gas: 1n, ret: encodeFunctionResult({ abi: QUOTER_ABI as any, functionName: 'previewPlan', result: [pv, zero(QO[1]), false] } as any) }; };
test('[V-buf-carry] toResult carries each quote safetyBuffer as read (3, 5, 7)', () => {
  const r = toResult({}, {}, { quoteBuy: qret(3n), quoteSell: qret(5n), quoteLater: qret(7n) }, 'A');
  assert.equal(r.buySafetyBuffer, 3n); assert.equal(r.sellSafetyBuffer, 5n); assert.equal(r.sellLaterSafetyBuffer, 7n);
});
// Tier A, every tax 0 and every quote buffer > 0 (1 wei and 30 bps): the buffer may hide tax from the economic reading,
// so not 0 is NOT_MEASURED at A too, not only at C. Mutant 5d4 (buffer accepted at any value) -> MEASURED.
for (const b of [1n, 30n]) test(`[V-buf-A] tier A: taxes 0, all quote buffers ${b}: NOT_MEASURED 'quote safety buffer not 0'`, () => {
  const { m, v } = V(resA({ buySafetyBuffer: b, sellSafetyBuffer: b, sellLaterSafetyBuffer: b }));
  assert.equal(m.buyTaxBps, 0n); assert.equal(m.sellTaxSwapBps, 0n); assert.equal(m.sellLaterTaxSwapBps, 0n);
  assert.equal(m.quoteBufferBps, null); assert.equal(v.status, 'NOT_MEASURED'); assert.equal(v.why, 'quote safety buffer not 0');
});
