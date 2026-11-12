// Shared kit for the property and boundary suites. Offline, no new dependencies:
// a seeded generator (every run draws the same cases), a mock node that speaks
// EIP-1193 or JSON-RPC over a stubbed fetch, and a walker that collects every
// string reachable from a value (the oracle for "this never carries the RPC key").
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, getAddress } from 'viem';
import { ERC20_ABI, QUOTER_ABI, ROUTER_ABI } from '../src/abis.js';
import { CHAINS } from '../src/constants.js';
import { EMBEDDED_DEPLOYMENTS } from '../src/deployments.js';
import { BlazeError } from '../src/errors.js';
import type { Address, Hex, Preview, Route } from '../src/types.js';

export const tally = { passed: 0, failed: 0 };
export function check(name: string, ok: boolean, detail?: string) {
  if (ok) { tally.passed++; console.log(`  ✓ ${name}`); }
  else { tally.failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
/** Runs `n` cases; the check fails with the first counterexample `fn` returns. */
export async function forAll(name: string, n: number, fn: (i: number) => string | undefined | Promise<string | undefined>) {
  for (let i = 0; i < n; i++) {
    let bad: string | undefined;
    try { bad = await fn(i); } catch (e) { bad = `threw ${(e as Error)?.name}: ${(e as Error)?.message?.split('\n')[0]}`; }
    if (bad) { check(name, false, `case ${i}: ${bad}`); return; }
  }
  check(name, true);
}
export function done(label: string): never {
  console.log(`\n${label}: ${tally.passed} passed, ${tally.failed} failed`);
  process.exit(tally.failed ? 1 : 0);
}
export const big = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
/** The BlazeError code a call throws; 'none' when it returns, 'raw:<name>' for any other error. */
export async function codeOf(fn: () => unknown): Promise<string> {
  try { await fn(); return 'none'; } catch (e) { return e instanceof BlazeError ? e.code : `raw:${(e as Error)?.name}`; }
}

export const WETH = CHAINS[8453].weth as Address;
export const USDC = CHAINS[8453].usdc as Address;
export const ME = '0x1111111111111111111111111111111111111111' as Address;
export const POOL = '0xd0b53D9277642d899DF5C87A3966A349A798F224' as Address;
export const ZERO = '0x0000000000000000000000000000000000000000' as Address;
export const V1 = EMBEDDED_DEPLOYMENTS.versions.find((v) => v.version === '1.0.0')!.chains[8453]!;
export const V2 = {
  base: {
    router: '0x00000000000000000000000000000000000000a3' as Address, quoter: '0x00000000000000000000000000000000000000a4' as Address,
    hub: '0x00000000000000000000000000000000000000a1' as Address, solver: '0x00000000000000000000000000000000000000a2' as Address, version: '2.0.0',
  },
};

export type Rng = ReturnType<typeof rng>;
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {   // mulberry32
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const int = (n: number) => next() % n;
  const bits = (b: number) => {
    let v = 0n;
    for (let i = 0; i < b; i += 32) v = (v << 32n) | BigInt(next());
    return v & ((1n << BigInt(b)) - 1n);
  };
  /** Unsigned of `b` bits, biased to the corners: that is where a codec breaks. */
  const uint = (b: number) => {
    const max = (1n << BigInt(b)) - 1n;
    switch (int(8)) {
      case 0: return 0n;
      case 1: return 1n;
      case 2: return max;
      case 3: return max - 1n;
      case 4: return 1n << BigInt(b - 1);
      default: return bits(1 + int(b));
    }
  };
  const addr = () => getAddress(`0x${bits(160).toString(16).padStart(40, '0')}`) as Address;
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  return { next, int, bits, uint, addr, pick };
}

/** A structurally valid route tokenIn → tokenOut: 1-2 hops × 1-5 legs, every scalar at its full width. */
export function randomRoute(r: Rng, tIn: Address, tOut: Address): Route {
  const nHops = 1 + r.int(2);
  const mid = r.addr();
  const flag = () => r.int(2) === 1;
  return {
    hops: Array.from({ length: nHops }, (_, h) => ({
      tokenIn: h === 0 ? tIn : mid, tokenOut: h === nHops - 1 ? tOut : mid,
      amountIn: r.uint(256), expectedOut: r.uint(256),
      legs: Array.from({ length: 1 + r.int(5) }, () => ({
        pool: r.addr(), hooks: r.addr(), kind: r.int(256), fee: Number(r.uint(24)), tickSpacing: Number(r.uint(24)) - 8_388_608,
        zeroForOne: flag(), stable: flag(), amountIn: r.uint(256), expectedOut: r.uint(256),
        auxId: `0x${r.bits(256).toString(16).padStart(64, '0')}` as Hex,
      })),
    })),
    totalOut: r.uint(256), singleOut: r.uint(256), singleOutFloor: r.uint(256), expectedImpactBps: r.uint(256),
    confidenceWad: r.uint(256), estGas: r.uint(256), hasSurplus: flag(), isV4Bundle: flag(),
  };
}

export function mkRoute(tIn: Address, tOut: Address, amountIn: bigint, out: bigint): Route {
  return {
    hops: [{
      tokenIn: tIn, tokenOut: tOut, amountIn, expectedOut: out,
      legs: [{ pool: POOL, hooks: ZERO, kind: 2, fee: 500, tickSpacing: 10, zeroForOne: true, stable: false, amountIn, expectedOut: out, auxId: `0x${'0'.repeat(64)}` }],
    }],
    totalOut: out, singleOut: out, singleOutFloor: (out * 90n) / 100n, expectedImpactBps: 12n,
    confidenceWad: 10n ** 18n, estGas: 180_000n, hasSurplus: false, isV4Bundle: false,
  };
}
export function mkPreview(route: Route, userMinOut = 0n): Preview {
  const gross = route.totalOut;
  const net = gross - (gross * 28n + 9_999n) / 10_000n;
  const floor = route.singleOutFloor;
  return {
    route, grossOut: gross, protocolFee: gross - net, safetyBuffer: 0n, netOut: net, ironFloor: floor, userMinOut,
    effectiveMinOut: userMinOut > floor ? userMinOut : floor, estGas: route.estGas, hops: 1n, legs: 1n, topology: 0, bridgeUsed: ZERO, canExecute: true,
  };
}

export interface NodeOpts {
  chainId?: () => number;
  version?: string;                        // undefined → VERSION() reverts, like 1.x
  quoter?: Address; router?: Address;
  outFor?: (amountIn: bigint) => bigint;   // gross preview output
  exactFor?: (amountIn: bigint) => bigint; // previewPlanExact output
  decimals?: number;
  allowance?: bigint;
  routerText?: string;                     // the Router call reverts with `execution reverted: <this text>` (a token's own reason)
  encode?: (honest: Hex, pv: Preview) => Hex;   // what previewAndEncode returns as calldata (a node that lies)
}
const reverted = (message = 'execution reverted', data: Hex = '0x') => Object.assign(new Error(message), { code: 3, data });

/** "Your node": answers with the real ABIs, counts every eth_call by function name. */
export function mockNode(o: NodeOpts = {}) {
  const calls: string[] = [];
  const quoter = (o.quoter ?? V1.quoter).toLowerCase();
  const router = (o.router ?? V1.router).toLowerCase();
  const outFor = o.outFor ?? ((a: bigint) => a * 3_000n / 10n ** 12n);
  const count = (fn: string) => calls.filter((c) => c === fn).length;
  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    const p = (params ?? []) as unknown[];
    if (method === 'eth_chainId') { calls.push(method); return `0x${(o.chainId?.() ?? 8453).toString(16)}`; }
    if (method === 'eth_blockNumber') return '0x100';
    if (method === 'eth_getCode') return '0x6080604052';
    if (method === 'eth_getLogs') { calls.push(method); return []; }
    if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
    const { to, data } = p[0] as { to: string; data: Hex };
    const t = to.toLowerCase();
    if (t === quoter) {
      const d = decodeFunctionData({ abi: QUOTER_ABI, data });
      calls.push(d.functionName);
      const a = (d.args ?? []) as readonly unknown[];
      const [tIn, tOut, amt] = a as [Address, Address, bigint];
      switch (d.functionName) {
        case 'VERSION':
          if (!o.version) throw reverted();
          return encodeFunctionResult({ abi: QUOTER_ABI, functionName: 'VERSION', result: o.version });
        case 'hub': return encodeFunctionResult({ abi: QUOTER_ABI, functionName: 'hub', result: V2.base.hub });
        case 'solver': return encodeFunctionResult({ abi: QUOTER_ABI, functionName: 'solver', result: V2.base.solver });
        case 'previewPlan': case 'previewPlanWithMinOut': {
          const route = mkRoute(tIn, tOut, amt, outFor(amt));
          return encodeFunctionResult({ abi: QUOTER_ABI, functionName: d.functionName, result: [mkPreview(route, (a[3] as bigint | undefined) ?? 0n), route, false] as never });
        }
        case 'previewAndEncode': case 'previewAndEncodeWithMinOut': {
          const withMin = d.functionName === 'previewAndEncodeWithMinOut';
          const route = mkRoute(tIn, tOut, amt, outFor(amt));
          const pv = mkPreview(route, withMin ? (a[3] as bigint) : 0n);
          const honest = encodeRouter('swapExactIn', [route, amt, pv.effectiveMinOut, a[withMin ? 4 : 3], a[withMin ? 5 : 4]]);
          return encodeFunctionResult({ abi: QUOTER_ABI, functionName: d.functionName, result: [pv, o.encode ? o.encode(honest, pv) : honest] as never });
        }
        case 'previewPlanExact': {
          const ex = o.exactFor ? o.exactFor(amt) : outFor(amt);
          return encodeFunctionResult({ abi: QUOTER_ABI, functionName: 'previewPlanExact', result: [mkRoute(tIn, tOut, amt, ex), ex] as never });
        }
        default: throw new Error(`quoter fn ${d.functionName}`);
      }
    }
    if (t === router) {
      const d = decodeFunctionData({ abi: ROUTER_ABI, data });
      calls.push(`router.${d.functionName}`);
      if (d.functionName === 'VERSION') {
        if (!o.version) throw reverted();
        return encodeFunctionResult({ abi: ROUTER_ABI, functionName: 'VERSION', result: o.version });
      }
      if (d.functionName === 'hub') return encodeFunctionResult({ abi: ROUTER_ABI, functionName: 'hub', result: V2.base.hub });
      if (d.functionName === 'solver') return encodeFunctionResult({ abi: ROUTER_ABI, functionName: 'solver', result: V2.base.solver });
      if (o.routerText !== undefined) throw reverted(`execution reverted: ${o.routerText}`);
      return encodeFunctionResult({ abi: ROUTER_ABI, functionName: 'swapExactIn', result: 2_990n });
    }
    const d = decodeFunctionData({ abi: ERC20_ABI, data });
    calls.push(`erc20.${d.functionName}`);
    if (d.functionName === 'decimals') return encodeFunctionResult({ abi: ERC20_ABI, functionName: 'decimals', result: o.decimals ?? 18 });
    if (d.functionName === 'allowance') return encodeFunctionResult({ abi: ERC20_ABI, functionName: 'allowance', result: o.allowance ?? 0n });
    if (d.functionName === 'symbol') return encodeFunctionResult({ abi: ERC20_ABI, functionName: 'symbol', result: 'TKN' });
    if (d.functionName === 'name') return encodeFunctionResult({ abi: ERC20_ABI, functionName: 'name', result: 'Token' });
    throw new Error(`erc20 fn ${d.functionName}`);
  };
  return { provider: { request }, calls, count };
}
/** Router calldata built with viem alone (not with the SDK encoders under test). */
export function encodeRouter(functionName: string, args: unknown[]): Hex {
  return encodeFunctionData({ abi: ROUTER_ABI, functionName, args } as never);
}

/** How a faulty endpoint answers one JSON-RPC call; undefined → the node answers honestly. */
export type Fault =
  | { kind: 'http'; status: number; body: string }
  | { kind: 'throw'; message: string }
  | { kind: 'rpc'; message: string }
  | { kind: 'garbage' }
  | { kind: 'hang' };
/** Replaces global fetch with a JSON-RPC endpoint backed by `node`; returns the restore function. */
export function stubFetch(node: { request: (a: { method: string; params?: unknown }) => Promise<unknown> }, fault: (method: string) => Fault | undefined) {
  const real = globalThis.fetch;
  const json = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { id: number; method: string; params?: unknown };
    const f = fault(body.method);
    if (f?.kind === 'http') return json(f.body, f.status);
    if (f?.kind === 'throw') throw new TypeError(f.message);
    if (f?.kind === 'garbage') return json('<html>upstream unavailable</html>');
    if (f?.kind === 'rpc') return json({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: f.message } });
    if (f?.kind === 'hang') {
      return new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('The operation was aborted.', 'AbortError')));
      });
    }
    try {
      return json({ jsonrpc: '2.0', id: body.id, result: await node.request(body) });
    } catch (e) {
      const err = e as Error & { code?: number; data?: Hex };
      return json({ jsonrpc: '2.0', id: body.id, error: { code: err.code ?? -32000, message: err.message, ...(err.data ? { data: err.data } : {}) } });
    }
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

/** Every string reachable from `x`: own keys (enumerable or not), values, the cause chain, message and stack. */
export function allStrings(x: unknown, seen = new Set<unknown>(), out: string[] = [], depth = 0): string[] {
  if (x === null || x === undefined || depth > 14) return out;
  if (typeof x === 'string') { out.push(x); return out; }
  if (typeof x !== 'object') return out;
  if (seen.has(x)) return out;
  seen.add(x);
  if (x instanceof Error) out.push(String(x.message), String(x.stack ?? ''), String(x));
  for (const k of Reflect.ownKeys(x)) {
    if (typeof k === 'string') out.push(k);
    let v: unknown;
    try { v = (x as Record<PropertyKey, unknown>)[k]; } catch { continue; }
    allStrings(v, seen, out, depth + 1);
  }
  return out;
}
