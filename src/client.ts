// =============================================================================
//  BlazePhoenix client — quote, build, verify, simulate and execute swaps
//  DIRECTLY against the chain, through YOUR RPC. No API in the middle, no key,
//  no BlazePhoenix server in the read path.
//
//    const blaze = new BlazePhoenix({ rpc: { base: process.env.BASE_RPC_URL } });
//    const q    = await blaze.quote({ chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC', amount: '1' });
//    const plan = await blaze.buildSwap({ ...req, recipient: me, from: me });
//    await blaze.execute({ wallet, plan });          // approve (if needed) → simulate → swap
//
//  On 2.x deployments the Quoter returns the preview AND the Router calldata in
//  one eth_call (previewAndEncode); the SDK decodes those bytes with the ABI and
//  verifies every field before they reach your wallet. On 1.x the SDK encodes
//  the same swapExactIn call locally from the previewed route.
// =============================================================================

import {
  decodeFunctionResult, getAddress, parseEventLogs, type PublicClient, type WalletClient,
} from 'viem';
import {
  ERC20_ABI, QUOTER_ABI, ROUTER_ABI, SOLVER_ABI, STAKING_SOLVENCY_ABI,
} from './abis.js';
import {
  encodeSwapBestExactIn, encodeSwapExactIn, encodeSwapExactInNative, minOutFor, tightenMinOut,
  verifySwapExactIn,
} from './calldata.js';
import { phoenixCheck, routeIsConsistent } from './checks.js';
import {
  CHAINS, NATIVE_TOKEN, resolveChain, type SupportedChainId,
} from './constants.js';
import { featuresOf, isZero, type VersionFeatures, type VersionSelector } from './deployments.js';
import { BlazeError, decodeBlazeError, isTransportError } from './errors.js';
import { MAX_UINT256, buildApproveTx, toBaseUnits } from './erc20.js';
import {
  Registry, type ContractOverrides, type RegistryOptions, type ResolvedDeployment,
} from './registry.js';
import { memGet, memPut, singleflight } from './resilience.js';
import { RpcRouter, rpcFromEnv, type RpcConfig, type TransportOptions } from './rpc.js';
import type {
  Address, ApprovalStep, ExactQuote, Fill, Hex, Preview, Quote, QuoteRequest, Route,
  SimulationResult, SolvencyReport, SwapPlan, SwapRequest, TokenInfo, TxRequest,
} from './types.js';

export interface ClientOptions extends TransportOptions {
  /**
   * YOUR RPC — required for anything on-chain. A URL, a list of URLs (your
   * fallback order), an EIP-1193 provider (the user's wallet), a viem
   * Transport, or a per-chain map of any of those. When omitted, the
   * BLAZEPHOENIX_RPC_* environment variables are read (see rpcFromEnv).
   */
  rpc?: RpcConfig;
  /** Protocol version to use: 'latest' (default, per chain), '1', '2', '2.0.0'… */
  version?: VersionSelector;
  /** Your own contract addresses per chain — always win over the registry. */
  contracts?: ContractOverrides;
  /** Deployment registry behaviour (remote refresh on/off, URL, TTL, warnings). */
  registry?: RegistryOptions;
  /** Cross-check remote-sourced deployments on your RPC before first use (default true). */
  verifyRemoteDeployments?: boolean;
  /** Micro-cache for identical PREVIEW quotes, in ms (default 1000; 0 disables).
   *  Never applied to buildSwap — execution data is always fresh. */
  cacheTtlMs?: number;
  /** Default slippage for buildSwap in bps (default 50 = 0.5%). */
  slippageBps?: number;
  /** Default deadline horizon for buildSwap in seconds (default 120). */
  deadlineSec?: number;
  /** Max chunk for 2.x on-chain batchQuote (default 8; nodes cap eth_call gas). */
  batchChunk?: number;
}

interface Ctx {
  chainId: SupportedChainId;
  dep: ResolvedDeployment;
  features: VersionFeatures;
  client: PublicClient;
}

interface ResolvedToken { address: Address; native: boolean }

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const INT = /^\d{1,78}$/;
const UINT128_MAX = (1n << 128n) - 1n;

export type BatchItem =
  | { ok: true; quote: Quote }
  | { ok: false; error: { code: string; message: string } };

export interface ExecuteOptions {
  /** A viem WalletClient with an account (local key, injected wallet, …). */
  wallet: WalletClient;
  /** A plan from buildSwap — or pass `request` and the plan is built now. */
  plan?: SwapPlan;
  request?: SwapRequest;
  /** Rebuild the plan when it is older than this (default 30s). */
  maxQuoteAgeMs?: number;
  /** eth_call the swap from your account before sending (default true). */
  simulate?: boolean;
  /** Wait for receipts (default true). */
  wait?: boolean;
}

export interface ExecuteResult {
  plan: SwapPlan;
  approvalHash?: Hex;
  hash: Hex;
  status?: 'success' | 'reverted';
  /** Realised output read from the Router's Swap event (when waited). */
  amountOut?: bigint;
  blockNumber?: bigint;
}

export interface DeploymentCheck { name: string; ok: boolean; detail: string }

export interface DeploymentReport {
  ok: boolean;
  chainId: number;
  version: string;
  source: string;
  contracts: ResolvedDeployment['contracts'];
  checks: DeploymentCheck[];
}

export class BlazePhoenix {
  readonly registry: Registry;
  readonly rpc: RpcRouter;
  private readonly version: VersionSelector;
  private readonly verifyRemote: boolean;
  private readonly cacheTtlMs: number;
  private readonly slippageBps: number;
  private readonly deadlineSec: number;
  private readonly batchChunk: number;
  private readonly verified = new Map<string, Promise<void>>();
  private readonly decimals = new Map<string, Promise<number>>();

  constructor(opts: ClientOptions = {}) {
    this.rpc = new RpcRouter(opts.rpc ?? rpcFromEnv(), opts);
    this.registry = new Registry(opts.registry, opts.contracts);
    this.version = opts.version ?? 'latest';
    this.verifyRemote = opts.verifyRemoteDeployments ?? true;
    this.cacheTtlMs = opts.cacheTtlMs ?? 1_000;
    this.slippageBps = opts.slippageBps ?? 50;
    this.deadlineSec = opts.deadlineSec ?? 120;
    this.batchChunk = Math.max(1, Math.min(32, opts.batchChunk ?? 8));
    minOutFor(0n, this.slippageBps, 0n); // validates the default early
    checkDeadlineSec(this.deadlineSec);
  }

  // ── context ────────────────────────────────────────────────────────────────

  private async ctx(req: { chain?: string | number; version?: string }): Promise<Ctx> {
    const chainId = req.chain !== undefined ? resolveChain(req.chain) : await this.rpc.defaultChain();
    await this.registry.ready();
    const dep = this.registry.resolve(chainId, req.version ?? this.version);
    const client = await this.rpc.client(chainId);
    if (dep.source === 'remote' && this.verifyRemote) await this.ensureVerified(dep, client);
    return { chainId, dep, features: featuresOf(dep.version), client };
  }

  private ensureVerified(dep: ResolvedDeployment, client: PublicClient): Promise<void> {
    const key = `${dep.chainId}|${dep.version}|${dep.contracts.router}|${dep.contracts.quoter}`;
    let p = this.verified.get(key);
    if (!p) {
      p = this.checkDeployment(dep, client).then((r) => {
        if (!r.ok) {
          const failed = r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
          throw new BlazeError('deployment_unverified',
            `registry deployment ${dep.version} on chain ${dep.chainId} failed on-chain verification — refusing to use it (${failed.join('; ')})`,
            { details: { report: r } });
        }
      });
      p.catch(() => this.verified.delete(key)); // retry next time (it may have been the node)
      this.verified.set(key, p);
    }
    return p;
  }

  /** Cross-check a deployment on YOUR RPC: code at every address and, on 2.x,
   *  VERSION() and the Hub/Solver wiring of the Quoter, Router and Solver. */
  async verifyDeployment(req: { chain?: string | number; version?: string } = {}): Promise<DeploymentReport> {
    const chainId = req.chain !== undefined ? resolveChain(req.chain) : await this.rpc.defaultChain();
    await this.registry.ready();
    const dep = this.registry.resolve(chainId, req.version ?? this.version);
    const client = await this.rpc.client(chainId);
    return this.checkDeployment(dep, client);
  }

  private async checkDeployment(dep: ResolvedDeployment, client: PublicClient): Promise<DeploymentReport> {
    const checks: DeploymentCheck[] = [];
    const c = dep.contracts;
    const named = (['core', 'hub', 'solver', 'router', 'quoter'] as const).filter((k) => !isZero(c[k]));
    const codes = await Promise.all(named.map((k) => client.getCode({ address: c[k] }).catch(() => undefined)));
    named.forEach((k, i) => {
      const code = codes[i];
      checks.push({ name: `code:${k}`, ok: !!code && code !== '0x', detail: code && code !== '0x' ? `${(code.length - 2) / 2} bytes` : 'no code at address' });
    });
    if (featuresOf(dep.version).introspection) {
      const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
      const read = async <T>(fn: () => Promise<T>): Promise<T | undefined> => { try { return await fn(); } catch { return undefined; } };
      const [qv, rv, sv, qh, qs, rh, rs, sh] = await Promise.all([
        read(() => client.readContract({ address: c.quoter, abi: QUOTER_ABI, functionName: 'VERSION' })),
        read(() => client.readContract({ address: c.router, abi: ROUTER_ABI, functionName: 'VERSION' })),
        isZero(c.solver) ? undefined : read(() => client.readContract({ address: c.solver, abi: SOLVER_ABI, functionName: 'VERSION' })),
        read(() => client.readContract({ address: c.quoter, abi: QUOTER_ABI, functionName: 'hub' })),
        read(() => client.readContract({ address: c.quoter, abi: QUOTER_ABI, functionName: 'solver' })),
        read(() => client.readContract({ address: c.router, abi: ROUTER_ABI, functionName: 'hub' })),
        read(() => client.readContract({ address: c.router, abi: ROUTER_ABI, functionName: 'solver' })),
        isZero(c.solver) ? undefined : read(() => client.readContract({ address: c.solver, abi: SOLVER_ABI, functionName: 'hub' })),
      ]);
      checks.push({ name: 'quoter.VERSION', ok: qv === dep.version, detail: `${qv ?? 'unreadable'} (want ${dep.version})` });
      checks.push({ name: 'router.VERSION', ok: rv === dep.version, detail: `${rv ?? 'unreadable'} (want ${dep.version})` });
      if (!isZero(c.solver)) checks.push({ name: 'solver.VERSION', ok: sv === dep.version, detail: `${sv ?? 'unreadable'} (want ${dep.version})` });
      if (!isZero(c.hub)) {
        checks.push({ name: 'quoter.hub', ok: !!qh && eq(qh, c.hub), detail: `${qh ?? 'unreadable'}` });
        checks.push({ name: 'router.hub', ok: !!rh && eq(rh, c.hub), detail: `${rh ?? 'unreadable'}` });
        if (!isZero(c.solver)) checks.push({ name: 'solver.hub', ok: !!sh && eq(sh, c.hub), detail: `${sh ?? 'unreadable'}` });
      }
      if (!isZero(c.solver)) {
        checks.push({ name: 'quoter.solver', ok: !!qs && eq(qs, c.solver), detail: `${qs ?? 'unreadable'}` });
        checks.push({ name: 'router.solver', ok: !!rs && eq(rs, c.solver), detail: `${rs ?? 'unreadable'}` });
      }
    }
    return {
      ok: checks.every((x) => x.ok),
      chainId: dep.chainId, version: dep.version, source: dep.source, contracts: dep.contracts, checks,
    };
  }

  // ── tokens & amounts ───────────────────────────────────────────────────────

  private resolveToken(chainId: SupportedChainId, ref: string, side: 'tokenIn' | 'tokenOut'): ResolvedToken {
    const s = (ref ?? '').trim();
    if (HEX_ADDR.test(s)) {
      const a = getAddress(s);
      if (a.toLowerCase() === NATIVE_TOKEN.toLowerCase()) return { address: CHAINS[chainId].weth, native: true };
      return { address: a, native: false };
    }
    const c = CHAINS[chainId];
    switch (s.toUpperCase()) {
      case 'ETH': return { address: c.weth, native: true };
      case 'WETH': return { address: c.weth, native: false };
      case 'USDC': case 'USDG': return { address: c.usdc, native: false };
      case 'BZPX':
        if (c.bzpx) return { address: c.bzpx, native: false };
        break;
      default: break;
    }
    throw new BlazeError('bad_request',
      `${side}: "${ref}" is not a 0x address or a built-in symbol (ETH, WETH, USDC, BZPX) on ${c.name} — pass the token address`);
  }

  private async decimalsOf(client: PublicClient, chainId: number, t: ResolvedToken): Promise<number> {
    if (t.native) return 18;
    const key = `${chainId}|${t.address.toLowerCase()}`;
    let p = this.decimals.get(key);
    if (!p) {
      p = client.readContract({ address: t.address, abi: ERC20_ABI, functionName: 'decimals' }).then(Number);
      p.catch(() => this.decimals.delete(key));
      this.decimals.set(key, p);
    }
    return p;
  }

  private async amountOf(client: PublicClient, chainId: number, req: QuoteRequest, tIn: ResolvedToken): Promise<bigint> {
    let v: bigint;
    if (req.amountIn !== undefined && req.amountIn !== null && req.amountIn !== '') {
      if (typeof req.amountIn === 'bigint') v = req.amountIn;
      else if (INT.test(String(req.amountIn).trim())) v = BigInt(String(req.amountIn).trim());
      else throw new BlazeError('bad_request', 'amountIn must be an integer in base units — use `amount` for human units ("1.5")');
    } else if (req.amount !== undefined) {
      const d = await this.decimalsOf(client, chainId, tIn).catch((e: unknown) => {
        throw new BlazeError('bad_request', `could not read decimals of ${tIn.address} on your RPC — pass amountIn in base units`, { cause: e });
      });
      try { v = toBaseUnits(req.amount, d); } catch (e) { throw new BlazeError('bad_request', (e as Error).message); }
    } else {
      throw new BlazeError('bad_request', 'pass amountIn (base units) or amount (human units)');
    }
    if (v <= 0n) throw new BlazeError('bad_request', 'amount must be > 0');
    if (v > UINT128_MAX) throw new BlazeError('bad_request', 'amount exceeds uint128 (the Router refuses it)');
    return v;
  }

  private async pair(ctx: Ctx, req: QuoteRequest) {
    const tIn = this.resolveToken(ctx.chainId, req.tokenIn, 'tokenIn');
    const tOut = this.resolveToken(ctx.chainId, req.tokenOut, 'tokenOut');
    if (tIn.address.toLowerCase() === tOut.address.toLowerCase()) {
      throw new BlazeError('bad_request', tIn.native !== tOut.native
        ? 'ETH ↔ WETH is a wrap/unwrap, not a swap — use buildWrapTx / buildUnwrapTx'
        : 'tokenIn and tokenOut are the same token');
    }
    const amountIn = await this.amountOf(ctx.client, ctx.chainId, req, tIn);
    let userMinOut = 0n;
    if (req.userMinOut !== undefined && req.userMinOut !== '') {
      const s = String(req.userMinOut).trim();
      if (typeof req.userMinOut !== 'bigint' && !INT.test(s)) throw new BlazeError('bad_request', 'userMinOut must be an integer in base units');
      userMinOut = BigInt(req.userMinOut);
    }
    return { tIn, tOut, amountIn, userMinOut };
  }

  // ── quotes ─────────────────────────────────────────────────────────────────

  private wrapReadError(e: unknown, what: string): never {
    if (e instanceof BlazeError) throw e;
    const revert = decodeBlazeError(e);
    if (revert) {
      throw new BlazeError('no_route', `${what}: ${revert.name}(${revert.code ?? ''}) — ${revert.reason}`, { revert, cause: e });
    }
    if (isTransportError(e)) {
      throw new BlazeError('rpc_error', `${what}: your RPC failed (${(e as Error)?.message?.split('\n')[0] ?? e})`, { cause: e });
    }
    const msg = (e as Error)?.message?.split('\n')[0] ?? String(e);
    if (/revert/i.test(msg)) throw new BlazeError('no_route', `${what}: execution reverted`, { cause: e });
    throw new BlazeError('rpc_error', `${what}: ${msg}`, { cause: e });
  }

  private buildQuote(ctx: Ctx, tIn: ResolvedToken, tOut: ResolvedToken, amountIn: bigint, pv: Preview, fb: Route | undefined, blockNumber?: bigint): Quote {
    return {
      chainId: ctx.chainId,
      version: ctx.dep.version,
      quoter: ctx.dep.contracts.quoter,
      router: ctx.dep.contracts.router,
      deploymentSource: ctx.dep.source,
      tokenIn: tIn.address,
      tokenOut: tOut.address,
      amountIn,
      nativeIn: tIn.native,
      nativeOut: tOut.native,
      amountOut: pv.netOut,
      preview: pv,
      route: pv.route,
      ...(fb ? { fallbackRoute: fb } : {}),
      checks: phoenixCheck(pv, tIn.address, tOut.address),
      ...(blockNumber !== undefined ? { blockNumber } : {}),
      quotedAt: Date.now(),
    };
  }

  private async readPreview(ctx: Ctx, tIn: Address, tOut: Address, amountIn: bigint, userMinOut: bigint, blockNumber?: bigint) {
    const base = { address: ctx.dep.contracts.quoter, abi: QUOTER_ABI, ...(blockNumber !== undefined ? { blockNumber } : {}) } as const;
    try {
      const r = userMinOut > 0n
        ? await ctx.client.readContract({ ...base, functionName: 'previewPlanWithMinOut', args: [tIn, tOut, amountIn, userMinOut] })
        : await ctx.client.readContract({ ...base, functionName: 'previewPlan', args: [tIn, tOut, amountIn] });
      const [pv, fallbackRoute, hasFallback] = r as unknown as [Preview, Route, boolean];
      return { pv, fb: hasFallback ? fallbackRoute : undefined };
    } catch (e) {
      this.wrapReadError(e, 'quote');
    }
  }

  /** The Quoter's preview, read on your RPC. Throws BlazeError('no_route') when
   *  the Solver finds no executable path. */
  async quote(req: QuoteRequest): Promise<Quote> {
    const ctx = await this.ctx(req);
    const { tIn, tOut, amountIn, userMinOut } = await this.pair(ctx, req);
    const key = `Q|${ctx.chainId}|${ctx.dep.version}|${ctx.dep.contracts.quoter}|${tIn.address}|${tIn.native}|${tOut.address}|${tOut.native}|${amountIn}|${userMinOut}|${req.blockNumber ?? ''}`;
    const cacheable = this.cacheTtlMs > 0 && req.blockNumber === undefined;
    if (cacheable) {
      const hit = memGet(key, this.cacheTtlMs) as Quote | undefined;
      if (hit) return hit;
    }
    const q = await singleflight(key, async () => {
      const { pv, fb } = await this.readPreview(ctx, tIn.address, tOut.address, amountIn, userMinOut, req.blockNumber);
      return this.buildQuote(ctx, tIn, tOut, amountIn, pv, fb, req.blockNumber);
    });
    if (cacheable) memPut(key, q);
    return q;
  }

  /** Execution-grade re-quote (previewPlanExact): every concentrated leg is
   *  dry-run on the pool itself. Slower; derive a tight userMinOut from it. */
  async quoteExact(req: QuoteRequest): Promise<ExactQuote> {
    const ctx = await this.ctx(req);
    const { tIn, tOut, amountIn } = await this.pair(ctx, req);
    try {
      const [route, exactOut] = (await ctx.client.readContract({
        address: ctx.dep.contracts.quoter, abi: QUOTER_ABI, functionName: 'previewPlanExact',
        args: [tIn.address, tOut.address, amountIn],
        ...(req.blockNumber !== undefined ? { blockNumber: req.blockNumber } : {}),
      })) as unknown as [Route, bigint];
      return {
        chainId: ctx.chainId, version: ctx.dep.version, tokenIn: tIn.address, tokenOut: tOut.address,
        amountIn, exactOut, route, quotedAt: Date.now(),
      };
    } catch (e) {
      this.wrapReadError(e, 'exact quote');
    }
  }

  /** Many quotes. 2.x deployments answer in chunks of on-chain batchQuote
   *  (one eth_call per chunk); anything else, or a failed chunk, falls back
   *  to individual previews. Per-item failures come back inline. */
  async quoteBatch(reqs: QuoteRequest[]): Promise<BatchItem[]> {
    const fail = (e: unknown): BatchItem => ({
      ok: false,
      error: { code: e instanceof BlazeError ? e.code : 'error', message: (e as Error)?.message ?? String(e) },
    });
    const out: BatchItem[] = new Array(reqs.length);
    type Prepared = { i: number; ctx: Ctx; tIn: ResolvedToken; tOut: ResolvedToken; amountIn: bigint; userMinOut: bigint };
    const groups = new Map<string, Prepared[]>();
    const singles: number[] = [];
    await Promise.all(reqs.map(async (r, i) => {
      try {
        const ctx = await this.ctx(r);
        const p = await this.pair(ctx, r);
        if (ctx.features.batchQuote && r.blockNumber === undefined) {
          const k = `${ctx.chainId}|${ctx.dep.contracts.quoter}`;
          const g = groups.get(k) ?? [];
          g.push({ i, ctx, ...p });
          groups.set(k, g);
        } else {
          singles.push(i);
        }
      } catch (e) { out[i] = fail(e); }
    }));
    const runSingle = async (i: number) => {
      try { out[i] = { ok: true, quote: await this.quote(reqs[i]) }; } catch (e) { out[i] = fail(e); }
    };
    const tasks: Promise<void>[] = singles.map(runSingle);
    for (const g of groups.values()) {
      for (let s = 0; s < g.length; s += this.batchChunk) {
        const chunk = g.slice(s, s + this.batchChunk);
        tasks.push((async () => {
          const { ctx } = chunk[0];
          try {
            const previews = (await ctx.client.readContract({
              address: ctx.dep.contracts.quoter, abi: QUOTER_ABI, functionName: 'batchQuote',
              args: [chunk.map((p) => ({ tIn: p.tIn.address, tOut: p.tOut.address, amountIn: p.amountIn, userMinOut: p.userMinOut }))],
            })) as unknown as Preview[];
            chunk.forEach((p, j) => {
              const pv = previews[j];
              if (!pv || pv.route.hops.length === 0) {
                out[p.i] = { ok: false, error: { code: 'no_route', message: 'no executable route for this pair and size' } };
              } else {
                out[p.i] = { ok: true, quote: this.buildQuote(ctx, p.tIn, p.tOut, p.amountIn, pv, undefined) };
              }
            });
          } catch {
            await Promise.all(chunk.map((p) => runSingle(p.i)));
          }
        })());
      }
    }
    await Promise.all(tasks);
    return out;
  }

  // ── swaps ──────────────────────────────────────────────────────────────────

  /**
   * Quote and prepare the swap transaction(s): the exact calldata to send, the
   * minimum it enforces, and the approval step when one is needed. Nothing is
   * signed or sent — `execute` does that with YOUR wallet.
   */
  async buildSwap(req: SwapRequest): Promise<SwapPlan> {
    const ctx = await this.ctx(req);
    const { tIn, tOut, amountIn, userMinOut } = await this.pair(ctx, req);
    if (!req.recipient || !HEX_ADDR.test(req.recipient)) throw new BlazeError('bad_request', 'recipient must be a 0x address');
    const recipient = getAddress(req.recipient);
    if (req.from !== undefined && !HEX_ADDR.test(req.from)) throw new BlazeError('bad_request', 'from must be a 0x address');
    const from = req.from ? getAddress(req.from) : undefined;
    const slippageBps = req.slippageBps ?? this.slippageBps;
    minOutFor(0n, slippageBps, 0n); // validate
    const deadline = req.deadline ?? BigInt(Math.floor(Date.now() / 1000) + checkDeadlineSec(req.deadlineSec ?? this.deadlineSec));
    const mode = req.mode ?? 'route';
    const { features } = ctx;
    const router = ctx.dep.contracts.router;

    if (tIn.native && !features.nativeEntry) {
      throw new BlazeError('unsupported_by_version',
        `native ETH input needs a 2.x Router (this deployment is ${ctx.dep.version}): wrap first with buildWrapTx(chain, amount), then swap WETH`);
    }
    if (mode === 'best' && !features.swapBest) {
      throw new BlazeError('unsupported_by_version', `mode 'best' (swapBestExactIn) needs a 2.x Router (this deployment is ${ctx.dep.version})`);
    }
    if (mode === 'best' && tIn.native) {
      throw new BlazeError('bad_request', "mode 'best' pulls an ERC-20 — use WETH as tokenIn, or mode 'route' for native ETH");
    }

    let pv: Preview;
    let fb: Route | undefined;
    let data: Hex;
    let encodedBy: SwapPlan['encodedBy'] = 'sdk';
    let entry: SwapPlan['entry'];
    let minOut: bigint;

    if (features.previewAndEncode && !tIn.native && mode === 'route') {
      // 2.x: ONE eth_call returns the preview AND the Router calldata that executes it.
      let call: Hex;
      try {
        const r = userMinOut > 0n
          ? await ctx.client.readContract({
            address: ctx.dep.contracts.quoter, abi: QUOTER_ABI, functionName: 'previewAndEncodeWithMinOut',
            args: [tIn.address, tOut.address, amountIn, userMinOut, recipient, deadline],
          })
          : await ctx.client.readContract({
            address: ctx.dep.contracts.quoter, abi: QUOTER_ABI, functionName: 'previewAndEncode',
            args: [tIn.address, tOut.address, amountIn, recipient, deadline],
          });
        [pv, call] = r as unknown as [Preview, Hex];
      } catch (e) {
        this.wrapReadError(e, 'previewAndEncode');
      }
      assertExecutable(pv, tIn.address, tOut.address, call);
      minOut = maxBig(minOutFor(pv.netOut, slippageBps, pv.effectiveMinOut), userMinOut);
      verifySwapExactIn(call, {
        tokenIn: tIn.address, tokenOut: tOut.address, amountIn, recipient, deadline,
        minOutAtLeast: pv.effectiveMinOut, route: pv.route,
      });
      data = tightenMinOut(call, minOut);
      encodedBy = 'quoter';
      entry = 'swapExactIn';
    } else {
      ({ pv, fb } = await this.readPreview(ctx, tIn.address, tOut.address, amountIn, userMinOut));
      assertExecutable(pv, tIn.address, tOut.address);
      minOut = maxBig(minOutFor(pv.netOut, slippageBps, pv.effectiveMinOut), userMinOut);
      if (mode === 'best') {
        entry = 'swapBestExactIn';
        data = encodeSwapBestExactIn(tIn.address, tOut.address, amountIn, minOut, recipient, deadline);
      } else if (tIn.native) {
        entry = 'swapExactInNative';
        data = encodeSwapExactInNative(pv.route, minOut, recipient, deadline);
      } else {
        entry = 'swapExactIn';
        data = encodeSwapExactIn(pv.route, amountIn, minOut, recipient, deadline);
      }
    }

    const tx: TxRequest = { chainId: ctx.chainId, to: router, data, value: tIn.native ? amountIn : 0n };

    let approval: ApprovalStep | null = null;
    if (!tIn.native) {
      const want = req.approve === 'max' ? MAX_UINT256 : amountIn;
      let current: bigint | undefined;
      if (from) {
        current = await ctx.client.readContract({
          address: tIn.address, abi: ERC20_ABI, functionName: 'allowance', args: [from, router],
        }).catch((e: unknown) => this.wrapReadError(e, 'allowance'));
      }
      if (current === undefined || current < amountIn) {
        approval = {
          token: tIn.address, spender: router, amount: want,
          ...(current !== undefined ? { current } : {}),
          tx: buildApproveTx({ chain: ctx.chainId, token: tIn.address, amount: want, spender: router }),
        };
      }
    }

    const quote = this.buildQuote(ctx, tIn, tOut, amountIn, pv, fb);
    return {
      quote, entry, encodedBy, tx, recipient, minOut, deadline, slippageBps, approval,
      unwrapAfter: tOut.native,
      steps: approval ? [approval.tx, tx] : [tx],
    };
  }

  /** eth_call the swap from `from` on your RPC: the realised amountOut if it
   *  would settle now, or the decoded reason it would revert. */
  async simulate(plan: SwapPlan, from: Address): Promise<SimulationResult> {
    if (plan.approval && plan.approval.current !== undefined && plan.approval.current < plan.quote.amountIn) {
      return { ok: false, error: { contract: 'unknown', name: 'allowance', reason: 'the Router is not approved for tokenIn yet — send plan.approval.tx first' } };
    }
    const client = await this.rpc.client(plan.tx.chainId);
    try {
      const { data } = await client.call({ account: from, to: plan.tx.to, data: plan.tx.data, value: plan.tx.value });
      const amountOut = data && data !== '0x'
        ? (decodeFunctionResult({ abi: ROUTER_ABI, functionName: plan.entry, data }) as bigint)
        : undefined;
      return { ok: true, ...(amountOut !== undefined ? { amountOut } : {}) };
    } catch (e) {
      if (isTransportError(e)) throw new BlazeError('rpc_error', `simulation: your RPC failed (${(e as Error)?.message?.split('\n')[0]})`, { cause: e });
      const d = decodeBlazeError(e);
      return { ok: false, error: d ?? { contract: 'unknown', name: 'revert', reason: (e as Error)?.message?.split('\n')[0] ?? 'execution reverted' } };
    }
  }

  /**
   * Execute with YOUR wallet: approve when needed (exact amount by default),
   * simulate, send the swap, and read the realised output from the receipt.
   * The SDK never holds or asks for a key — the WalletClient signs.
   */
  async execute(opts: ExecuteOptions): Promise<ExecuteResult> {
    const { wallet } = opts;
    const account = wallet.account;
    if (!account) throw new BlazeError('bad_request', 'wallet has no account — create the WalletClient with an account');
    let plan = opts.plan;
    const req = opts.request;
    const maxAge = opts.maxQuoteAgeMs ?? 30_000;
    if (!plan) {
      if (!req) throw new BlazeError('bad_request', 'execute needs a plan or a request');
      plan = await this.buildSwap({ ...req, from: req.from ?? account.address });
    } else if (Date.now() - plan.quote.quotedAt > maxAge) {
      if (!req) throw new BlazeError('bad_request', `plan is older than ${maxAge}ms — pass \`request\` so it can be rebuilt, or rebuild it yourself`);
      plan = await this.buildSwap({ ...req, from: req.from ?? account.address });
    }
    const walletChain = await wallet.getChainId();
    if (walletChain !== plan.tx.chainId) {
      throw new BlazeError('wallet_chain_mismatch', `wallet is on chain ${walletChain}, the swap is on ${plan.tx.chainId} — switch the wallet first`);
    }
    const client = await this.rpc.client(plan.tx.chainId);
    const wait = opts.wait ?? true;
    // The wallet's own chain when it has one (viem then asserts it again at
    // send time); null otherwise — we already checked the chain id above.
    const send = (tx: TxRequest) => wallet.sendTransaction({
      account, chain: wallet.chain ?? null, to: tx.to, data: tx.data, value: tx.value,
    } as never) as Promise<Hex>;

    let approvalHash: Hex | undefined;
    if (plan.approval) {
      const current = await client.readContract({
        address: plan.approval.token, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, plan.approval.spender],
      });
      if (current < plan.quote.amountIn) {
        approvalHash = await send(plan.approval.tx);
        const r = await client.waitForTransactionReceipt({ hash: approvalHash });
        if (r.status !== 'success') throw new BlazeError('reverted', `approval transaction reverted (${approvalHash})`);
      }
      plan = { ...plan, approval: { ...plan.approval, current: plan.approval.amount } };
    }
    if (opts.simulate ?? true) {
      const sim = await this.simulate(plan, account.address);
      if (!sim.ok) {
        throw new BlazeError('reverted', `simulation says the swap would revert: ${sim.error?.name}${sim.error?.code !== undefined ? `(${sim.error.code})` : ''} — ${sim.error?.reason}`, sim.error ? { revert: sim.error } : {});
      }
    }
    const hash = await send(plan.tx);
    if (!wait) return { plan, ...(approvalHash ? { approvalHash } : {}), hash };
    const receipt = await client.waitForTransactionReceipt({ hash });
    let amountOut: bigint | undefined;
    if (receipt.status === 'success') {
      const logs = parseEventLogs({ abi: ROUTER_ABI, logs: receipt.logs, eventName: 'Swap' })
        .filter((l) => l.address.toLowerCase() === plan!.tx.to.toLowerCase());
      if (logs.length) amountOut = (logs[logs.length - 1].args as { amountOut: bigint }).amountOut;
    }
    return {
      plan, ...(approvalHash ? { approvalHash } : {}), hash,
      status: receipt.status, blockNumber: receipt.blockNumber, ...(amountOut !== undefined ? { amountOut } : {}),
    };
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  /** symbol / name / decimals, read on your RPC. */
  async tokenInfo(chain: string | number | undefined, token: string): Promise<TokenInfo> {
    const chainId = chain !== undefined ? resolveChain(chain) : await this.rpc.defaultChain();
    const client = await this.rpc.client(chainId);
    const t = this.resolveToken(chainId, token, 'tokenIn');
    if (t.native) return { chainId, address: NATIVE_TOKEN, symbol: 'ETH', name: 'Ether', decimals: 18, native: true };
    try {
      const [symbol, name, decimals] = await Promise.all([
        client.readContract({ address: t.address, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => '?'),
        client.readContract({ address: t.address, abi: ERC20_ABI, functionName: 'name' }).catch(() => ''),
        this.decimalsOf(client, chainId, t),
      ]);
      return { chainId, address: t.address, symbol, name, decimals, native: false };
    } catch (e) {
      throw new BlazeError('bad_request', `${t.address} does not answer decimals() on ${CHAINS[chainId].name} — not an ERC-20?`, { cause: e });
    }
  }

  /** The staking engine's live proof-of-solvency (Base), read on your RPC. */
  async solvency(chain: string | number = 8453): Promise<SolvencyReport> {
    const chainId = resolveChain(chain);
    const staking = CHAINS[chainId].staking;
    if (!staking) throw new BlazeError('not_deployed', `no BlazePhoenix staking engine on ${CHAINS[chainId].name}`);
    const client = await this.rpc.client(chainId);
    const blockNumber = await client.getBlockNumber();
    const [r, isSolvent] = await Promise.all([
      client.readContract({ address: staking, abi: STAKING_SOLVENCY_ABI, functionName: 'solvency', blockNumber }),
      client.readContract({ address: staking, abi: STAKING_SOLVENCY_ABI, functionName: 'isSolvent', blockNumber }),
    ]);
    const s = r as unknown as Omit<SolvencyReport, 'chainId' | 'staking' | 'isSolvent' | 'blockNumber'> & { solvent: boolean };
    return {
      chainId, staking, isSolvent,
      backing: s.backing, owed: s.owed, surplus: s.surplus, deficit: s.deficit,
      collateralRatioWad: s.collateralRatioWad, totalStaked: s.totalStaked, totalDebt: s.totalDebt,
      rewardReserve: s.rewardReserve, protocolReserve: s.protocolReserve,
      pendingDistribution: s.pendingDistribution, totalBadDebt: s.totalBadDebt,
      totalUncollectedInterest: s.totalUncollectedInterest, blockNumber,
    };
  }

  /** Router fills over a block range (Swap events; 2.x adds ExecutionProof).
   *  The range is read in chunks (`chunkBlocks`, default 2000) because most
   *  providers cap eth_getLogs ranges — especially on free tiers. */
  async getFills(opts: {
    chain?: string | number; version?: string; fromBlock?: bigint; toBlock?: bigint;
    lookbackBlocks?: bigint; chunkBlocks?: bigint;
  }): Promise<Fill[]> {
    const ctx = await this.ctx(opts);
    const toBlock = opts.toBlock ?? await ctx.client.getBlockNumber();
    const span = opts.lookbackBlocks ?? BigInt(Math.ceil(3_600 / CHAINS[ctx.chainId].blockTime)); // ~1h
    const fromBlock = opts.fromBlock ?? (toBlock > span ? toBlock - span : 0n);
    if (fromBlock > toBlock) throw new BlazeError('bad_request', 'fromBlock is after toBlock');
    const chunk = opts.chunkBlocks && opts.chunkBlocks > 0n ? opts.chunkBlocks : 2_000n;
    const router = ctx.dep.contracts.router;
    const fills: Fill[] = [];
    for (let start = fromBlock; start <= toBlock; start += chunk) {
      const end = start + chunk - 1n > toBlock ? toBlock : start + chunk - 1n;
      const raw = await ctx.client.getLogs({ address: router, fromBlock: start, toBlock: end })
        .catch((e: unknown) => this.wrapReadError(e, `getLogs ${start}-${end}`));
      fills.push(...toFills(raw));
    }
    return fills;
  }

  /** Stream fills as they land (polling your RPC). Returns an unwatch function. */
  async watchFills(opts: { chain?: string | number; version?: string; pollMs?: number; onFill: (f: Fill) => void; onError?: (e: unknown) => void }): Promise<() => void> {
    const ctx = await this.ctx(opts);
    return ctx.client.watchEvent({
      address: ctx.dep.contracts.router,
      pollingInterval: opts.pollMs ?? 4_000,
      onError: opts.onError,
      onLogs: (logs) => { for (const f of toFills(logs as never)) opts.onFill(f); },
    });
  }

  /** The chains × versions table this client sees (embedded + registry + overrides). */
  async deployments() {
    await this.registry.ready();
    return { registry: this.registry.status(), rows: this.registry.table() };
  }

  /** Which deployment a request would use right now (no RPC). */
  async resolveDeployment(req: { chain: string | number; version?: string }): Promise<ResolvedDeployment & { features: VersionFeatures }> {
    await this.registry.ready();
    const dep = this.registry.resolve(resolveChain(req.chain), req.version ?? this.version);
    return { ...dep, features: featuresOf(dep.version) };
  }
}

function toFills(raw: readonly { transactionHash: Hex | null; blockNumber: bigint | null; logIndex: number | null }[]): Fill[] {
  const parsed = parseEventLogs({ abi: ROUTER_ABI, logs: raw as never });
  const fills: Fill[] = [];
  const proofs = new Map<string, { quoted: bigint; realized: bigint; floorUsed: bigint }>();
  for (const l of parsed) {
    if (l.eventName === 'ExecutionProof') {
      const a = l.args as { quoted: bigint; realized: bigint; floorUsed: bigint };
      proofs.set(`${l.transactionHash}|${(l.logIndex ?? 0) - 1}`, { quoted: a.quoted, realized: a.realized, floorUsed: a.floorUsed });
    }
  }
  for (const l of parsed) {
    if (l.eventName !== 'Swap') continue;
    const a = l.args as { user: Address; tokenIn: Address; tokenOut: Address; amountIn: bigint; amountOut: bigint; legs: bigint };
    const proof = proofs.get(`${l.transactionHash}|${l.logIndex ?? 0}`);
    fills.push({
      txHash: l.transactionHash as Hex, blockNumber: l.blockNumber ?? 0n, logIndex: l.logIndex ?? 0,
      user: a.user, tokenIn: a.tokenIn, tokenOut: a.tokenOut, amountIn: a.amountIn, amountOut: a.amountOut, legs: a.legs,
      ...(proof ? { proof } : {}),
    });
  }
  return fills;
}

function assertExecutable(pv: Preview, tokenIn: Address, tokenOut: Address, call?: Hex): void {
  if (!pv.canExecute || (call !== undefined && (call === '0x' || call.length < 10))) {
    throw new BlazeError('not_executable',
      `the Quoter says this route cannot execute now (netOut ${pv.netOut}, effectiveMinOut ${pv.effectiveMinOut}) — `
      + 'try a smaller size, a looser userMinOut, or another pair',
      { details: { netOut: pv.netOut.toString(), effectiveMinOut: pv.effectiveMinOut.toString() } });
  }
  if (!routeIsConsistent(pv.route, tokenIn, tokenOut)) {
    throw new BlazeError('calldata_mismatch', 'the previewed route does not connect tokenIn → tokenOut — refused');
  }
}

function checkDeadlineSec(n: number): number {
  if (!Number.isInteger(n) || n < 10 || n > 3_600) {
    throw new BlazeError('bad_request', 'deadlineSec must be an integer between 10 and 3600');
  }
  return n;
}

const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);

// ── deep links (no RPC) ──────────────────────────────────────────────────────

export interface DeepLinkOptions {
  chain?: number | string;
  tokenIn?: string;
  tokenOut?: string;
  /** Human units for the pay field (e.g. "0.5"). */
  amount?: string;
  tab?: 'home' | 'swap' | 'staking' | 'airdrop' | 'api';
  baseUrl?: string;
}

/** A link that opens the site pre-filled — bot buttons, referral posts. */
export function deepLink(opts: DeepLinkOptions = {}): string {
  const base = (opts.baseUrl ?? 'https://blazephoenix.xyz').replace(/\/+$/, '');
  const sp = new URLSearchParams();
  sp.set('tab', opts.tab ?? 'swap');
  if (opts.chain !== undefined) sp.set('chain', String(resolveChain(opts.chain)));
  if (opts.tokenIn) sp.set('in', opts.tokenIn);
  if (opts.tokenOut) sp.set('out', opts.tokenOut);
  if (opts.amount) sp.set('amt', opts.amount);
  return `${base}/?${sp.toString()}`;
}

export interface PollOptions {
  /** Tick interval in ms (min 500, default 4000). */
  intervalMs?: number;
  onError?: (e: unknown) => void;
}

/** Poll a pair on your RPC; overlap-safe (a slow tick is skipped, not stacked). */
export function pollQuote(
  client: BlazePhoenix,
  req: QuoteRequest,
  onQuote: (q: Quote) => void,
  opts: PollOptions = {},
): () => void {
  const interval = Math.max(500, opts.intervalMs ?? 4_000);
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const q = await client.quote(req);
      if (!stopped) onQuote(q);
    } catch (e) {
      if (!stopped) opts.onError?.(e);
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, interval);
  return () => { stopped = true; clearInterval(timer); };
}
