// Tiers A (eth_simulateV1, EOA sender) and C (plain eth_call, Multicall3 as the actor) of the own
// honeypot instrument. SANS-IO: prepare*() returns exact JSON-RPC requests, decode*() turns the
// responses into the SAME shape as the XRayProbe Result (deep-xray/sim/XRayProbe.sol:96-125), so the
// one measuring function (deep-xray/core/measure.mjs) reads all tiers. No ratio is computed here.
// Port of deep-xray-tiers@1998a4d core/tiers.mjs. Changes: classifyProbe/classifyToken read the reply through
// classifyRpcReply (rpc.ts, decision (c): an HTTP 4xx JSON-RPC error body is that error); tierVerdict is a meet().
import { encodeFunctionData, decodeFunctionResult } from 'viem';
import { QUOTER_ABI, ROUTER_ABI, ERC20_ABI, MC3_ABI, MC3, PROBE } from './abi.js';
import { classifyRpcReply } from './rpc.js';
import { meet, type Verdict } from './lattice.js';

export const TIER_ORDER = ['A', 'B', 'C']; // most faithful first
export const KIND_V4 = 4;
const BPS = 10_000n;
const UM: any = { BAL_X: 1n, POOL_BUY: 2n, POOL_SELL: 4n, BAL_Y: 8n, SELF: 16n, WETH: 32n }; // XRayProbe.sol:127-132
const hex = (n: any) => '0x' + BigInt(n).toString(16);
const lc = (a: any) => String(a).toLowerCase();

// ---------------------------------------------------------------- tier selection (by a token-independent PROBE)
/**
 * Rungs, most faithful first. A:d4 = simulateV1 with the measured block overrides (prevRandao, feeRecipient,
 * time, gasLimit), A:d2 = simulateV1 without them, B = eth_call + code override, C = plain eth_call.
 * Decision 12: the rung is chosen ONLY by a probe with the rung's request shape and a trivial target
 * (1 wei from the fresh sender to Y). An answer to a token call never moves the rung.
 */
export const LADDER = ['A:d4', 'A:d2', 'B', 'C'];
/** Classes a tier cannot cover by construction (reported next to every result as `uncovered`). */
const UNC_B = ['a6', 'a8', 'b2', 'e1', 'i3'];
export const TIER_UNCOVERED: any = { A: [], B: UNC_B, C: [...UNC_B, 'a1', 'a7'] };
const UNAVAIL: any = { cls: 'unavailable', why: 'provider unavailable' };
/**
 * Probe answer -> ok | reverted | down | unavailable. Rate limit / transport / non-JSON is "provider
 * unavailable" (never a step-down). An executed revert of a 1-wei transfer is a node anomaly: NOT_MEASURED
 * "probe reverted". Any other error, or an answer of the wrong shape, steps down one rung.
 */
export function classifyProbe(tier: any, resp: any) {
  const k = classifyRpcReply(resp);
  if (k.cls === 'unavailable') return { ...UNAVAIL };
  const pe: any = k.cls === 'error' ? { code: k.code, data: k.data } : {};
  if (k.cls === 'result' && k.result !== null) {
    const r: any = k.result;
    if (tier === 'A') {
      const c = Array.isArray(r) ? r[0]?.calls?.[0] : undefined;
      if (c?.status === '0x1') return { cls: 'ok' };
      if (c?.status === '0x0') return { cls: 'reverted', why: 'probe reverted' };
      return { cls: 'down', code: null, why: 'probe answer shape' };
    }
    if (typeof r !== 'string') return { cls: 'down', code: null, why: 'probe answer shape' };
    if (tier === 'B') return { cls: 'ok' };
    let rs;
    try { rs = decodeFunctionResult({ abi: MC3_ABI, functionName: 'aggregate3Value', data: r as `0x${string}` }); } catch { rs = null; }
    if (!rs || rs.length !== 1) return { cls: 'down', code: null, why: 'probe answer shape' };
    return rs[0].success ? { cls: 'ok' } : { cls: 'reverted', why: 'probe reverted' };
  }
  if (pe.code === 3 || pe.data !== undefined) return { cls: 'reverted', why: 'probe reverted' };
  return { cls: 'down', code: pe.code ?? null, why: `probe error ${pe.code ?? '?'}` };
}

/** First rung not asked yet, the first rung whose probe ran, or NOT_MEASURED. No chainId table. */
export function selectTier(answers: any) {
  for (const rung of LADDER) {
    if (answers[rung] === undefined) return { rung, status: 'ask' };
    const c = classifyProbe(rung[0], answers[rung]);
    if (c.cls === 'ok') return { rung, status: 'run' };
    if (c.cls !== 'down') return { rung: null, status: 'NOT_MEASURED', why: c.why };
  }
  return { rung: null, status: 'NOT_MEASURED', why: 'no tier answered' };
}

/** A token-call answer: ok, or not measured with the raw code. Never a step-down (decision 12). */
export function classifyToken(resp: any) {
  const k = classifyRpcReply(resp);
  if (k.cls === 'result' && k.result !== null) return { cls: 'ok' };
  if (k.cls === 'unavailable') return { cls: 'not-measured', code: resp?.httpStatus ?? null, why: 'provider unavailable' + (resp?.httpStatus ? ' (http ' + resp.httpStatus + ')' : '') };
  const e: any = k.cls === 'error' ? k : {};
  return { cls: 'not-measured', code: e.code ?? null, why: `error ${e.code ?? '?'}: ${String(e.message ?? '').toLowerCase().slice(0, 80)}` };
}

/** Tier A retries by CODE, each once: -38021 (timestamps out of order) -> node clock; -38013 (intrinsic gas) -> l1gas. */
export function aRetry(res: any, done: any) {
  if (res?.status !== 'NOT_MEASURED') return null;
  if (res.code === -38021 && !done.includes('nodeclock')) return 'nodeclock';
  if (res.code === -38013 && !done.includes('l1gas')) return 'l1gas';
  return null;
}

/**
 * Verdict over the tiers that actually ran. A tier that is missing (unsupported, not measured) is
 * never read as a value: with none present the result is WARN (not measured). With several, the
 * infimum by meet() (lattice.ts, the one producer): a weaker tier that condemns wins over a stronger one
 * that measured; a value outside the lattice reads WARN. The tier names travel with the verdict.
 */
export function tierVerdict(perTier: Record<string, unknown>) {
  const ran = TIER_ORDER.filter((t) => Object.hasOwn(perTier, t) && perTier[t] !== undefined && perTier[t] !== null);
  if (ran.length === 0) return { v: 'WARN' as Verdict, why: 'not measured: no tier ran', tiers: [] as string[] };
  let v: Verdict = 'MEASURED';
  for (const t of ran) v = meet(v, perTier[t]);
  return { v, why: `infimum over tiers ${ran.join(',')}`, tiers: ran, best: ran[0] };
}

// ---------------------------------------------------------------- the step plan (shared by A and C)
const bal = (token: any, who: any) => encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [who] });
const approve = (spender: any, v: any) => encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, v] });
const transfer = (to: any, v: any) => encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, v] });
const quote = (tIn: any, tOut: any, v: any) => encodeFunctionData({ abi: QUOTER_ABI, functionName: 'previewPlan', args: [tIn, tOut, v] });
const swap = (route: any, v: any, to: any, deadline: any) => encodeFunctionData({ abi: ROUTER_ABI, functionName: 'swapExactIn', args: [route, v, 1n, to, deadline] });

/** Distinct non-V4 pools of one hop (a V4 leg keeps its tokens in the PoolManager: unmeasured). */
export function hopPools(legs: any) {
  const out: any[] = []; let v4 = false;
  for (const l of legs) { if (Number(l.kind) === KIND_V4) { v4 = true; continue; } if (!out.some((p: any) => lc(p) === lc(l.pool))) out.push(l.pool); }
  return { pools: out, v4 };
}

function snap(tag: any, ctx: any, X: any, pools: any, blk: any) {
  const s = [{ id: `${tag}:x`, blk, to: ctx.token, data: bal(ctx.token, X), kind: 'read' },
    { id: `${tag}:w`, blk, to: ctx.weth, data: bal(ctx.weth, X), kind: 'read' },
    { id: `${tag}:s`, blk, to: ctx.token, data: bal(ctx.token, ctx.token), kind: 'read' }];
  pools.forEach((p: any, i: any) => s.push({ id: `${tag}:p${i}`, blk, to: ctx.token, data: bal(ctx.token, p), kind: 'read' }));
  return s;
}

/**
 * The ordered steps for what is known so far. `X` is the actor (A: fresh EOA; C: Multicall3).
 * Blocks: 1 wrap+approve+quote; 2 buy; 3 approve+quote+sell; 4 transfers; L sell later (A only).
 * The sequence and the amounts follow XRayProbe.probe() (XRayProbe.sol:134-175) so the Δ match.
 */
export function planSteps(ctx: any, known: any, tier: any) {
  const X = tier === 'C' ? MC3 : ctx.X;
  const st: any[] = [];
  st.push({ id: 'wrap', blk: 1, to: ctx.weth, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'deposit' }), value: ctx.buyIn, kind: 'call' });
  st.push({ id: 'approveIn', blk: 1, to: ctx.weth, data: approve(ctx.router, ctx.buyIn), kind: 'bool' });
  st.push({ id: 'quoteBuy', blk: 1, to: ctx.quoter, data: quote(ctx.weth, ctx.token, ctx.buyIn), kind: 'quote' });
  if (!known.routeBuy) return st;
  const bp = hopPools(known.routeBuy.hops[known.routeBuy.hops.length - 1].legs);
  st.push(...snap('buyA', ctx, X, bp.pools, 2));
  st.push({ id: 'buy', blk: 2, to: ctx.router, data: swap(known.routeBuy, ctx.buyIn, X, ctx.deadline), kind: 'call' });
  st.push(...snap('buyB', ctx, X, bp.pools, 2));
  if (known.sellAmt === undefined || known.sellAmt === 0n) return st;
  st.push({ id: 'approveOut', blk: 3, to: ctx.token, data: approve(ctx.router, known.sellAmt), kind: 'bool' });
  st.push({ id: 'quoteSell', blk: 3, to: ctx.quoter, data: quote(ctx.token, ctx.weth, known.sellAmt), kind: 'quote' });
  if (!known.routeSell) return st;
  const sp = hopPools(known.routeSell.hops[0].legs);
  st.push(...snap('sellA', ctx, X, sp.pools, 3));
  st.push({ id: 'sell', blk: 3, to: ctx.router, data: swap(known.routeSell, known.sellAmt, X, ctx.deadline), kind: 'call' });
  st.push(...snap('sellB', ctx, X, sp.pools, 3));
  if (known.left === undefined) return st;
  if (known.tAmt > 0n) {
    st.push({ id: 'tr:x0', blk: 4, to: ctx.token, data: bal(ctx.token, X), kind: 'read' }, { id: 'tr:y0', blk: 4, to: ctx.token, data: bal(ctx.token, ctx.Y), kind: 'read' });
    st.push({ id: 'transfer', blk: 4, to: ctx.token, data: transfer(ctx.Y, known.tAmt), kind: 'bool' });
    st.push({ id: 'tr:x1', blk: 4, to: ctx.token, data: bal(ctx.token, X), kind: 'read' }, { id: 'tr:y1', blk: 4, to: ctx.token, data: bal(ctx.token, ctx.Y), kind: 'read' });
  }
  if (known.pAmt > 0n && known.poolTransferTo) {
    const P = known.poolTransferTo;
    st.push({ id: 'pt:x0', blk: 4, to: ctx.token, data: bal(ctx.token, X), kind: 'read' }, { id: 'pt:y0', blk: 4, to: ctx.token, data: bal(ctx.token, P), kind: 'read' });
    st.push({ id: 'poolTransfer', blk: 4, to: ctx.token, data: transfer(P, known.pAmt), kind: 'bool' });
    st.push({ id: 'pt:x1', blk: 4, to: ctx.token, data: bal(ctx.token, X), kind: 'read' }, { id: 'pt:y1', blk: 4, to: ctx.token, data: bal(ctx.token, P), kind: 'read' });
  }
  st.push({ id: 'rem', blk: 4, to: ctx.token, data: bal(ctx.token, X), kind: 'read' });
  if (tier !== 'A' || known.rem === undefined || known.rem === 0n) return st;
  st.push({ id: 'approveLater', blk: 5, to: ctx.token, data: approve(ctx.router, known.rem), kind: 'bool' });
  st.push({ id: 'quoteLater', blk: 5, to: ctx.quoter, data: quote(ctx.token, ctx.weth, known.rem), kind: 'quote' });
  if (!known.routeLater) return st;
  const lp = hopPools(known.routeLater.hops[0].legs);
  st.push(...snap('lateA', ctx, X, lp.pools, 5));
  st.push({ id: 'sellLater', blk: 5, to: ctx.router, data: swap(known.routeLater, known.rem, X, ctx.laterDeadline), kind: 'call' });
  st.push(...snap('lateB', ctx, X, lp.pools, 5));
  return st;
}

// ---------------------------------------------------------------- requests (every one pinned to ctx.block)
const GAS: any = { read: 300_000n, bool: 400_000n, call: 3_000_000n, quote: 8_000_000n };
export function stepGas(s: any) { return s.id === 'wrap' ? 150_000n : GAS[s.kind]; }

/** Tier A: one eth_simulateV1 request. validation=true; every call carries gas and a fee (never fee-less). */
export function prepareA(ctx: any, known: any, id: any = 1) {
  const steps = planSteps(ctx, known, 'A');
  const blocks: any[] = [];
  for (const s of steps) {
    let b = blocks.find((x: any) => x.k === s.blk);
    if (!b) { b = { k: s.blk, calls: [] }; blocks.push(b); }
    const c: any = { from: ctx.X, to: s.to, data: s.data, gas: hex(ctx.gas === 'l1gas' ? l1Gas(ctx.gasLimit, steps.length) : stepGas(s)), maxFeePerGas: hex(ctx.fee.maxFee), maxPriorityFeePerGas: hex(ctx.fee.prio) };
    if (s.value) c.value = hex(s.value);
    b.calls.push(c);
  }
  const out = blocks.map((b: any, i: any) => {
    const o: any = { calls: b.calls };
    const bo = ctx.blockOverrides?.(b.k);
    if (bo) o.blockOverrides = bo;
    // Later block: the simulator fills the N-block gap with empty blocks whose base fee decays 12.5 %/block (~32 wei
    // at N=100); on Nitro the L1 poster gas (L1 cost / base fee) then exceeds any call gas (-38013). The later sell
    // runs at the pinned block's real base fee (deep-xray-tiers 6191343; measured live/nitro-later.mjs, 42161 and 4663).
    if (bo?.number) o.blockOverrides = { ...bo, baseFeePerGas: hex(ctx.block.baseFee) };
    if (i === 0) o.stateOverrides = { [ctx.X]: { balance: hex(ctx.xBalance) } };
    return o;
  });
  return { steps, req: { jsonrpc: '2.0', id, method: 'eth_simulateV1', params: [{ blockStateCalls: out, validation: true, traceTransfers: false }, hex(ctx.block.number)] } };
}

/** Tier C: one eth_call of Multicall3.aggregate3Value, from an address holding ETH, no overrides, pinned by hash. */
export function prepareC(ctx: any, known: any, id: any = 1) {
  const steps = planSteps(ctx, known, 'C');
  const calls = steps.map((s: any) => ({ target: s.to, allowFailure: true, value: s.value ?? 0n, callData: s.data }));
  const data = encodeFunctionData({ abi: MC3_ABI, functionName: 'aggregate3Value', args: [calls] });
  const gas = steps.reduce((a: any, s: any) => a + stepGas(s), 0n);
  return { steps, req: { jsonrpc: '2.0', id, method: 'eth_call', params: [{ from: ctx.funder, to: MC3, value: hex(ctx.buyIn), data, gas: hex(gas), gasPrice: hex(ctx.fee.gasPrice) }, { blockHash: ctx.block.hash }] } };
}

/** Tier B: the pinned XRayProbe runtime injected at a fresh X (as deep-xray/live/probeB.mjs), same block, fee-carrying. */
export const GAS_B = 30_000_000n;
/** Nitro charges L1 gas inside the call gas (-38013 under a fixed 300k): one bound per call, never above GAS_B. */
export function l1Gas(gasLimit: any, n: any) { const g = BigInt(gasLimit) / BigInt(n); return g < GAS_B ? g : GAS_B; }
export function prepareB(ctx: any, X: any, id: any = 1) {
  const params: any = { router: ctx.router, quoter: ctx.quoter, weth: ctx.weth, token: ctx.token, buyIn: ctx.buyIn, sellFracBps: ctx.sellFracBps,
    transferFracBps: ctx.transferFracBps, transferTo: ctx.Y, poolFracBps: ctx.poolFracBps, gasCap: 0n };
  const data = encodeFunctionData({ abi: PROBE.abi, functionName: 'probe', args: [params] });
  return { req: { jsonrpc: '2.0', id, method: 'eth_call', params: [{ from: X, to: X, data, gas: hex(GAS_B), gasPrice: hex(ctx.fee.gasPrice) },
    { blockHash: ctx.block.hash }, { [X]: { code: PROBE.runtime, balance: hex(ctx.buyIn + GAS_B * ctx.fee.gasPrice * 2n) } }] } };
}

/**
 * The probe of a rung (decision 12): the SAME request shape as the rung's real calls (method, override
 * kinds, pinned block, gas, fee keys) with a trivial target, 1 wei from the fresh sender to Y. Overrides
 * and gas are taken from the rung's own first request (one producer). Gas = the largest call gas of the rung.
 */
export function prepareProbe(rung: any, ctx: any, id: any = 1) {
  const tier = rung[0];
  if (tier === 'A') {
    const real = (prepareA(ctx, {}).req.params[0] as any).blockStateCalls;
    const gmax = real.flatMap((b: any) => b.calls).reduce((m: any, c: any) => (BigInt(c.gas) > m ? BigInt(c.gas) : m), 0n);
    const b0: any = { calls: [{ from: ctx.X, to: ctx.Y, data: '0x', value: '0x1', gas: hex(gmax), maxFeePerGas: hex(ctx.fee.maxFee), maxPriorityFeePerGas: hex(ctx.fee.prio) }] };
    if (real[0].blockOverrides) b0.blockOverrides = real[0].blockOverrides;
    b0.stateOverrides = real[0].stateOverrides;
    const pin = hex(ctx.block.number);
    return { req: { jsonrpc: '2.0', id, method: 'eth_simulateV1', params: [{ blockStateCalls: [b0], validation: true, traceTransfers: false }, pin] } };
  }
  if (tier === 'B') {
    return { req: { jsonrpc: '2.0', id, method: 'eth_call', params: [{ from: ctx.X, to: ctx.Y, value: '0x1', gas: hex(GAS_B), gasPrice: hex(ctx.fee.gasPrice) },
      { blockHash: ctx.block.hash }, { [ctx.X]: { code: PROBE.runtime, balance: hex(ctx.buyIn + GAS_B * ctx.fee.gasPrice * 2n) } }] } };
  }
  const cd = encodeFunctionData({ abi: MC3_ABI, functionName: 'aggregate3Value', args: [[{ target: ctx.Y, allowFailure: true, value: 1n, callData: '0x' }]] });
  const cg = prepareC(ctx, {}).req.params[0].gas;
  return { req: { jsonrpc: '2.0', id, method: 'eth_call', params: [{ from: ctx.funder, to: MC3, value: '0x1', data: cd, gas: cg, gasPrice: hex(ctx.fee.gasPrice) }, { blockHash: ctx.block.hash }] } };
}

// ---------------------------------------------------------------- decoding
/** Per-step results {ok, gas|null, ret} keyed by step id; null when the top-level answer is not usable. */
export function decodeA(steps: any, resp: any) {
  if (!Array.isArray(resp?.result)) return null;
  const flat = resp.result.flatMap((b: any) => b.calls ?? []);
  if (flat.length !== steps.length) return null;
  const m: any = {};
  steps.forEach((s: any, i: any) => {
    const c = flat[i]; const ok = c.status === '0x1';
    // Some clients put the revert payload in error.data and leave returnData empty: take whichever carries bytes.
    const ret = !ok && (!c.returnData || c.returnData === '0x') && typeof c.error?.data === 'string' ? c.error.data : (c.returnData ?? '0x');
    m[s.id] = { ok, gas: c.gasUsed ? BigInt(c.gasUsed) : null, ret, ...(ok ? {} : { errMsg: String(c.error?.message ?? '').slice(0, 120) }) };
  });
  const H = ['number', 'timestamp', 'baseFeePerGas', 'gasLimit', 'miner', 'mixHash', 'difficulty', 'extraData', 'l1BlockNumber', 'sendCount', 'sendRoot', 'nonce', 'blobGasUsed', 'excessBlobGas'];
  const pick = (b: any) => Object.fromEntries(H.filter((k: any) => b[k] !== undefined).map((k: any) => [k, b[k]]));
  m._blocks = { count: resp.result.length, withCalls: resp.result.filter((b: any) => (b.calls ?? []).length).map(pick), first: pick(resp.result[0]), last: pick(resp.result[resp.result.length - 1]) };
  return m;
}
export function decodeC(steps: any, resp: any) {
  if (typeof resp?.result !== 'string' || resp.result === '0x') return null;
  let rs;
  try { rs = decodeFunctionResult({ abi: MC3_ABI, functionName: 'aggregate3Value', data: resp.result }); } catch { return null; }
  if (rs.length !== steps.length) return null;
  const m: any = {};
  steps.forEach((s: any, i: any) => { m[s.id] = { ok: rs[i].success, gas: null, ret: rs[i].returnData }; });
  return m;
}

const u256 = (r: any) => (r && r.ok && r.ret && r.ret.length >= 66 ? BigInt(r.ret.slice(0, 66)) : null);
const boolOk = (r: any) => { if (!r?.ok) return false; if (!r.ret || r.ret === '0x') return true; if (r.ret.length < 66) return false; return BigInt(r.ret.slice(0, 66)) === 1n; }; // XRayProbe.sol:310-314
function quoteOf(r: any) {
  if (!r?.ok) return null;
  try { const [pv] = (decodeFunctionResult as any)({ abi: QUOTER_ABI, functionName: 'previewPlan', data: r.ret }); return pv; } catch { return null; }
}

/** Steps present in both rounds must answer identically: otherwise the timeline is not reproducible. */
export function consistent(prev: any, cur: any) {
  if (!prev) return true;
  for (const k of Object.keys(prev)) { if (k.startsWith('_')) continue; if (!cur[k]) return false; if (cur[k].ok !== prev[k].ok || cur[k].ret !== prev[k].ret) return false; }
  return true;
}

/** Fold one round's answers into what is known; returns { known, done, why }. Amounts as XRayProbe. */
export function advance(ctx: any, known: any, m: any, tier: any) {
  const k: any = { ...known };
  if (!k.routeBuy) {
    const pv = quoteOf(m.quoteBuy);
    if (!pv || !pv.canExecute || pv.route.hops.length === 0) return { known: k, done: true, why: 'no buy route' };
    k.routeBuy = pv.route; return { known: k, done: false };
  }
  if (k.sellAmt === undefined) {
    if (!m.buy?.ok) return { known: k, done: true, why: 'buy reverted' };
    const held = u256(m['buyB:x']);
    if (held === null) return { known: k, done: true, why: 'balance after buy not measured' };
    k.sellAmt = (held * ctx.sellFracBps) / BPS;
    return { known: k, done: k.sellAmt === 0n, why: k.sellAmt === 0n ? 'nothing to sell' : undefined };
  }
  if (!k.routeSell) {
    const pv = quoteOf(m.quoteSell);
    if (!pv || !pv.canExecute || pv.route.hops.length === 0) return { known: k, done: true, why: 'no sell route' };
    k.routeSell = pv.route;
    const first = pv.route.hops[0].legs.find((l: any) => Number(l.kind) !== KIND_V4);
    k.poolTransferTo = first ? first.pool : null;
    return { known: k, done: false };
  }
  if (k.left === undefined) {
    const left = u256(m['sellB:x']);
    if (left === null) return { known: k, done: true, why: m.sell?.ok ? 'balance after sell not measured' : 'sell reverted' };
    k.left = left; k.tAmt = (left * ctx.transferFracBps) / BPS; k.pAmt = (left * ctx.poolFracBps) / BPS;
    return { known: k, done: false };
  }
  if (k.rem === undefined) {
    const rem = u256(m.rem);
    k.rem = rem === null ? 0n : rem;
    return { known: k, done: tier !== 'A' || k.rem === 0n, why: tier !== 'A' ? 'tier C: no later sell' : undefined };
  }
  if (!k.routeLater) {
    const pv = quoteOf(m.quoteLater);
    if (!pv || !pv.canExecute || pv.route.hops.length === 0) return { known: k, done: true, why: 'no later sell route' };
    k.routeLater = pv.route; return { known: k, done: false };
  }
  return { known: k, done: true };
}

function step(r: any) { return r ? { ok: !!r.ok, gas: r.gas, revertData: r.ok ? '0x' : (r.ret ?? '0x').slice(0, 2 + 512), ...(r.errMsg ? { errMsg: r.errMsg } : {}) } : { ok: false, ran: false, gas: null, revertData: '0x' }; }
function snapVals(m: any, tag: any) {
  const x = u256(m[`${tag}:x`]), w = u256(m[`${tag}:w`]), s = u256(m[`${tag}:s`]);
  let pools = 0n, okP = true, i = 0;
  for (; m[`${tag}:p${i}`]; i++) { const v = u256(m[`${tag}:p${i}`]); if (v === null) okP = false; else pools += v; }
  return { x, w, s, pools, okP, n: i };
}

/** The XRayProbe Result shape (field names identical), plus sellLater* for tier A. */
export function toResult(ctx: any, known: any, m: any, tier: any) {
  const r: any = { tier, wrap: step(m.wrap), approveIn: step(m.approveIn), quoteBuy: step(m.quoteBuy), buy: step(m.buy), approveOut: step(m.approveOut),
    quoteSell: step(m.quoteSell), sell: step(m.sell), transfer: step(m.transfer), poolTransfer: step(m.poolTransfer), unmeasured: 0n,
    buyIn: 0n, buyQuotedNet: 0n, buyDelivered: 0n, buyPoolSent: 0n, buyHops: 0n, sellIn: 0n, sellPoolReceived: 0n, sellTokenSelfDelta: 0n,
    sellOut: 0n, sellQuotedNet: 0n, sellHops: 0n, transferSent: 0n, transferReceived: 0n, poolTransferTo: known.poolTransferTo ?? null,
    poolTransferSent: 0n, poolTransferReceived: 0n };
  r.approveIn.ok = boolOk(m.approveIn);
  const qb = quoteOf(m.quoteBuy); r.quoteBuy.ok = !!(qb && qb.canExecute);
  if (qb) { r.buyQuotedNet = qb.netOut; r.buyHops = BigInt(qb.route.hops.length); }
  const pv4 = (route: any, i: any) => route && hopPools(route.hops[i < 0 ? route.hops.length - 1 : i].legs).v4;
  if (m.buy) {
    const a = snapVals(m, 'buyA'), b = snapVals(m, 'buyB');
    if (a.x === null || b.x === null) r.unmeasured |= UM.BAL_X;
    if (a.w === null || b.w === null) r.unmeasured |= UM.WETH;
    if (!a.okP || !b.okP || pv4(known.routeBuy, -1)) r.unmeasured |= UM.POOL_BUY;
    if (r.buy.ok && a.x !== null && b.x !== null && a.w !== null && b.w !== null) {
      r.buyIn = a.w > b.w ? a.w - b.w : 0n; r.buyDelivered = b.x > a.x ? b.x - a.x : 0n; r.buyPoolSent = a.pools - b.pools;
    }
  }
  if (m.approveOut) r.approveOut.ok = boolOk(m.approveOut);
  const qs = quoteOf(m.quoteSell); if (m.quoteSell) r.quoteSell.ok = !!(qs && qs.canExecute);
  if (qs) { r.sellQuotedNet = qs.netOut; r.sellHops = BigInt(qs.route.hops.length); }
  if (m.sell) {
    const a = snapVals(m, 'sellA'), b = snapVals(m, 'sellB');
    if (a.x === null || b.x === null) r.unmeasured |= UM.BAL_X;
    if (a.w === null || b.w === null) r.unmeasured |= UM.WETH;
    if (!a.okP || !b.okP || pv4(known.routeSell, 0)) r.unmeasured |= UM.POOL_SELL;
    if (a.s === null || b.s === null) r.unmeasured |= UM.SELF;
    if (r.sell.ok && a.x !== null && b.x !== null && a.w !== null && b.w !== null) {
      r.sellIn = a.x > b.x ? a.x - b.x : 0n; r.sellOut = b.w > a.w ? b.w - a.w : 0n;
      r.sellPoolReceived = b.pools - a.pools; r.sellTokenSelfDelta = (b.s ?? 0n) - (a.s ?? 0n);
    }
  }
  for (const [name, p, um] of [['transfer', 'tr', UM.BAL_Y], ['poolTransfer', 'pt', UM.POOL_SELL]]) {
    if (!m[name]) continue;
    r[name].ok = boolOk(m[name]);
    const x0 = u256(m[`${p}:x0`]), x1 = u256(m[`${p}:x1`]), y0 = u256(m[`${p}:y0`]), y1 = u256(m[`${p}:y1`]);
    if (x0 === null || x1 === null) r.unmeasured |= UM.BAL_X;
    if (y0 === null || y1 === null) r.unmeasured |= um;
    if (r[name].ok && x0 !== null && x1 !== null && y0 !== null && y1 !== null) {
      r[name + 'Sent'] = x0 > x1 ? x0 - x1 : 0n; r[name + 'Received'] = y1 > y0 ? y1 - y0 : 0n;
    }
  }
  if (tier === 'A' && m.sellLater) {
    r.sellLater = step(m.sellLater);
    const a = snapVals(m, 'lateA'), b = snapVals(m, 'lateB');
    if (r.sellLater.ok && a.x !== null && b.x !== null && a.w !== null && b.w !== null) {
      r.sellLaterIn = a.x > b.x ? a.x - b.x : 0n; r.sellLaterOut = b.w > a.w ? b.w - a.w : 0n; r.sellLaterPoolReceived = b.pools - a.pools;
    }
  }
  if (tier === 'A' && m.quoteLater) { const ql = quoteOf(m.quoteLater); r.quoteLater = { ok: !!(ql && ql.canExecute) }; }
  return r;
}

/** What a tier cannot measure, by construction (reported next to every result). */
export const TIER_LIMITS = {
  A: ['Nitro chains: block.number seen by contracts is the L1 number; a later-sell gap in L2 blocks does not move it'],
  B: ['tx.origin has code (the injected probe)', 'no later sell (one block)', 'block number/time = pinned block B, not B+1'],
  C: ['tx.origin = the funding address (has code if it is WETH)', 'msg.sender and recipient = Multicall3 (has code)', 'no later sell (one block)', 'no per-step gas (aggregate3Value returns none)', 'block number/time = pinned block B'],
};
