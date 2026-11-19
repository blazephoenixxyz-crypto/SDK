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
const BPS = 10_000n, FEE = 28n; // Router 1.0.0 PROTOCOL_FEE_BPS, taken on the buy output (measure.ts: D = (1 - t) * P * (1 - fee))
const taxed = (o: FakeOpts, v: bigint) => v - (v * (o.taxBps ?? 0n)) / BPS;
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
function preview(tIn: string, tOut: string, amt: bigint, can: boolean) {
  const pv = zero(QO[0]);
  const legT = QO[0].components.find((c: any) => c.name === 'route').components.find((c: any) => c.name === 'hops').components.find((c: any) => c.name === 'legs');
  const leg = { ...zero({ ...legT, type: 'tuple' }), pool: POOL, kind: 2, amountIn: amt };
  const out = lc(tIn) === lc(TOKEN) ? amt / RATE : amt * RATE;
  pv.route.hops = can ? [{ tokenIn: tIn, tokenOut: tOut, amountIn: amt, expectedOut: out, legs: [leg] }] : [];
  pv.canExecute = can; pv.netOut = out;
  return encodeFunctionResult({ abi: QUOTER_ABI as any, functionName: 'previewPlan', result: [pv, zero(QO[1]), false] } as any);
}
export type FakeOpts = {
  probe?: Record<string, unknown>; tokenErr?: Record<string, Record<number, unknown>>; nodeclockErr?: boolean; l1gasErr?: boolean;
  noRoute?: boolean; noSellRoute?: boolean; nitroLater?: boolean; buyRevert?: boolean; sellRevert?: boolean; tokenCode?: string; mc3Code?: string; chainId?: number;
  /** Fee-on-transfer tax of TOKEN in bps, on every token move (pool -> buyer, seller -> pool, wallet transfers). */
  taxBps?: bigint;
};
function exec(st: any, o: FakeOpts, weth: string, actor: string, to: string, data: string, value: bigint) {
  const bal = (t: string, a: string): bigint => st[lc(t)]?.[lc(a)] ?? (lc(a) === lc(POOL) ? RESERVE : 0n);
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
    case 'previewPlan': return ok(preview(f.args[0], f.args[1], f.args[2], !(o.noRoute || (o.noSellRoute && lc(f.args[0]) === lc(TOKEN)))));
    case 'transfer': if (bal(to, actor) < f.args[1]) return rev(ERR('balance')); add(to, actor, -f.args[1]); add(to, f.args[0], lc(to) === lc(TOKEN) ? taxed(o, f.args[1]) : f.args[1]); return ok(T(true));
    case 'swapExactIn': {
      const [route, amt, , rcpt] = f.args;
      if (lc(route.hops[0].tokenIn) === lc(weth)) {
        if (o.buyRevert) return rev(BPC_TRANSFER);
        const net = (taxed(o, amt * RATE) * (BPS - FEE)) / BPS;
        add(weth, actor, -amt); add(weth, POOL, amt); add(TOKEN, POOL, -amt * RATE); add(TOKEN, rcpt, net); return ok(T(net));
      }
      if (o.sellRevert) return rev(BPC_TRANSFER);
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
    if (isProbe(req)) { const inj = o.probe?.[rung]; if (inj) return inj; }
    else { round[rung] = (round[rung] ?? 0) + 1; const inj = o.tokenErr?.[rung]?.[round[rung]]; if (inj) return inj; }
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
        const P = a.buyIn * RATE, D = (taxed(o, P) * (BPS - FEE)) / BPS;
        Object.assign(out, { buyIn: a.buyIn, buyQuotedNet: P, buyDelivered: D, buyPoolSent: P });
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
