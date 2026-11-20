// A fake JSON-RPC node for the xray (port of deep-xray-tiers@1998a4d test/fake.mjs): a mini EVM by selector
// (WETH deposit/approve, Quoter.previewPlan, Router.swapExactIn, ERC20 transfer/balanceOf); state is rebuilt per
// request (eth_call / eth_simulateV1 keep nothing). It also answers the pin batches: chainId, block number, gas
// price, six headers and eth_getCode. Router, quoter and Multicall3 code are the real Base runtimes, read once by
// eth_getCode at block 56632655 (fixtures/base-56632655-code.json), so the codehash pins pass unmodified.
// Injections: probe answers per rung, token-call errors per rung and round, -38021 when a block overrides number
// and time, -38013 when a call gas < 500000 (Nitro L1 gas), token without code, Multicall3 with foreign code.
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionResult, encodeErrorResult, getAddress } from 'viem';
import { QUOTER_ABI, ROUTER_ABI, ERC20_ABI, MC3_ABI, MC3, PROBE } from '../../src/xray/abi.js';
import { XRAY_DEPLOYMENTS } from '../../src/xray/ctx.js';
import type { Rpc } from '../../src/xray/step.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/base-56632655-code.json', import.meta.url), 'utf8'));
export const BASE_CODE: Record<string, string> = FX.code;
export const POOL = getAddress('0x' + '9b'.repeat(20));
export const TOKEN = getAddress('0x' + '7a'.repeat(20));
export const RATE = 1000n;
export const LATEST = 56632665;
/** Pool reserves of token and WETH: a swap moves tokens OUT of the pool, so the pool delta is measurable (W2-core-6). */
export const RESERVE = 10n ** 30n;
const BPS = 10_000n, FEE = 28n; // Router 1.0.0 PROTOCOL_FEE_BPS, taken on the swap output (measure.ts: D = (1 - t) * P * (1 - fee))
/** What the deployed Router 1.0.0 delivers from `x` received on a swap quoted at `gross` (Sourcify exact match, Base
 *  0x2a779f9Be49aac57495A8B6467Cc325a8a47Eb9f, BlazePhoenixRouter.sol:410-422): fee = floor(min(x, gross) * 28 / 1e4), the
 *  part above the quoted gross is fee-exempt surplus. */
const routerNet = (x: bigint, gross: bigint) => x - ((x < gross ? x : gross) * FEE) / BPS;
const taxed = (o: FakeOpts, v: bigint) => v - (v * (o.taxBps ?? 0n)) / BPS;
/** What the deployed Quoter 1.0.0 publishes for a gross output (Sourcify exact match, Base
 *  0x4cEF0615614B212895F45Aa1D4833B16666E18d3, BlazePhoenixQuoter.sol:163-165, :184-185): the protocol fee rounded DOWN
 *  comes off first, then the safety buffer (sBps of the after-fee amount, rounded down). bp-dex HEAD rounds both up; the
 *  probe runs against the deployed contracts, so the fake follows them. */
function quoterNet(gross: bigint, sBps: bigint) {
  const afterFee = gross - (gross * FEE) / BPS, safetyBuffer = (afterFee * sBps) / BPS;
  return { afterFee, safetyBuffer, netOut: afterFee > safetyBuffer ? afterFee - safetyBuffer : 0n };
}
/** Constant-product pair with a 30 bps fee (uniswap-v2 getAmountOut). */
const amountOut = (i: bigint, rIn: bigint, rOut: bigint) => (i * 997n * rOut) / (rIn * 1000n + i * 997n);
/** Curve-mode pair reserves (token, WETH): 1 WETH against 1000 tokens, so a 1e15 wei buy moves the price (~0.1 %). */
export const CURVE_RT = 10n ** 21n, CURVE_RW = 10n ** 18n;
const lc = (a: unknown) => String(a).toLowerCase();
const hex = (n: bigint | number) => '0x' + BigInt(n).toString(16);
const ERR = (s: string) => encodeErrorResult({ abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'm', type: 'string' }] }], errorName: 'Error', args: [s] });
export const BPC_TRANSFER = ERR('BPC:transfer');
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
function preview(tIn: string, tOut: string, amt: bigint, can: boolean, q?: { gross: bigint; safetyBuffer: bigint; netOut: bigint }) {
  const pv = zero(QO[0]);
  const legT = QO[0].components.find((c: any) => c.name === 'route').components.find((c: any) => c.name === 'hops').components.find((c: any) => c.name === 'legs');
  const leg = { ...zero({ ...legT, type: 'tuple' }), pool: POOL, kind: 2, amountIn: amt };
  // Proportional mode: a buy is quoted net of the protocol fee its execution charges (exec, swapExactIn); a sale is
  // executed without the fee, so it is quoted without it. Curve mode passes the Quoter's own figures (quoterNet).
  const out = q ? q.gross : lc(tIn) === lc(TOKEN) ? amt / RATE : amt * RATE;
  pv.route.hops = can ? [{ tokenIn: tIn, tokenOut: tOut, amountIn: amt, expectedOut: out, legs: [leg] }] : [];
  pv.canExecute = can; pv.netOut = q ? q.netOut : lc(tIn) === lc(TOKEN) ? out : quoterNet(out, 0n).netOut;
  if (q) { pv.safetyBuffer = q.safetyBuffer; pv.protocolFee = out - quoterNet(out, 0n).afterFee; }
  return encodeFunctionResult({ abi: QUOTER_ABI as any, functionName: 'previewPlan', result: [pv, zero(QO[1]), false] } as any);
}
export type FakeOpts = {
  probe?: Record<string, unknown>; tokenErr?: Record<string, Record<number, unknown>>; nodeclockErr?: boolean; l1gasErr?: boolean;
  noRoute?: boolean; noSellRoute?: boolean; nitroLater?: boolean; buyRevert?: boolean; sellRevert?: boolean; tokenCode?: string; mc3Code?: string; chainId?: number;
  /** Fee-on-transfer tax of TOKEN in bps, on every token move (pool -> buyer, seller -> pool, wallet transfers). */
  taxBps?: bigint;
  /** V4-verif: sell-only tax (transfers TO the pool) paid to `holder` (default TOKEN itself); before crediting, when the
   *  holder holds >= cap it sells `cap` into the same pool (swapback, uniswap-v2 template). `start` seeds the holder. */
  swapback?: { taxBps: bigint; cap: bigint; start: bigint; holder?: string };
  /** Curve mode (step plans, tiers A and C): an x*y=k pair with a 30 bps pair fee whose reserves follow every swap in
   *  the request; quotes as the Quoter (protocol fee 28 bps, then `safetyBps` of buffer, default 0); the Router takes
   *  the fee on the swap output (buy and sell, as the live 1.0.0 goldens show). A plain transfer to the pair moves its
   *  balance only (no sync). A sale follows Router 1.0.0 _execV2Amt (BlazePhoenixRouter.sol:546-583): when the pair
   *  received exactly the amount sent it is priced on that amount (any excess already in the pair stays out of the
   *  output); when it received less (fee-on-transfer) it is priced on balance - reserve, which sweeps in the excess.
   *  Every swap then syncs the reserves to the balances (uniswap-v2 _update). Not combined with swapback;
   *  the tier B probe answer stays proportional. */
  curve?: { rt?: bigint; rw?: bigint; safetyBps?: bigint };
};
function exec(st: any, o: FakeOpts, weth: string, actor: string, to: string, data: string, value: bigint) {
  const sb = o.swapback, H = sb ? (sb.holder ?? TOKEN) : '', cv = o.curve;
  const pool0 = (t: string) => (cv ? (lc(t) === lc(TOKEN) ? cv.rt ?? CURVE_RT : cv.rw ?? CURVE_RW) : RESERVE);
  const bal = (t: string, a: string): bigint => st[lc(t)]?.[lc(a)] ?? (lc(a) === lc(POOL) ? pool0(t) : sb && lc(t) === lc(TOKEN) && lc(a) === lc(H) ? sb.start : 0n);
  // Curve-mode reserves (token, WETH), updated by swaps only.
  const res = cv ? (st.__res ??= { t: pool0(TOKEN), w: pool0(weth) }) : null;
  // swapback + sell tax on a move of v tokens from `from` to the pool; returns what the pool is credited for the mover.
  const toPool = (from: string, v: bigint): bigint => {
    const tax = (v * sb!.taxBps) / BPS;
    if (bal(TOKEN, H) >= sb!.cap) { add(TOKEN, H, -sb!.cap); add(TOKEN, POOL, sb!.cap); add(weth, POOL, -sb!.cap / RATE); add(weth, H, sb!.cap / RATE); }
    add(TOKEN, from, -v); add(TOKEN, H, tax); add(TOKEN, POOL, v - tax); return v - tax;
  };
  const add = (t: string, a: string, v: bigint) => { st[lc(t)] ??= {}; st[lc(t)][lc(a)] = bal(t, a) + v; };
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
    case 'previewPlan': {
      const can = !(o.noRoute || (o.noSellRoute && lc(f.args[0]) === lc(TOKEN)));
      if (!res) return ok(preview(f.args[0], f.args[1], f.args[2], can));
      const gross = lc(f.args[0]) === lc(TOKEN) ? amountOut(f.args[2], res.t, res.w) : amountOut(f.args[2], res.w, res.t);
      return ok(preview(f.args[0], f.args[1], f.args[2], can, { gross, ...quoterNet(gross, cv!.safetyBps ?? 0n) }));
    }
    case 'transfer': if (bal(to, actor) < f.args[1]) return rev(ERR('balance'));
      if (sb && lc(to) === lc(TOKEN) && lc(f.args[0]) === lc(POOL)) { toPool(actor, f.args[1]); return ok(T(true)); } add(to, actor, -f.args[1]); add(to, f.args[0], lc(to) === lc(TOKEN) ? taxed(o, f.args[1]) : f.args[1]); return ok(T(true));
    case 'swapExactIn': {
      const [route, amt, , rcpt] = f.args;
      if (lc(route.hops[0].tokenIn) === lc(weth)) {
        if (o.buyRevert) return rev(BPC_TRANSFER);
        if (res) {
          const out = amountOut(amt, res.w, res.t), net = routerNet(taxed(o, out), out);
          add(weth, actor, -amt); add(weth, POOL, amt); add(TOKEN, POOL, -out); add(TOKEN, rcpt, net);
          res.t = bal(TOKEN, POOL); res.w = bal(weth, POOL); return ok(T(net));
        }
        const net = routerNet(taxed(o, amt * RATE), amt * RATE);
        add(weth, actor, -amt); add(weth, POOL, amt); add(TOKEN, POOL, -amt * RATE); add(TOKEN, rcpt, net); return ok(T(net));
      }
      if (o.sellRevert) return rev(BPC_TRANSFER);
      if (res) {
        const got = taxed(o, amt);
        add(TOKEN, actor, -amt); add(TOKEN, POOL, got);
        const realIn = got === amt ? amt : bal(TOKEN, POOL) - res.t, out = amountOut(realIn, res.t, res.w);
        const net = routerNet(out, amountOut(amt, res.t, res.w));
        add(weth, POOL, -out); add(weth, rcpt, net); res.t = bal(TOKEN, POOL); res.w = bal(weth, POOL); return ok(T(net));
      }
      if (sb) { const g = toPool(actor, amt), w = g / RATE; add(weth, POOL, -w); add(weth, rcpt, w); return ok(T(w)); }
      const got = taxed(o, amt), wout = got / RATE;
      add(TOKEN, actor, -amt); add(TOKEN, POOL, got); add(weth, POOL, -wout); add(weth, rcpt, wout); return ok(T(wout));
    }
  }
  return rev('0x');
}
export function rungOf(req: any) {
  if (req.method === 'eth_simulateV1') return req.params[0].blockStateCalls[0].blockOverrides?.prevRandao ? 'A:d4' : 'A:d2';
  return lc(req.params[0].to) === lc(MC3) ? 'C' : 'B';
}
export function isProbe(req: any) {
  if (req.method === 'eth_simulateV1') { const c = req.params[0].blockStateCalls.flatMap((b: any) => b.calls); return c.length === 1 && (!c[0].data || c[0].data === '0x'); }
  const p = req.params[0];
  if (lc(p.to) === lc(MC3)) { try { const [calls]: any = decodeFunctionData({ abi: MC3_ABI as any, data: p.data }).args; return calls.length === 1 && calls[0].callData === '0x'; } catch { return false; } }
  return lc(p.from) !== lc(p.to);
}
/** Synthetic headers B..B+5 (2 s apart) with the fields ctx reads. */
export function header(n: number) {
  return { number: hex(n), hash: '0x' + (n % 256).toString(16).padStart(2, '0').repeat(32), timestamp: hex(1_760_000_000 + 2 * n), baseFeePerGas: hex(5_000_000 + (n % 10) * 1000),
    gasLimit: hex(150_000_000), mixHash: '0x' + 'ab'.repeat(32), miner: '0x' + 'cd'.repeat(20) };
}
export function fakeNode(o: FakeOpts = {}) {
  const chainId = o.chainId ?? 8453;
  const weth = XRAY_DEPLOYMENTS[chainId].weth;
  const reqs: Rpc[] = []; const round: Record<string, number> = {};
  const code = (a: string): string => {
    const d = XRAY_DEPLOYMENTS[chainId];
    if (lc(a) === lc(d.router)) return BASE_CODE.router;
    if (lc(a) === lc(d.quoter)) return BASE_CODE.quoter;
    if (lc(a) === lc(MC3)) return o.mc3Code ?? BASE_CODE.mc3;
    if (lc(a) === lc(TOKEN)) return o.tokenCode ?? '0x6080604052';
    return '0x';
  };
  const one = (req: any): unknown => {
    reqs.push(req);
    const R = (result: unknown) => ({ jsonrpc: '2.0', id: 1, result });
    const E = (c: number, message: string) => ({ jsonrpc: '2.0', id: 1, error: { code: c, message } });
    if (req.method === 'eth_chainId') return R(hex(chainId));
    if (req.method === 'eth_blockNumber') return R(hex(LATEST));
    if (req.method === 'eth_gasPrice') return R(hex(6_000_000));
    if (req.method === 'eth_getBlockByNumber') return R(header(parseInt(req.params[0], 16)));
    if (req.method === 'eth_getCode') return R(code(req.params[0]));
    const rung = rungOf(req);
    // The key decides, not the value: an injected null is a reply (provider unavailable); an absent key keeps the default.
    if (isProbe(req)) { if (o.probe && Object.hasOwn(o.probe, rung)) return o.probe[rung]; }
    else { round[rung] = (round[rung] ?? 0) + 1; const t = o.tokenErr?.[rung]; if (t && Object.hasOwn(t, round[rung])) return t[round[rung]]; }
    if (req.method === 'eth_simulateV1') {
      const bsc = req.params[0].blockStateCalls;
      if (o.nodeclockErr && bsc.some((b: any) => b.blockOverrides?.number && b.blockOverrides?.time)) return E(-38021, 'block timestamps must be in order: 1794517811 <= 1794518979');
      // Nitro (deep-xray-tiers live/nitro-later.mjs, 42161 @523689908, 4663 @112876536): after ~99 empty simulated blocks the
      // base fee decays to ~32 wei, L1 poster gas exceeds any call gas -> -38013; a base fee override on the call block removes it.
      if (o.nitroLater && bsc.some((b: any) => b.blockOverrides?.number && b.calls.length && !b.blockOverrides.baseFeePerGas)) return E(-38013, 'err: intrinsic gas too low (supplied gas 30000000)');
      if (o.l1gasErr && bsc.some((b: any) => b.calls.some((c: any) => BigInt(c.gas) < 500000n))) return E(-38013, 'err: intrinsic gas too low (supplied gas 400000)');
      const st = {};
      return R(bsc.map((b: any, i: number) => ({ number: hex(1 + i), timestamp: b.blockOverrides?.time ?? '0x1', calls: b.calls.map((c: any) => {
        const r = exec(st, o, weth, c.from, c.to, c.data, c.value ? BigInt(c.value) : 0n);
        return r.ok ? { status: '0x1', returnData: r.ret, gasUsed: '0x5208', logs: [] }
          : { status: '0x0', returnData: '0x', gasUsed: '0x5208', logs: [], error: { code: 3, message: 'execution reverted', data: r.ret } }; }) })));
    }
    if (req.method === 'eth_call') {
      const p = req.params[0];
      if (lc(p.to) === lc(MC3)) {
        const [calls]: any = decodeFunctionData({ abi: MC3_ABI as any, data: p.data }).args;
        const st = {};
        return R(encodeFunctionResult({ abi: MC3_ABI as any, functionName: 'aggregate3Value', result: calls.map((c: any) => { const r = exec(st, o, weth, MC3, c.target, c.callData, c.value); return { success: r.ok, returnData: r.ret }; }) } as any));
      }
      if (isProbe(req)) return R('0x');
      const out = zero((PROBE.abi as any).find((x: any) => x.name === 'probe').outputs[0]);
      const ran = o.noRoute ? ['wrap', 'approveIn', 'quoteBuy'] : o.noSellRoute ? ['wrap', 'approveIn', 'quoteBuy', 'buy', 'approveOut', 'quoteSell', 'transfer']
        : ['wrap', 'approveIn', 'quoteBuy', 'buy', 'approveOut', 'quoteSell', 'sell', 'transfer'];
      for (const k of ran) { out[k].ok = true; out[k].gas = 40000n; }
      if (!o.noRoute) out.buyHops = 1n;
      if (!o.noRoute && !o.noSellRoute) out.sellHops = 1n;
      if (o.sellRevert) { out.sell.ok = false; out.sell.revertData = BPC_TRANSFER; }
      // The probe's own deltas, in the same model as exec() (pool pays out, router fee on the buy output, token tax).
      const a: any = (decodeFunctionData({ abi: PROBE.abi as any, data: p.data }).args as any)[0];
      if (!o.noRoute) {
        const P = a.buyIn * RATE, D = routerNet(taxed(o, P), P);
        Object.assign(out, { buyIn: a.buyIn, buyQuotedNet: quoterNet(P, 0n).netOut, buyDelivered: D, buyPoolSent: P });
        const S = (D * a.sellFracBps) / BPS, left = D - S, tA = (left * a.transferFracBps) / BPS, pA = (left * a.poolFracBps) / BPS;
        Object.assign(out, { transferSent: tA, transferReceived: taxed(o, tA), poolTransferTo: POOL, poolTransferSent: pA, poolTransferReceived: taxed(o, pA) });
        out.poolTransfer.ok = pA > 0n; out.poolTransfer.gas = 40000n;
        if (!o.noSellRoute && !o.sellRevert) Object.assign(out, { sellIn: S, sellPoolReceived: taxed(o, S), sellOut: taxed(o, S) / RATE, sellQuotedNet: S / RATE });
      }
      return R(encodeFunctionResult({ abi: PROBE.abi as any, functionName: 'probe', result: out } as any));
    }
    return E(-32601, 'the method ' + req.method + ' does not exist/is not available');
  };
  return { transport: async (batch: Rpc[]) => batch.map(one), send: async (req: Rpc) => one(req), reqs };
}

/** Drive a sans-IO generator against a batch transport (test helper; the SDK's only loop is runXray). */
export async function drive<R>(g: Generator<Rpc[], R, unknown[]>, transport: (b: Rpc[]) => Promise<unknown[]>): Promise<R> {
  let r = g.next(undefined as unknown as unknown[]);
  while (!r.done) r = g.next(await transport(r.value));
  return r.value;
}
/** A pinned block built from the fake headers (B = LATEST - 10). */
export function fakeBlk(n = LATEST - 10) {
  const headers = [0, 1, 2, 3, 4, 5].map((k) => header(n + k));
  return { number: n, hash: headers[0].hash, timestamp: BigInt(headers[0].timestamp), baseFee: BigInt(headers[0].baseFeePerGas), headers, gasPrice: 6_000_000n };
}
