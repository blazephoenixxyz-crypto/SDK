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

test('[5n-ctl] control: every reading present, no tax: the sale tax is measured as 0', () => {
  const { r, x } = V(run());
  assert.equal(r.unmeasured, 0n); assert.equal(x.sellTaxSwapBps, 0n); assert.equal(x.taxFloorBps, 0n);
});

test('[5n-pt-y] pair read failed (pt:y1): the seller debit is still measured and +50 % into the token condemns', () => {
  const { r, x, v } = V(run({ 'pt:y1': bad, 'pt:s1': u(500n) }));
  assert.ok((B(r.unmeasured) & UM.POOL_SELL) !== 0n);
  assert.equal(r.poolTransferSent, 1000n, 'sent = pt:x0 - pt:x1, no pair read needed');
  assert.equal(x.taxFloorBps, 5000n); assert.equal(v.status, 'CONDEMN');
});

for (const [self, floor, status] of [[100n, 1000n, 'CONDEMN'], [99n, 990n, 'NOT_MEASURED']] as const) {
  test(`[5n-pt-y-edge] pair read failed, token +${self} of 1000 wei sent: floor ${floor} bps at max 1000 -> ${status}`, () => {
    const { x, v } = V(run({ 'pt:y1': bad, 'pt:s1': u(self) }));
    assert.equal(x.taxFloorBps, floor); assert.equal(v.status, status); assert.notEqual(v.status, 'MEASURED');
  });
}

test('[5n-weth-self] WETH and sale pool unread: S and the token own delta are still measured; +50 % condemns', () => {
  const { r, x, v } = V(run({ 'sellA:w': bad, 'sellA:p0': bad, 'sellB:s': u(S / 2n) }));
  assert.equal(r.sellIn, S); assert.equal(r.sellTokenSelfDelta, S / 2n);
  assert.equal(x.sellOut, null, 'sellOut needs WETH: absent, never 0');
  assert.equal(x.taxFloorBps, 5000n); assert.equal(v.status, 'CONDEMN');
});

test('[5n-weth-pool] WETH unread, pool read: the pool takes 50 % of S -> floor 5000, CONDEMN', () => {
  const { r, x, v } = V(run({ 'sellA:w': bad, 'sellB:p0': u(S + S / 2n) }));
  assert.equal(r.sellPoolReceived, S / 2n);
  assert.equal(x.taxFloorBps, 5000n); assert.equal(v.status, 'CONDEMN');
});

test('[5n-weth-clean] WETH unread, no tax: NOT_MEASURED, never MEASURED (sellOut absent)', () => {
  const { x, v } = V(run({ 'sellA:w': bad }));
  assert.equal(x.sellOut, null); assert.equal(x.taxFloorBps, 0n); assert.equal(v.status, 'NOT_MEASURED');
});

test('[5n-x-absent] seller balance unread: no debit is invented, no floor, never MEASURED', () => {
  const { r, x, v } = V(run({ 'pt:x1': bad, 'pt:s1': u(500n), 'sellB:x': bad, 'sellB:s': u(S / 2n) }));
  assert.equal(r.poolTransferSent, 0n); assert.equal(r.sellIn, 0n);
  assert.equal(x.taxFloorBps, null); assert.equal(v.status, 'NOT_MEASURED');
});

function B(v: unknown): bigint { return typeof v === 'bigint' ? v : BigInt(v as string); }
