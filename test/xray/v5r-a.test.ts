// V5r-a (2026-11-20): review threads on PR #19 at 540fd63. Each test names the behaviour and the mutant that turns it red
// (xray-ship/mut.mjs, ids 5r-a1..5r-a6). Absent stays absent: none of these paths may give MEASURED from a missing reading.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scan, runTier } from '../../src/xray/scan.js';
import { makeCtx } from '../../src/xray/ctx.js';
import { classifyProbe, decodeA, advance, toResult } from '../../src/xray/tiers.js';
import { measure, measureDirectSell, instrumentVerdict } from '../../src/xray/measure.js';
import { buildReport } from '../../src/xray/report.js';
import { fakeNode, drive, fakeBlk, POOL, TOKEN } from './fake.js';
import type { Rpc } from '../../src/xray/step.js';

const IDS = { X: '0x' + '11'.repeat(20), Y: '0x' + '22'.repeat(20) };
const BLK = fakeBlk();
const mk = (o: any = {}) => makeCtx(8453, TOKEN, BLK, { buyIn: 10n ** 15n, N: 100, mode: 'd4', ...o }, IDS);
const ERR = (error: any) => ({ jsonrpc: '2.0', id: 1, error });
const u = (v: bigint) => ({ ok: true, gas: null, ret: '0x' + v.toString(16).padStart(64, '0') });
const bad = { ok: false, gas: null, ret: '0x' };
const OK = () => ({ ok: true, gas: 40_000n, revertData: '0x' });

// ---- 5r-a1 (tiers.ts:59): -32601 carrying `data` is a missing tier (step down), not a probe revert.
test('[5r-a1] method-not-found with data (null, string, object) steps the probe down on every tier', () => {
  for (const data of [null, '0x', 'eth_simulateV1', { reason: 'x' }]) for (const t of ['A', 'B', 'C']) {
    const c: any = classifyProbe(t, ERR({ code: -32601, message: 'the method does not exist', data }));
    assert.equal(c.cls, 'down', `${t} ${JSON.stringify(data)}`); assert.equal(c.code, -32601);
  }
});
test('[5r-a1] genuine execution reverts stay reverts; unavailable stays terminal', () => {
  assert.equal(classifyProbe('A', ERR({ code: 3, message: 'execution reverted', data: '0x' })).cls, 'reverted');
  assert.equal(classifyProbe('C', ERR({ code: -32000, message: 'execution reverted', data: '0x08c379a0' })).cls, 'reverted');
  assert.equal(classifyProbe('B', ERR({ code: -32000, message: 'x' })).cls, 'down');
  assert.equal(classifyProbe('A', ERR({ code: -32005, message: 'limit', data: null })).cls, 'unavailable');
});
test('[5r-a1] scan: A:d4 answers -32601 with data null -> the ladder asks A:d2 and runs, no "probe reverted"', async () => {
  const node = fakeNode({ probe: { 'A:d4': ERR({ code: -32601, message: 'no', data: null }) } });
  const r: any = await drive(scan(mk), node.transport);
  assert.notEqual(r.why, 'probe reverted');
  assert.deepEqual(r.probes.slice(0, 2).map((p: any) => p.rung), ['A:d4', 'A:d2']);
  assert.equal(r.rung, 'A:d2');
});

// ---- 5r-a2 (tiers.ts:263): a null block or call entry is an unusable answer (null), never a TypeError.
const STEPS3 = [{ id: 'wrap' }, { id: 'approveIn' }, { id: 'quoteBuy' }];
test('[5r-a2] decodeA: null block, null call or non-object call -> null (no throw)', () => {
  for (const result of [[null], [{ calls: [null, null, null] }], [{ calls: [{ status: '0x1', returnData: '0x' }, 7, { status: '0x1' }] }],
    [{ calls: [{ status: '0x1', returnData: '0x' }] }, null, { calls: [{ status: '0x1' }, { status: '0x1' }] }]]) {
    assert.equal(decodeA(STEPS3, { result }), null, JSON.stringify(result));
  }
});
test('[5r-a2] decodeA: well-formed calls still decode, a reverted call keeps its revert data from error.data', () => {
  const m = decodeA(STEPS3, { result: [{ calls: [{ status: '0x1', returnData: '0x' }, { status: '0x0', returnData: '0x', error: { message: 'execution reverted', data: '0xdead' } }, { status: '0x1', returnData: '0x01' }] }] });
  assert.ok(m); assert.equal(m.approveIn.ok, false); assert.equal(m.approveIn.ret, '0xdead'); assert.equal(m.quoteBuy.ret, '0x01');
});
test('[5r-a2] runTier A: an answer with a null call is NOT_MEASURED "undecodable answer" (does not escape scan)', async () => {
  for (const result of [[null], [{ calls: [null, null, null] }]]) {
    const r: any = await drive(runTier('A', mk()), async (b: Rpc[]) => b.map(() => ({ jsonrpc: '2.0', id: 1, result })));
    assert.equal(r.status, 'NOT_MEASURED'); assert.equal(r.why, 'undecodable answer');
  }
});

// ---- 5r-a3 (tiers.ts:309): the sale is sized from the tokens this scan bought, not from what the actor already held.
const ctxS = { sellFracBps: 5_000n };
const mBuy = (a: any, b: any) => ({ buy: { ok: true, gas: null, ret: '0x' }, ...(a === undefined ? {} : { 'buyA:x': a }), ...(b === undefined ? {} : { 'buyB:x': b }) });
test('[5r-a3] tier C: Multicall3 held 900, the buy delivered 100 -> sells 50 (half the bought), not 500', () => {
  const a = advance(ctxS, { routeBuy: {} }, mBuy(u(900n), u(1_000n)), 'C');
  assert.equal(a.known.sellAmt, 50n); assert.equal(a.done, false);
});
test('[5r-a3] tier A fresh actor (held 0 before): the size is unchanged', () => {
  assert.equal(advance(ctxS, { routeBuy: {} }, mBuy(u(0n), u(1_000n)), 'A').known.sellAmt, 500n);
});
test('[5r-a3] a missing pre- or post-buy read never falls back to the total balance', () => {
  for (const [x, y] of [[undefined, u(1_000n)], [bad, u(1_000n)], [u(0n), bad], [u(0n), undefined]] as const) {
    const a = advance(ctxS, { routeBuy: {} }, mBuy(x, y), 'C');
    assert.equal(a.known.sellAmt, undefined); assert.equal(a.done, true); assert.equal(a.why, 'balance after buy not measured');
  }
});
test('[5r-a3] no increase (or a decrease) across the buy -> nothing to sell', () => {
  for (const [x, y] of [[1_000n, 1_000n], [1_000n, 900n], [1_000n, 1_001n]] as const) {
    const a = advance(ctxS, { routeBuy: {} }, mBuy(u(x), u(y)), 'C');
    assert.equal(a.known.sellAmt, 0n, `${x}->${y}`); assert.equal(a.why, 'nothing to sell');
  }
});

// ---- 5r-a4 (tiers.ts:352): an unread buy debit stays absent, in the result and in the report's legs; a measured 0 stays 0.
const buyM = (wB: any) => ({ buy: { ok: true, gas: null, ret: '0x' }, 'buyA:x': u(0n), 'buyB:x': u(100n), 'buyA:w': u(10n ** 15n), 'buyB:w': wB,
  'buyA:s': u(0n), 'buyB:s': u(0n), 'buyA:p0': u(10n ** 6n), 'buyB:p0': u(10n ** 6n - 100n) });
const report = (r: any) => buildReport({ chainId: 8453, block: { number: 1, hash: '0x' + '00'.repeat(32), timestamp: 1n }, target: TOKEN,
  amountIn: 10n ** 15n, maxTaxBps: 500, scan: { status: 'RAN', tier: 'C', rung: 'C', result: r, uncovered: [], limits: [] }, ctx: null });
test('[5r-a4] post-buy WETH unread: buyIn absent and the report buy leg amountIn is null, not 0', () => {
  for (const wB of [bad, undefined]) {
    const r = toResult({}, { routeBuy: { hops: [{ legs: [] }] } }, buyM(wB), 'C');
    assert.equal(r.buyIn, undefined); assert.equal(report(r).legs[0].amountIn, null);
  }
});
test('[5r-a4] both WETH reads present: buyIn measured (also a measured 0)', () => {
  assert.equal(toResult({}, { routeBuy: { hops: [{ legs: [] }] } }, buyM(u(0n)), 'C').buyIn, 10n ** 15n);
  const r0 = toResult({}, { routeBuy: { hops: [{ legs: [] }] } }, buyM(u(10n ** 15n)), 'C');
  assert.equal(r0.buyIn, 0n); assert.equal(report(r0).legs[0].amountIn, 0n);
});

// ---- 5r-a5 (measure.ts:233): a direct sale credited above what was sent is an over-credit, compared in wei before rounding.
test('[5r-a5] measureDirectSell: askIn 100001 > sent 100000 -> overCredit, tax null; equal amounts stay a valid 0', () => {
  const over: any = measureDirectSell({ ok: true, sent: 100_000n, askIn: 100_001n, wethOut: 1n });
  assert.equal(over.overCredit, true); assert.equal(over.directSellTaxBps, null); assert.equal(over.directSellOk, true);
  const eq: any = measureDirectSell({ ok: true, sent: 100_000n, askIn: 100_000n, wethOut: 1n });
  assert.equal(eq.overCredit, undefined); assert.equal(eq.directSellTaxBps, 0n);
  assert.equal((measureDirectSell({ ok: true, sent: 100_000n, askIn: 99_999n, wethOut: 1n }) as any).directSellTaxBps, 1n);
});
const Q = 4_986n * 10n ** 11n;
const resC = (o: any = {}): any => ({ tier: 'C', unmeasured: 0n, quoteBuy: OK(), buy: OK(), buyHops: 1n, buyIn: 10n ** 15n, buyPoolSent: 10n ** 18n,
  buyDelivered: 9_972n * 10n ** 14n, buyQuotedNet: 9_972n * 10n ** 14n, quoteSell: OK(), sellHops: 1n, sell: OK(), sellIn: 4_986n * 10n ** 14n,
  sellPoolReceived: 4_986n * 10n ** 14n, sellOut: Q, sellQuotedNet: Q, sellTokenSelfDelta: 0n,
  transfer: OK(), transferSent: 10n ** 16n, transferReceived: 10n ** 16n, poolTransfer: OK(), poolTransferSent: 10n ** 16n, poolTransferReceived: 10n ** 16n,
  buySafetyBuffer: 0n, sellSafetyBuffer: 0n, poolTransferTokenSelfDelta: 0n, poolTransferPairAnchorDelta: 0n, ...o });
const direct = (askIn: bigint) => ({ direct: OK(), directPool: POOL, directSent: 100_000n, directAskIn: askIn, directOut: 1n });
test('[5r-a5] verdict: otherwise MEASURED, a sub-bps direct over-credit gives NOT_MEASURED; equal amounts stay MEASURED', () => {
  const v = (o: any) => { const m = measure(resC(o), { tier: 'C' }); return instrumentVerdict(m, { maxTaxBps: 1000 }); };
  assert.equal(v(direct(100_000n)).status, 'MEASURED');
  const w = v(direct(100_001n)); assert.equal(w.status, 'NOT_MEASURED'); assert.equal(w.why, 'receiver credited more than sent');
});

// ---- 5r-a6 (test/xray/fake.ts:180): an injected null reply reaches the client; an absent key keeps the default answer.
test('[5r-a6] fake: probe injected as null -> NOT_MEASURED provider unavailable (not the default success)', async () => {
  const r: any = await drive(scan(mk), fakeNode({ probe: { 'A:d4': null } }).transport);
  assert.equal(r.status, 'NOT_MEASURED'); assert.equal(r.why, 'provider unavailable');
});
test('[5r-a6] fake: token reply injected as null on round 1 -> NOT_MEASURED provider unavailable', async () => {
  const r: any = await drive(scan(mk), fakeNode({ tokenErr: { 'A:d4': { 1: null } } }).transport);
  assert.equal(r.status, 'NOT_MEASURED'); assert.equal(r.why, 'provider unavailable');
});
test('[5r-a6] fake: an absent injection key keeps the default answer (scan runs at A:d4)', async () => {
  const r: any = await drive(scan(mk), fakeNode({ probe: {}, tokenErr: { 'A:d4': {} } }).transport);
  assert.equal(r.status, 'RAN'); assert.equal(r.rung, 'A:d4');
});
