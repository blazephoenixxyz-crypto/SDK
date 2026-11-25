// Deterministic fakes for findToken: no network. The reader quotes each token over one venue with
// a constant-product curve (reserves rt / rp); balanceOf answers separate balances, so a venue can
// hold far more than its curve can sell (the concentrated, out-of-range case). A `linear` venue
// quotes at the fixed price rp / rt with no impact, so a sizing test can pin exact amounts.
// Blocks: an unpinned read runs at a new head (block 1, 2, ...) and answers its hash; a read pinned
// by hash runs at that block. `driftBps` lowers every quote by that many bps per block (the market
// moving between reads); `reorgAfter` makes pinned reads after the first n fail as a lost block;
// `noHash` answers no block hash at all.
import { getAddress, type Address, type Hex } from 'viem';
import { CHAINS } from '../../src/constants.js';
import type { UsdValue } from '../../src/usd.js';
import type { FindReader } from '../../src/find/index.js';

export const USDC = getAddress(CHAINS[8453].usdc);
export const WETH = getAddress(CHAINS[8453].weth);
/** One WETH quotes 3000 USDC. */
export const WETH_USD = 3000n * 10n ** 6n;

export const addr = (n: number): Address => getAddress('0x' + n.toString(16).padStart(40, '0'));

export interface FakeVenue { pairAddress: Address; kind: number; pair: Address; rt: bigint; rp: bigint; balT: bigint; balP: bigint; linear?: boolean }
export interface FakeToken { code?: boolean; symbol: string | null; name: string | null; decimals: number | null; venue?: FakeVenue }

export const hashOf = (block: number): Hex => `0x${block.toString(16).padStart(64, '0')}`;

function value(token: Address, amountIn: bigint, usd: bigint | null, route: UsdValue['vias'][number]['legs'][number]['route'], block: number | null = null): UsdValue {
  return {
    chainId: 8453, version: '1', label: 'USD (via USDC)', dollarToken: USDC, dollarDecimals: usd === null ? null : 6, token, amountIn,
    tokenDecimals: null, blockNumber: block === null ? null : BigInt(block), blockHash: block === null ? null : hashOf(block), blockTimestamp: null, usdValue: usd, usd: usd === null ? 'not measured' : String(usd),
    unitPrice: 'not measured', spread: null, rpc: { requests: 1 }, basis: 'fake',
    vias: [usd === null
      ? { path: [token, USDC], status: 'not measured', reason: 'empty route', legs: [] }
      : { path: [token, USDC], status: 'measured', usd, legs: [{ tokenIn: token, tokenOut: USDC, amountIn, out: usd, route }] }],
  };
}

export interface FakeChain { driftBps?: bigint; reorgAfter?: number; noHash?: boolean }

export function fakeReader(tokens: Record<string, FakeToken>, chain: FakeChain = {}) {
  const calls = { usdValue: 0, balanceOf: 0, log: [] as { token: Address; amountIn: bigint; blockHash: Hex | undefined }[] };
  let head = 0, pinned = 0;
  const get = (a: string) => tokens[a.toLowerCase()];
  const reader: FindReader = {
    hasCode: async (a) => get(a)?.code ?? true,
    erc20: async (a) => { const t = get(a); return { symbol: t?.symbol ?? null, name: t?.name ?? null, decimals: t?.decimals ?? null }; },
    balanceOf: async (t, h) => {
      calls.balanceOf++;
      for (const [k, v] of Object.entries(tokens)) {
        const ven = v.venue;
        if (!ven || ven.pairAddress.toLowerCase() !== h.toLowerCase()) continue;
        if (t.toLowerCase() === k) return ven.balT;
        if (t.toLowerCase() === ven.pair.toLowerCase()) return ven.balP;
      }
      return null;
    },
    usdValue: async (token, amountIn, blockHash?: Hex) => {
      calls.usdValue++;
      calls.log.push({ token, amountIn, blockHash });
      let block: number;
      if (blockHash === undefined) block = ++head;
      else {
        block = Number(BigInt(blockHash));
        if (block < 1 || block > head || hashOf(block) !== blockHash.toLowerCase()) throw new Error(`usdValue: your RPC has no block ${blockHash} (the node never saw it)`);
        if (chain.reorgAfter !== undefined && ++pinned > chain.reorgAfter) throw new Error(`usdValue: your RPC has no block ${blockHash} (a reorg replaced it, or the node never saw it)`);
      }
      const at = chain.noHash ? null : block;
      const moved = (x: bigint) => (x * (10_000n - (chain.driftBps ?? 0n) * BigInt(block))) / 10_000n;
      if (token.toLowerCase() === WETH.toLowerCase()) return value(token, amountIn, moved((amountIn * WETH_USD) / 10n ** 18n), [], at);
      const v = get(token)?.venue;
      if (!v) return value(token, amountIn, null, [], at);
      const out = moved(v.linear ? (v.rp * amountIn) / v.rt : (v.rp * amountIn) / (v.rt + amountIn));
      const usd = v.pair === WETH ? (out * WETH_USD) / 10n ** 18n : out;
      return value(token, amountIn, usd, [{ tokenIn: token, tokenOut: v.pair, amountIn, out, legs: [{ pool: v.pairAddress, kind: v.kind, amountIn, out }] }], at);
    },
  };
  return { reader, calls };
}

/** fetch answering CoinGecko and Dexscreener from fixed JSON; a source set to 'down' throws. */
export function fakeFetch(opts: { cg?: { coins: any[]; details: Record<string, any> } | 'down'; dex?: { pairs: any[] } | 'down' }): typeof fetch {
  const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  return (async (input: any) => {
    const url = String(input);
    if (url.startsWith('https://api.coingecko.com/')) {
      if (opts.cg === 'down' || opts.cg === undefined) throw new Error('getaddrinfo ENOTFOUND api.coingecko.com');
      const m = url.match(/\/coins\/([^?]+)\?/);
      return m ? json(opts.cg.details[decodeURIComponent(m[1])] ?? {}) : json({ coins: opts.cg.coins });
    }
    if (url.startsWith('https://api.dexscreener.com/')) {
      if (opts.dex === 'down' || opts.dex === undefined) throw new Error('getaddrinfo ENOTFOUND api.dexscreener.com');
      return json({ pairs: opts.dex.pairs });
    }
    throw new Error(`unexpected url ${url}`);
  }) as typeof fetch;
}

/** A Dexscreener pair on Base whose base token is (address, symbol, name). */
export const dexPair = (address: string, symbol: string, name = symbol) => ({ chainId: 'base', pairAddress: addr(0xdead), baseToken: { address, symbol, name }, quoteToken: { address: USDC, symbol: 'USDC', name: 'USD Coin' } });
