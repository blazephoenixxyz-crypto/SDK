// V5 fresh verifier (2026-11-20). Every test asserts the EXPECTED verdict (rule: never MEASURED when a real tax is
// above maxTaxBps or the sale reading can carry a swapback). Red = a false clean found at 5453eed.
// The repo's fake node only models a fixed-cap swapback taken BEFORE the tax; this file adds a node (same fake for
// pins, quotes and probe injections) whose token-to-pair move is: seller -v, holder +tax, then the holder moves
// `amt` tokens into the pair (sold for WETH, or donated), pair +(v - tax). Every token delta the X-Ray reads
// (seller, pair, token contract) is then as shown in each case below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionResult, getAddress } from 'viem';
import { runXray } from '../../src/xray/index.js';
import { measure, instrumentVerdict } from '../../src/xray/measure.js';
import { QUOTER_ABI, ROUTER_ABI, ERC20_ABI, MC3_ABI, MC3 } from '../../src/xray/abi.js';
import { XRAY_DEPLOYMENTS } from '../../src/xray/ctx.js';
import { TIER_LIMITS } from '../../src/xray/tiers.js';
import { fakeNode, isProbe, TOKEN, POOL, RATE, RESERVE } from './fake.js';

const BPS = 10_000n, FEE = 28n;
const lc = (a: unknown) => String(a).toLowerCase();
const EXT = getAddress('0x' + '5e'.repeat(20));
type Sb = {
  sellTaxBps: bigint; buyTaxBps?: bigint; holder?: string;
  /** 'all': after taking the fee the holder sells its WHOLE balance (common swapBack(balanceOf(this)) with the
   *  balance drained by the previous sale); 'prop': the holder sells kBps of the moved amount. */
  mode: 'all' | 'prop'; kBps?: bigint; start?: bigint;
  /** the BlazePhoenix router is fee-exempt: tax and swapback only on a plain transfer to the pair. */
  routerExempt?: boolean;
  /** on a buy, the holder donates buyDonateBps of the pair's output back into the pair (no WETH out). */
  buyDonateBps?: bigint;
};
function zero(p: any): any {
  if (p.type.endsWith('[]')) return [];
  if (p.type === 'tuple') return Object.fromEntries(p.components.map((c: any) => [c.name, zero(c)]));
  if (p.type === 'bool') return false;
  if (p.type === 'address') return '0x0000000000000000000000000000000000000000';
  if (p.type === 'bytes') return '0x';
  if (p.type === 'bytes32') return '0x' + '00'.repeat(32);
  return 0n;
}
const QO: any = (QUOTER_ABI as any)[0].outputs;
function preview(tIn: string, tOut: string, amt: bigint) {
  const pv = zero(QO[0]);
  const legT = QO[0].components.find((c: any) => c.name === 'route').components.find((c: any) => c.name === 'hops').components.find((c: any) => c.name === 'legs');
  const leg = { ...zero({ ...legT, type: 'tuple' }), pool: POOL, kind: 2, amountIn: amt };
  const out = lc(tIn) === lc(TOKEN) ? amt / RATE : amt * RATE;
  pv.route.hops = [{ tokenIn: tIn, tokenOut: tOut, amountIn: amt, expectedOut: out, legs: [leg] }];
  // As test/xray/fake.ts: exec() charges the protocol fee on the buy output, so the buy is quoted net of it (Quoter :353,
  // rounded up, safetyBuffer 0); the sale is executed and quoted without it. A fee-less buy quote would put a spurious
  // 28 bps hidden-tax signal (buyEconBps 28 > buyTaxBps 0 + 1) in every result of this file.
  pv.canExecute = true; pv.netOut = lc(tIn) === lc(TOKEN) ? out : out - (out * FEE + BPS - 1n) / BPS;
  return encodeFunctionResult({ abi: QUOTER_ABI as any, functionName: 'previewPlan', result: [pv, zero(QO[1]), false] } as any);
}
function exec(st: any, sb: Sb, weth: string, actor: string, to: string, data: string, value: bigint) {
  const H = sb.holder ?? TOKEN;
  const bal = (t: string, a: string): bigint => st[lc(t)]?.[lc(a)] ?? (lc(a) === lc(POOL) ? RESERVE : lc(t) === lc(TOKEN) && lc(a) === lc(H) ? (sb.start ?? 0n) : 0n);
  const add = (t: string, a: string, v: bigint) => { st[lc(t)] ??= {}; st[lc(t)][lc(a)] = bal(t, a) + v; };
  const toPool = (from: string, v: bigint, viaRouter: boolean): bigint => {
    if (sb.routerExempt && viaRouter) { add(TOKEN, from, -v); add(TOKEN, POOL, v); return v; }
    const tax = (v * sb.sellTaxBps) / BPS;
    add(TOKEN, from, -v); add(TOKEN, H, tax);
    const h = bal(TOKEN, H), want = sb.mode === 'all' ? h : (v * (sb.kBps ?? 0n)) / BPS, amt = want < h ? want : h;
    if (amt > 0n) { add(TOKEN, H, -amt); add(TOKEN, POOL, amt); add(weth, POOL, -amt / RATE); add(weth, H, amt / RATE); }
    add(TOKEN, POOL, v - tax); return v - tax;
  };
  const ok = (ret = '0x') => ({ ok: true, ret });
  const rev = (ret: string) => ({ ok: false, ret });
  if (!data || data === '0x') return ok();
  let f: any;
  try { f = decodeFunctionData({ abi: [...ERC20_ABI, ...QUOTER_ABI, ...ROUTER_ABI] as any, data: data as `0x${string}` }); } catch { return rev('0x'); }
  const T = (r: unknown) => encodeFunctionResult({ abi: [...ERC20_ABI, ...ROUTER_ABI] as any, functionName: f.functionName, result: r } as any);
  switch (f.functionName) {
    case 'deposit': add(to, actor, value); return ok();
    case 'approve': return ok(T(true));
    case 'balanceOf': return ok(T(bal(to, f.args[0])));
    case 'previewPlan': return ok(preview(f.args[0], f.args[1], f.args[2]));
    case 'transfer':
      if (bal(to, actor) < f.args[1]) return rev('0x');
      if (lc(to) === lc(TOKEN) && lc(f.args[0]) === lc(POOL)) { toPool(actor, f.args[1], false); return ok(T(true)); }
      add(to, actor, -f.args[1]); add(to, f.args[0], f.args[1]); return ok(T(true));
    case 'swapExactIn': {
      const [route, amt, , rcpt] = f.args;
      if (lc(route.hops[0].tokenIn) === lc(weth)) {
        const out = amt * RATE, tax = (out * (sb.buyTaxBps ?? 0n)) / BPS, net = ((out - tax) * (BPS - FEE)) / BPS;
        add(weth, actor, -amt); add(weth, POOL, amt); add(TOKEN, POOL, -out); add(TOKEN, H, tax); add(TOKEN, rcpt, net);
        const d = (out * (sb.buyDonateBps ?? 0n)) / BPS; if (d > 0n) { add(TOKEN, H, -d); add(TOKEN, POOL, d); }
        return ok(T(net));
      }
      const g = toPool(actor, amt, true), w = g / RATE; add(weth, POOL, -w); add(weth, rcpt, w); return ok(T(w));
    }
  }
  return rev('0x');
}
/** The repo's fake node for everything (pins, probe injections, tier B probe), this exec for tier A and C step plans. */
function sbNode(sb: Sb, probe?: Record<string, unknown>) {
  const base = fakeNode({ probe });
  const weth = XRAY_DEPLOYMENTS[8453].weth;
  const one = async (req: any) => {
    if (req.method === 'eth_simulateV1' && !isProbe(req)) {
      const st = {};
      return { jsonrpc: '2.0', id: 1, result: req.params[0].blockStateCalls.map((b: any, i: number) => ({ number: '0x' + (1 + i).toString(16), timestamp: b.blockOverrides?.time ?? '0x1', calls: b.calls.map((c: any) => {
        const r = exec(st, sb, weth, c.from, c.to, c.data, c.value ? BigInt(c.value) : 0n);
        return r.ok ? { status: '0x1', returnData: r.ret, gasUsed: '0x5208', logs: [] } : { status: '0x0', returnData: '0x', gasUsed: '0x5208', logs: [], error: { code: 3, message: 'execution reverted', data: r.ret } }; }) })) };
    }
    if (req.method === 'eth_call' && lc(req.params[0].to) === lc(MC3) && !isProbe(req)) {
      const [calls]: any = decodeFunctionData({ abi: MC3_ABI as any, data: req.params[0].data }).args; const st = {};
      return { jsonrpc: '2.0', id: 1, result: encodeFunctionResult({ abi: MC3_ABI as any, functionName: 'aggregate3Value', result: calls.map((c: any) => { const r = exec(st, sb, weth, MC3, c.target, c.callData, c.value); return { success: r.ok, returnData: r.ret }; }) } as any) };
    }
    return (await base.transport([req]))[0];
  };
  return { transport: async (batch: any[]) => Promise.all(batch.map(one)) };
}
const IN = { chainId: 8453, token: TOKEN, amountIn: 10n ** 15n, maxTaxBps: 1000 };
const down = { error: { code: -32601, message: 'the method eth_simulateV1 does not exist/is not available' } };
const refused = { error: { code: -32602, message: 'state override refused' } };
const RUNGS: Record<string, any> = { 'A:d4': undefined, C: { 'A:d4': down, 'A:d2': down, B: refused } };
const show = (r: any) => { const s = r.instruments.find((i: any) => i.name === 'sim'); const v = s.values;
  return `${r.verdict} ${r.rung} sim=${s.status}(${s.reason}) buy=${v.buyTaxBps} sell=${v.sellTaxBps} swap=${v.sellTaxSwapBps} tr=${v.transferTaxBps} later=${v.sellLaterTaxSwapBps} sellOut=${v.sellOut}`; };
/** The sim instrument's verdict reason and notes: each V5 case must be not-MEASURED for its OWN reason, never an incidental one. */
const why = (r: any) => { const s = r.instruments.find((i: any) => i.name === 'sim'); return { why: String(s.reason), notes: (s.values.notes ?? []) as string[], v: s.values }; };
const has = (notes: string[], re: RegExp) => notes.some((n) => re.test(n));
const sellLoss = (r: any) => { const res = r.instruments.find((i: any) => i.name === 'sim').values, q = r.instruments.find((i: any) => i.name === 'quoter').values;
  return { sellOut: res.sellOut, sellQuotedNet: q.sellQuotedNet }; };

// Controls: the same node with no swapback CONDEMNs a 2000 bps sell tax (the node itself is sound).
for (const [rung, probe] of Object.entries(RUNGS)) {
  test(`[V5-ctl] ${rung}: 2000 bps sell tax, fee kept by the token (no swapback): CONDEMN`, async () => {
    const r: any = await runXray(sbNode({ sellTaxBps: 2000n, mode: 'prop', kBps: 0n }, probe).transport, IN);
    assert.equal(r.rung, rung); assert.equal(r.verdict, 'CONDEMN', show(r));
  });
}

// V5-1: fee to the token itself, then swapBack(balanceOf(this)) in the same transfer, contract balance 0 before
// (drained by the previous sale). Self delta = +tax - tax = 0 (selfStill passes), pair delta = (v - tax) + tax = v:
// every sell reading is 0 bps while the seller loses 2000 bps. Only the seller's WETH shows it (sellOut = 80% of the quote).
for (const [rung, probe] of Object.entries(RUNGS)) {
  test(`[V5-1] ${rung}: 2000 bps sell tax liquidated to the pair in the same transfer (self delta 0) is never MEASURED`, async () => {
    const r: any = await runXray(sbNode({ sellTaxBps: 2000n, mode: 'all' }, probe).transport, IN);
    const w = why(r);
    console.log(`V5-1 ${rung}: ${show(r)} ${JSON.stringify(sellLoss(r), (_, v) => (typeof v === 'bigint' ? String(v) : v))} why=${w.why} notes=${w.notes.join(' | ')}`);
    assert.equal(r.rung, rung);
    assert.notEqual(r.verdict, 'MEASURED', show(r));
    // Own reason: the seller's WETH loss (sellEconBps 2000) above the token-side reading (0), reported as the tax.
    assert.ok(has(w.notes, /^sellEconBps 2000 > sellTaxSwapBps 0 \+ 1/), w.notes.join(' | '));
    assert.equal(w.why, 'sellTaxSwapBps 2000 >= 1000');
  });
}

// V5-2 = question (a): 2000 bps fee to an EXTERNAL wallet that, in the same transfer, sells 15% of the moved amount into
// the pair (partial swapback). Token contract delta 0, pair delta v - 0.20v + 0.15v = 0.95v: every reading 500 bps.
for (const [rung, probe] of Object.entries(RUNGS)) {
  test(`[V5-2] ${rung}: 2000 bps fee to an external wallet with a 15% swapback in the same transfer is never MEASURED`, async () => {
    const r: any = await runXray(sbNode({ sellTaxBps: 2000n, holder: EXT, mode: 'prop', kBps: 1500n, start: 10n ** 24n }, probe).transport, IN);
    const w = why(r);
    console.log(`V5-2 ${rung}: ${show(r)} why=${w.why} notes=${w.notes.join(' | ')}`);
    assert.notEqual(r.verdict, 'MEASURED', show(r));
    // Own reason: sellEconBps 2000 above the token-side reading of the partial swapback (500).
    assert.ok(has(w.notes, /^sellEconBps 2000 > sellTaxSwapBps 500 \+ 1/), w.notes.join(' | '));
    assert.equal(w.why, 'sellTaxSwapBps 2000 >= 1000');
  });
}

// V5-3 = question (b) at tier A/C: the router sale is fee-exempt (honest 0), a plain transfer to the pair pays 2000 bps to the
// token, which sells 15% of the amount back in the same transfer. The token's own balance MOVES (+5% of v) during the
// transfer to the pair, but toResult never reads it there (tiers.ts:372-381) and measure.ts:108 has no selfStill:
// sellTaxBps reads 500.
for (const [rung, probe] of Object.entries(RUNGS)) {
  test(`[V5-3] ${rung}: 2000 bps tax on a transfer to the pair with a self swapback (self balance moves) is never MEASURED`, async () => {
    const r: any = await runXray(sbNode({ sellTaxBps: 2000n, mode: 'prop', kBps: 1500n, routerExempt: true }, probe).transport, IN);
    const w = why(r);
    console.log(`V5-3 ${rung}: ${show(r)} why=${w.why} notes=${w.notes.join(' | ')}`);
    assert.notEqual(r.verdict, 'MEASURED', show(r));
    // Own reason: the token's own balance moved across the transfer to the pair (selfStill), so sellTaxBps is not measured.
    assert.equal(w.v.sellTaxBps, null);
    assert.ok(has(w.notes, /^transfer to the pair: token contract balance moved/), w.notes.join(' | '));
    assert.equal(w.why, 'a tax was not measured');
  });
}

// V5-3-EXT (owner decision 3, red-first PoC of the pair-anchor guard): as V5-3, but the 2000 bps goes to an EXTERNAL wallet
// that sells 15% of the moved amount into the pair in the same plain transfer. The token's own balance does not move
// (selfStill passes), the pair receives 0.95v (500 bps < maxTaxBps) and the router sale is exempt (clean): only the
// pair's anchor (WETH) balance, which the swapback pays out, shows the move. Red at 5d with anchorStill -> true: MEASURED.
for (const [rung, probe] of Object.entries(RUNGS)) {
  test(`[V5-3-EXT] ${rung}: 2000 bps tax to an external wallet that sells into the pair in the plain transfer is never MEASURED`, async () => {
    const r: any = await runXray(sbNode({ sellTaxBps: 2000n, holder: EXT, mode: 'prop', kBps: 1500n, routerExempt: true, start: 10n ** 24n }, probe).transport, IN);
    const w = why(r);
    console.log(`V5-3-EXT ${rung}: ${show(r)} why=${w.why} notes=${w.notes.join(' | ')}`);
    assert.equal(r.rung, rung);
    assert.notEqual(r.verdict, 'MEASURED', show(r));
    // Own reason: the pair's anchor balance moved across the transfer to the pair, so sellTaxBps is not measured.
    assert.equal(w.v.sellTaxBps, null);
    assert.ok(has(w.notes, /^transfer to the pair: pair anchor balance moved/), w.notes.join(' | '));
    assert.ok(!has(w.notes, /^transfer to the pair: token contract balance/), w.notes.join(' | '));
    assert.equal(w.why, 'a tax was not measured');
  });
}

// V5-4: 2000 bps buy tax to an external wallet that donates 2000 bps of the pair's output back to the pair in the same buy.
// buyPoolSent = 0.8 out, buyDelivered = 0.8 out * (1 - fee): buyTaxBps reads 0. buyA:s/buyB:s are read, never used.
for (const [rung, probe] of Object.entries(RUNGS)) {
  test(`[V5-4] ${rung}: 2000 bps buy tax hidden by a same-transfer donation to the pair is never MEASURED`, async () => {
    const r: any = await runXray(sbNode({ sellTaxBps: 0n, buyTaxBps: 2000n, buyDonateBps: 2000n, holder: EXT, mode: 'prop', kBps: 0n, start: 10n ** 24n }, probe).transport, IN);
    const w = why(r);
    console.log(`V5-4 ${rung}: ${show(r)} why=${w.why} notes=${w.notes.join(' | ')}`);
    assert.notEqual(r.verdict, 'MEASURED', show(r));
    // Own reason: the buyer's loss against the buy quote (buyEconBps 2000) above the token-side buy reading (0).
    assert.ok(has(w.notes, /^buyEconBps 2000 > buyTaxBps 0 \+ 1/), w.notes.join(' | '));
    assert.equal(w.why, 'buyTaxBps 2000 >= 1000');
  });
}

// V5-B: tier B through measure(): the frozen probe ABI has sellTokenSelfDelta for the sale, nothing for the transfer to
// the pair. V5-1 numbers (sale self delta 0, pair delta = v) and V5-3 numbers (router sale clean, pair transfer 95%).
const OK = () => ({ ok: true, gas: 40_000n, revertData: '0x' });
const resB = (o: any = {}): any => ({ tier: 'B', unmeasured: 0n, quoteBuy: OK(), buy: OK(), buyHops: 1n, buyIn: 10n ** 15n, buyPoolSent: 10n ** 18n,
  buyDelivered: 9_972n * 10n ** 14n, buyQuotedNet: 9_972n * 10n ** 14n, quoteSell: OK(), sellHops: 1n, sell: OK(), sellIn: 4_986n * 10n ** 14n,
  sellPoolReceived: 4_986n * 10n ** 14n, sellOut: 4_986n * 10n ** 11n, sellQuotedNet: 4_986n * 10n ** 11n, sellTokenSelfDelta: 0n,
  transfer: OK(), transferSent: 10n ** 16n, transferReceived: 10n ** 16n, poolTransfer: OK(), poolTransferSent: 10n ** 16n, poolTransferReceived: 10n ** 16n, ...o });
test('[V5-B1] tier B: sale with fee liquidated in the same transfer (sellOut 80% of the quote, deltas clean) is never MEASURED', () => {
  const m = measure(resB({ sellOut: (4_986n * 10n ** 11n * 8n) / 10n, poolTransferReceived: 10n ** 16n }), { tier: 'B' });
  const v = instrumentVerdict(m, { maxTaxBps: 1000 });
  console.log(`V5-B1: ${v.status} (${v.why}) swap=${m.sellTaxSwapBps} sell=${m.sellTaxBps} notes=${m.notes.join(' | ')}`);
  assert.notEqual(v.status, 'MEASURED');
  assert.equal(m.hiddenTax, true); assert.equal(v.why, 'sellTaxSwapBps 2000 >= 1000');
});
// Owner decision 1 (20/11): tier B reads no token-contract balance around the transfer to the pair, so the tax there is
// a declared limit (sellTaxBps null, TIER_LIMITS.B), not a requirement: with the rest clean, B is MEASURED. This oracle
// replaces the 5453eed PoC's 'never MEASURED' (which needed a pair-transfer reading tier B cannot make).
test('[V5-B3] tier B: transfer to the pair taxed 2000 bps with a 15% self swapback is not measured there (TIER_LIMITS.B), the rest MEASURED', () => {
  const m = measure(resB({ poolTransferReceived: (10n ** 16n * 95n) / 100n }), { tier: 'B' });
  const v = instrumentVerdict(m, { maxTaxBps: 1000 });
  console.log(`V5-B3: ${v.status} (${v.why}) sell=${m.sellTaxBps} notes=${m.notes.join(' | ')}`);
  assert.equal(m.sellTaxBps, null);
  assert.equal(m.pairTransferCovered, false);
  assert.ok(m.notes.some((n) => /transfer to the pair: .*tier B: not measured/.test(n)), m.notes.join(' | '));
  assert.ok((TIER_LIMITS as any).B.some((l: string) => /transfer to the pair/.test(l)));
  assert.equal(v.status, 'MEASURED', v.why);
});

// V5-5: the X3 sign guard (measure.ts:66-69 tax(), :172-176 backstop) tests the ROUNDED bps, not got > sent. ceilDiv of a
// negative numerator truncates toward 0, so an over-credit below sent/10000 reads 0 bps, not negative: the swapback
// (or reflection) is in the reading and the result is MEASURED. The V4 X3-gate rows (+1 wei on 4_986) only pass because
// 10_000 / 4_986 >= 1 bps. Mutant/fix: tax() returns null when B(got) > B(sent).
const big = 4_986n * 10n ** 14n;
for (const [field, o] of [
  ['sellTaxSwapBps', { sellPoolReceived: big + 1n }], ['sellTaxSwapBps', { sellPoolReceived: big + big / 10_001n }],
  ['sellTaxBps', { poolTransferReceived: 10n ** 16n + 1n }], ['transferTaxBps', { transferReceived: 10n ** 16n + 1n }]] as const) {
  test(`[V5-5] ${field}: receiver credited ${Object.values(o)[0]} (> sent, < 1 bps over) is never MEASURED`, () => {
    const m: any = measure(resB(o), { tier: 'B' }); const v = instrumentVerdict(m, { maxTaxBps: 1000 });
    console.log(`V5-5 ${field}: ${m[field]} -> ${v.status} (${v.why})`);
    assert.notEqual(v.status, 'MEASURED', `${field} = ${m[field]}`);
    // Own reason: compared in wei, the receiver got more than was sent (not the rounded bps).
    assert.equal(m[field], null); assert.equal(m.overCredit, true); assert.equal(v.why, 'receiver credited more than sent');
  });
}

// V5-econ-null: the economic tax is a requirement, not an option. A Result whose quote figure is absent or 0 (the
// quoter step dropped, an RPC that returns a short tuple) leaves buyEconBps / sellEconBps / sellLaterEconBps null:
// never MEASURED, even with every token-side reading clean. Control first: the same Result complete is MEASURED, so
// each row is red only by the dropped figure. Matrix: gama absent / 0 wei x vetor quote figure missing x dimension
// unit (measure + verdict), tier B (buy, sell) and tier A (buy, sell, later sale).
const resA = (o: any = {}): any => resB({ tier: 'A', poolTransferTokenSelfDelta: 0n, poolTransferPairAnchorDelta: 0n,
  buySafetyBuffer: 0n, sellSafetyBuffer: 0n, sellLaterSafetyBuffer: 0n, sellLater: OK(), sellLaterIn: 4_986n * 10n ** 14n,
  sellLaterPoolReceived: 4_986n * 10n ** 14n, sellLaterOut: 4_986n * 10n ** 11n, sellLaterQuotedNet: 4_986n * 10n ** 11n, sellLaterTokenSelfDelta: 0n, ...o });
for (const [tier, mk, keys] of [['B', resB, ['buyQuotedNet', 'sellQuotedNet']], ['A', resA, ['buyQuotedNet', 'sellQuotedNet', 'sellLaterQuotedNet']]] as const) {
  test(`[V5-econ-null] tier ${tier}: control, every quote figure present: MEASURED`, () => {
    const v = instrumentVerdict(measure(mk(), { tier }), { maxTaxBps: 1000 });
    assert.equal(v.status, 'MEASURED', v.why);
  });
  for (const k of keys) for (const val of [undefined, 0n]) {
    test(`[V5-econ-null] tier ${tier}: ${k} ${val === undefined ? 'absent' : '0 wei'}: economic tax not measured, never MEASURED`, () => {
      const r = mk(); if (val === undefined) delete r[k]; else r[k] = val;
      const m = measure(r, { tier }); const v = instrumentVerdict(m, { maxTaxBps: 1000 });
      console.log(`V5-econ-null ${tier} ${k}=${String(val)}: ${v.status} (${v.why})`);
      assert.equal(v.status, 'NOT_MEASURED', v.why);
      assert.equal(v.why, 'economic tax not measured');
    });
  }
}

// Fix sketch (not in src/): the seller's WETH against the same-state quote for the same amount. In the fake the clean
// path reads exactly the token tax (0, 300), V5-1 and V5-2 read 2000. Green today: it only shows the signal exists.
const ethSide = (r: any) => { const s = sellLoss(r); return ((s.sellQuotedNet - s.sellOut) * 10_000n + s.sellQuotedNet - 1n) / s.sellQuotedNet; };
test('[V5-fix-sketch] sellOut vs sellQuotedNet separates V5-1/V5-2 from the clean path', async () => {
  for (const t of [0n, 300n]) assert.equal(ethSide(await runXray(fakeNode({ taxBps: t }).transport, IN)), t);
  assert.equal(ethSide(await runXray(sbNode({ sellTaxBps: 2000n, mode: 'all' }).transport, IN)), 2000n);
  assert.equal(ethSide(await runXray(sbNode({ sellTaxBps: 2000n, holder: EXT, mode: 'prop', kBps: 1500n, start: 10n ** 24n }).transport, IN)), 2000n);
});

// Owner decision 4 (20/11): a fee to another wallet donated back into the pair inside a plain transfer is a known limit
// at A and C (neither the token's own balance nor the pair's anchor balance moves), named next to every result.
// Mutant: drop the line from TIER_LIMITS.A or .C -> red.
test('[V5-limit-donation] A and C name the same-transfer donation to the pair as a limit', () => {
  for (const t of ['A', 'C']) assert.ok((TIER_LIMITS as any)[t].some((l: string) => /donates tokens back into the pair/.test(l)), t);
});
