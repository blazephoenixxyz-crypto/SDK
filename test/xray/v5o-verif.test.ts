// V5n (2026-11-20): toResult writes each measured amount from its own reads. The seller's debit (sent, sellIn) needs only
// the seller's balance; the pair's balance (pt:y) and WETH are other readings. Red at 8b7703e: with pt:y or WETH unread
// toResult left poolTransferSent / sellIn / sellTokenSelfDelta at 0, so the own-balance floor was lost and a token taking
// 50 % into itself came out WARN/NOT_MEASURED instead of CONDEMN (owner rule: any lower bound >= maxTaxBps condemns).
// Absent stays absent: nothing here becomes MEASURED, and no nominal amount replaces a read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionResult } from 'viem';
import { measure, instrumentVerdict, UM } from '../../src/xray/measure.js';
import { toResult } from '../../src/xray/tiers.js';
import { QUOTER_ABI } from '../../src/xray/abi.js';

const u = (v: bigint) => ({ ok: true, gas: 1n, ret: '0x' + v.toString(16).padStart(64, '0') });
const bad = { ok: false, gas: null, ret: '0x' };
const OK = { ok: true, gas: 1n, ret: '0x' };
function zero(p: any): any {
  if (p.type.endsWith('[]')) return [];
  if (p.type === 'tuple') return Object.fromEntries(p.components.map((c: any) => [c.name, zero(c)]));
  if (p.type === 'bool') return false; if (p.type === 'address') return '0x0000000000000000000000000000000000000000';
  if (p.type === 'bytes') return '0x'; if (p.type === 'bytes32') return '0x' + '00'.repeat(32); return 0n;
}
const QO: any = (QUOTER_ABI as any)[0].outputs;
const HOPS: any = QO[0].components.find((c: any) => c.name === 'route').components.find((c: any) => c.name === 'hops');
const quote = (netOut: bigint) => { const pv = zero(QO[0]); pv.canExecute = true; pv.netOut = netOut; pv.safetyBuffer = 0n;
  pv.route.hops = [zero({ type: 'tuple', components: HOPS.components })];
  return { ok: true, gas: 1n, ret: encodeFunctionResult({ abi: QUOTER_ABI as any, functionName: 'previewPlan', result: [pv, zero(QO[1]), false] } as any) }; };
const S = 1_000_000n, OUT = 10n ** 15n;
// Tier C, every reading present and no tax: buy 1e18 wei -> pool sends 1e6, buyer gets net of the 28 bps Router fee.
const run = (o: Record<string, unknown> = {}): any => ({
  quoteBuy: quote(997_200n), buy: OK, 'buyA:x': u(0n), 'buyB:x': u(997_200n), 'buyA:w': u(10n ** 18n), 'buyB:w': u(0n),
  'buyA:s': u(0n), 'buyB:s': u(0n), 'buyA:p0': u(2n * S), 'buyB:p0': u(S),
  quoteSell: quote(OUT), sell: OK, 'sellA:x': u(S), 'sellB:x': u(0n), 'sellA:w': u(0n), 'sellB:w': u(OUT),
  'sellA:s': u(0n), 'sellB:s': u(0n), 'sellA:p0': u(S), 'sellB:p0': u(2n * S),
  poolTransfer: OK, 'pt:x0': u(10_000n), 'pt:x1': u(9_000n), 'pt:y0': u(5_000n), 'pt:y1': u(6_000n),
  'pt:s0': u(0n), 'pt:s1': u(0n), 'pt:o0': u(0n), 'pt:o1': u(0n), ...o });
const V = (m: any, max = 1000) => { const r = toResult({}, {}, m, 'C'); const x = measure(r, { tier: 'C' }); return { r, x, v: instrumentVerdict(x, { maxTaxBps: max }) }; };
function B(v: unknown): bigint { return typeof v === 'bigint' ? v : BigInt(v as string); }

// G1 guard: only one self read present -> toResult invents (b.s ?? 0n) - (a.s ?? 0n); the SELF bit must stop the floor.
// Mutant 5o-M1 (measure.ts:141 drop `&& !has(UM.SELF)`): false CONDEMN on a token with no tax.
test('[5o-self-half] sellA:s unread, sellB:s holds a standing balance, no tax: no floor from the invented delta, never CONDEMN', () => {
  const { r, x, v } = V(run({ 'sellA:s': bad, 'sellB:s': u(S / 2n) }));
  assert.ok((B(r.unmeasured) & UM.SELF) !== 0n);
  assert.equal(x.taxFloorBps, 0n); assert.notEqual(v.status, 'CONDEMN'); assert.notEqual(v.status, 'MEASURED');
});
test('[5o-self-half-weth] same with WETH unread (the 5n path): never CONDEMN', () => {
  const { x, v } = V(run({ 'sellA:w': bad, 'sellA:p0': bad, 'sellA:s': bad, 'sellB:s': u(S / 2n) }));
  assert.equal(x.taxFloorBps, null); assert.equal(v.status, 'NOT_MEASURED');
});

// G2 finding: the later sale (tier A) still writes sellLaterIn / sellLaterTokenSelfDelta only with WETH read
// (tiers.ts:400). x and s read, w unread: a 50 % rise into the token is a measured lower bound, lost -> not CONDEMN.
const runA = (o: Record<string, unknown> = {}): any => run({ quoteLater: quote(OUT), sellLater: OK,
  'lateA:x': u(S), 'lateB:x': u(0n), 'lateA:w': u(0n), 'lateB:w': u(OUT), 'lateA:s': u(0n), 'lateB:s': u(0n),
  'lateA:p0': u(S), 'lateB:p0': u(2n * S), ...o });
const VA = (m: any, max = 1000) => { const r = toResult({}, {}, m, 'A'); const x = measure(r, { tier: 'A' }); return { r, x, v: instrumentVerdict(x, { maxTaxBps: max }) }; };
test('[5o-late-ctl] tier A later sale, every read present, token +50 % into itself: CONDEMN (green today)', () => {
  const { x, v } = VA(runA({ 'lateB:s': u(S / 2n) }));
  assert.equal(x.taxFloorBps, 5000n); assert.equal(v.status, 'CONDEMN');
});
test('[5o-late-weth] tier A later sale, lateA:w unread, token +50 % into itself: the own-balance floor still condemns', () => {
  const { r, x, v } = VA(runA({ 'lateA:w': bad, 'lateB:s': u(S / 2n) }));
  assert.equal(r.sellLaterIn, S, 'debit = lateA:x - lateB:x, no WETH read needed');
  assert.equal(x.taxFloorBps, 5000n); assert.equal(v.status, 'CONDEMN');
});
