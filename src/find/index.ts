// @blazephoenix/sdk/find: find a token by name or ticker. Third-party indexes only PROPOSE
// addresses; every candidate is then read on the caller's RPC (code, symbol, name, decimals),
// checked for Unicode lookalikes, and ranked by the depth the BlazePhoenix Quoter MEASURES
// (usdValue at a ladder of order sizes). Venue balances are shown beside depth, never instead
// of it. Nothing is ever selected: the caller picks, and the warnings say why that is hard.
import { createPublicClient, getAddress, parseAbi, type Address } from 'viem';
import { BlazePhoenix } from '../client.js';
import { CHAINS, resolveChain } from '../constants.js';
import { BlazeError } from '../errors.js';
import { transportFrom, type RpcSource } from '../rpc.js';
import type { UsdValue } from '../usd.js';
import { lookalike, skeleton, tokenText, visibleText, type LookalikeReport } from '../text.js';
import { runXray, type Transport as XrayTransport, type XrayReport } from '../xray/index.js';
import { fromCoinGecko, fromDexscreener, type SourceStatus } from './sources.js';

export { lookalike, skeleton, tokenText, visibleText, type LookalikeReport } from '../text.js';
export { COINGECKO_COIN_CAP, COINGECKO_PLATFORM, DEXSCREENER_CHAIN, matchesQuery, type SourceStatus } from './sources.js';

/** Order sizes in whole US dollars (the dollar token taken as 1 USD), smallest first. */
export const DEFAULT_SIZES_USD: readonly number[] = [10, 100, 1_000, 10_000, 100_000, 1_000_000];
export const IMPACT_1PCT_BPS = 100;
export const IMPACT_5PCT_BPS = 500;
export const DEFAULT_MAX_CANDIDATES = 10;
/** Venue kinds whose own address holds the venue's token balances (bp-dex BlazePhoenixCore.sol:
 *  KIND_V2 0, KIND_V3 1, KIND_SOLIDLY 5, KIND_ALGEBRA 6). Any other kind is NOT_MEASURED. */
export const BALANCE_KINDS: readonly number[] = [0, 1, 5, 6];
/** KIND_V4 4 and KIND_V4_NATIVE 8: balances sit in the shared PoolManager. */
export const V4_KINDS: readonly number[] = [4, 8];

export const WARNINGS = {
  mostLiquid: 'The first candidate is the most liquid by measured depth. It is not "official": no list here is.',
  dyor: (n: number) => `${n} tokens use this ticker; impostors copy tickers; do your own research.`,
  notSafety: 'Liquidity is not safety: it can be withdrawn at any time.',
  liquidityVsDepth: 'Liquidity is the token balances the venues hold, valued at the measured marginal price; depth is what the Quoter measures can be sold before 1% / 5% price impact. In concentrated-liquidity venues (V3, V4) much of the balance can sit outside the current price range: high liquidity can come with low depth. Candidates are ranked by depth.',
  v4: 'Liquidity of a Uniswap V4 venue is NOT_MEASURED: its balances sit in the shared PoolManager, not at the venue, and no per-venue balance is read or estimated.',
  trust: 'Candidates come from third-party indexes (CoinGecko, Dexscreener): they only propose addresses. Everything shown about a candidate is read on your RPC.',
} as const;

const BASIS = "Depth: usdValue (the BlazePhoenix Quoter's netOut in the dollar token, the minimum over its vias) at each order size, "
  + 'on your RPC. Impact at a size is measured against the rate at the smallest size and rounded up. "Sells up to" is the largest '
  + 'size of the ladder within the threshold, every smaller size within it too: a lower bound, not the exact depth.';

/** What findToken reads on chain. Built from `rpc` by default; inject one to test or to reuse a client. */
export interface FindReader {
  hasCode(address: Address): Promise<boolean>;
  erc20(address: Address): Promise<{ symbol: string | null; name: string | null; decimals: number | null }>;
  balanceOf(token: Address, holder: Address): Promise<bigint | null>;
  usdValue(token: Address, amountIn: bigint): Promise<UsdValue>;
}

export interface FindTokenRequest {
  /** A name or ticker, e.g. "PEPE". */
  query: string;
  chainId: number;
  /** YOUR RPC for this chain. */
  rpc?: RpcSource;
  /** A client to quote with (default: one built on `rpc`). */
  client?: BlazePhoenix;
  /** Order sizes in whole USD, ascending (default DEFAULT_SIZES_USD). */
  sizes?: readonly number[];
  /** Run the X-Ray on every candidate with code, through this transport. Off when omitted. */
  xray?: { transport: XrayTransport; maxTaxBps?: number };
  /** fetch for the indexes (default globalThis.fetch). */
  fetch?: typeof fetch;
  maxCandidates?: number;
  reader?: FindReader;
}

export type Status = 'MEASURED' | 'NOT_MEASURED';

export interface DepthRung {
  usdSize: number;
  amountIn: bigint;
  /** Dollar-token base units the Quoter answered; null when not measured. */
  usdOut: bigint | null;
  /** Impact against the smallest size, basis points, rounded up; null when not measured. */
  impactBps: number | null;
  reason?: string;
}

export interface DepthReach { amountIn: bigint; usdOut: bigint; usdSize: number }

export interface Depth {
  status: Status;
  reason?: string;
  dollarToken: Address | null;
  dollarDecimals: number | null;
  rungs: DepthRung[];
  /** Sells up to this before 1% impact (lower bound); null when not measured. */
  upTo1pct: DepthReach | null;
  upTo5pct: DepthReach | null;
}

export interface VenueBalance { token: Address; amount: bigint | null; usd: bigint | null }
export interface VenueLiquidity {
  pairAddress: Address;
  kind: number;
  status: Status;
  reason?: string;
  balances: VenueBalance[];
  /** Dollar-token base units; null unless both balances were read and valued. */
  usd: bigint | null;
}

export interface Liquidity {
  venues: VenueLiquidity[];
  /** Sum over MEASURED venues; null when none was. */
  totalUsd: bigint | null;
  /** false when any venue is NOT_MEASURED: then totalUsd is a lower bound. */
  complete: boolean;
}

export interface Candidate {
  address: Address;
  /** 1 = deepest. Rank orders by measured depth; it does not pick. */
  rank: number;
  label?: 'most liquid';
  sources: SourceStatus['name'][];
  hasCode: boolean | null;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  lookalike: { suspicious: boolean; symbol: LookalikeReport | null; name: LookalikeReport | null };
  depth: Depth;
  liquidity: Liquidity;
  xray?: XrayReport | { error: string };
  reason?: string;
}

export interface FindTokenResult {
  query: string;
  chainId: number;
  candidates: Candidate[];
  sources: SourceStatus[];
  /** Proposed addresses left out by maxCandidates. */
  omitted: number;
  warnings: string[];
  basis: string;
}

const msg = (e: unknown) => tokenText(e instanceof Error ? e.message : String(e), 200);
const lc = (a: string) => a.toLowerCase();

function validSizes(sizes: readonly number[]): readonly number[] {
  const ok = Array.isArray(sizes) && sizes.length > 0 && sizes.length <= 20
    && sizes.every((s, i) => Number.isSafeInteger(s) && s > 0 && (i === 0 || s > sizes[i - 1]));
  if (!ok) throw new BlazeError('bad_request', 'sizes: 1 to 20 whole-dollar sizes, positive integers, strictly ascending');
  return sizes;
}

/** Impact of rung i against rung 0, in bps, rounded up: 10000 − floor(10000·(out·amt0)/(out0·amt)). */
export function impactBps(out0: bigint, amt0: bigint, out: bigint, amt: bigint): number {
  const ratio = (10_000n * out * amt0) / (out0 * amt);
  return Number(10_000n - ratio);
}

/** The largest rung within the threshold with every smaller rung within it too. */
export function reach(rungs: readonly DepthRung[], thresholdBps: number): DepthReach | null {
  let best: DepthReach | null = null;
  for (const r of rungs) {
    if (r.amountIn === 0n && best === null) continue;
    if (r.usdOut === null || r.impactBps === null || r.impactBps > thresholdBps) break;
    best = { amountIn: r.amountIn, usdOut: r.usdOut, usdSize: r.usdSize };
  }
  return best;
}

const notMeasured = (reason: string, u?: UsdValue): Depth => ({
  status: 'NOT_MEASURED', reason, dollarToken: u?.dollarToken ?? null, dollarDecimals: u?.dollarDecimals ?? null, rungs: [], upTo1pct: null, upTo5pct: null,
});

function viaReason(u: UsdValue): string {
  return u.vias.map((v) => v.reason).filter((r): r is string => typeof r === 'string').map((r) => tokenText(r, 120)).join('; ') || 'no via measured';
}

/** The venues of the via that gave usdValue (the minimum), with the hop's two tokens. */
function routeVenues(u: UsdValue): { pairAddress: Address; kind: number; tokens: [Address, Address] }[] {
  const via = u.vias.find((v) => v.status === 'measured' && v.usd === u.usdValue);
  const out: { pairAddress: Address; kind: number; tokens: [Address, Address] }[] = [];
  for (const leg of via?.legs ?? []) for (const hop of leg.route ?? []) for (const g of hop.legs)
    out.push({ pairAddress: getAddress(g.pool), kind: Number(g.kind), tokens: [getAddress(hop.tokenIn), getAddress(hop.tokenOut)] });
  return out;
}

async function measureDepth(reader: FindReader, token: Address, decimals: number, sizes: readonly number[]): Promise<{ depth: Depth; venues: ReturnType<typeof routeVenues> }> {
  const probe = await reader.usdValue(token, 10n ** BigInt(decimals));
  if (probe.usdValue === null || probe.dollarDecimals === null) return { depth: notMeasured(`price probe at one whole token not measured: ${viaReason(probe)}`, probe), venues: [] };
  if (probe.usdValue === 0n) return { depth: notMeasured('price probe at one whole token quoted 0 dollar-token units', probe), venues: [] };
  const dd = probe.dollarDecimals;
  const rungs: DepthRung[] = [];
  const venues: ReturnType<typeof routeVenues> = [];
  for (const usdSize of sizes) {
    const amountIn = (BigInt(usdSize) * 10n ** BigInt(dd) * 10n ** BigInt(decimals)) / probe.usdValue;
    if (amountIn === 0n) { rungs.push({ usdSize, amountIn, usdOut: null, impactBps: null, reason: 'size below one base unit' }); continue; }
    let u: UsdValue;
    try { u = await reader.usdValue(token, amountIn); } catch (e) { rungs.push({ usdSize, amountIn, usdOut: null, impactBps: null, reason: msg(e) }); break; }
    if (u.usdValue === null || u.usdValue === 0n) { rungs.push({ usdSize, amountIn, usdOut: null, impactBps: null, reason: u.usdValue === null ? viaReason(u) : 'quoted 0' }); break; }
    const ref = rungs.find((r) => r.usdOut !== null);
    const imp = ref ? impactBps(ref.usdOut!, ref.amountIn, u.usdValue, amountIn) : 0;
    rungs.push({ usdSize, amountIn, usdOut: u.usdValue, impactBps: imp });
    for (const v of routeVenues(u)) if (!venues.some((x) => lc(x.pairAddress) === lc(v.pairAddress))) venues.push(v);
    if (imp > IMPACT_5PCT_BPS) break;
  }
  const upTo1pct = reach(rungs, IMPACT_1PCT_BPS);
  if (upTo1pct === null) return { depth: { ...notMeasured(rungs[0]?.reason ?? 'smallest size not measured', probe), rungs }, venues };
  return { depth: { status: 'MEASURED', dollarToken: probe.dollarToken, dollarDecimals: dd, rungs, upTo1pct, upTo5pct: reach(rungs, IMPACT_5PCT_BPS) }, venues };
}

/** Venue balances valued at measured prices: the candidate at its smallest measured rung, the
 *  dollar token at 1, WETH at usdValue of one WETH; any other token is not valued. */
async function measureLiquidity(reader: FindReader, chainId: number, token: Address, depth: Depth, venues: ReturnType<typeof routeVenues>): Promise<Liquidity> {
  const ref = depth.rungs.find((r) => r.usdOut !== null);
  const weth = (CHAINS as Record<number, { weth: Address; usdc: Address }>)[chainId]?.weth;
  let wethPrice: Promise<[bigint, bigint] | null> | undefined;
  const price = (t: Address): Promise<[bigint, bigint] | null> => {
    if (ref && lc(t) === lc(token)) return Promise.resolve([ref.usdOut!, ref.amountIn]);
    if (depth.dollarToken && lc(t) === lc(depth.dollarToken)) return Promise.resolve([1n, 1n]);
    if (weth && lc(t) === lc(weth)) return (wethPrice ??= reader.usdValue(weth, 10n ** 18n).then((u) => (u.usdValue ? [u.usdValue, 10n ** 18n] as [bigint, bigint] : null), () => null));
    return Promise.resolve(null);
  };
  const out: VenueLiquidity[] = [];
  for (const v of venues) {
    if (V4_KINDS.includes(v.kind)) { out.push({ pairAddress: v.pairAddress, kind: v.kind, status: 'NOT_MEASURED', reason: 'V4: balances sit in the shared PoolManager, not at the venue', balances: [], usd: null }); continue; }
    if (!BALANCE_KINDS.includes(v.kind)) { out.push({ pairAddress: v.pairAddress, kind: v.kind, status: 'NOT_MEASURED', reason: `venue kind ${v.kind}: where its balances sit is not known here`, balances: [], usd: null }); continue; }
    const balances: VenueBalance[] = [];
    for (const t of v.tokens) {
      const amount = await reader.balanceOf(t, v.pairAddress).catch(() => null);
      const p = await price(t);
      balances.push({ token: t, amount, usd: amount === null || p === null ? null : (amount * p[0]) / p[1] });
    }
    const missing = balances.find((b) => b.usd === null);
    out.push(missing
      ? { pairAddress: v.pairAddress, kind: v.kind, status: 'NOT_MEASURED', reason: missing.amount === null ? `balanceOf ${missing.token} not read` : `${missing.token} not valued (neither the candidate, the dollar token nor WETH)`, balances, usd: null }
      : { pairAddress: v.pairAddress, kind: v.kind, status: 'MEASURED', balances, usd: balances[0].usd! + balances[1].usd! });
  }
  const measured = out.filter((v) => v.usd !== null);
  return { venues: out, totalUsd: measured.length ? measured.reduce((s, v) => s + v.usd!, 0n) : null, complete: out.every((v) => v.status === 'MEASURED') };
}

function rpcReader(chainId: number, rpc: RpcSource, client?: BlazePhoenix): FindReader {
  const pc = createPublicClient({ transport: transportFrom(rpc) });
  const bp = client ?? new BlazePhoenix({ rpc: { [chainId]: rpc } });
  const abi = parseAbi(['function symbol() view returns (string)', 'function name() view returns (string)', 'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)']);
  const read = <T>(address: Address, functionName: 'symbol' | 'name' | 'decimals') => pc.readContract({ address, abi, functionName }).then((x) => x as T, () => null);
  return {
    hasCode: async (a) => { const c = await pc.getCode({ address: a }); return typeof c === 'string' && c !== '0x'; },
    erc20: async (a) => ({ symbol: await read<string>(a, 'symbol'), name: await read<string>(a, 'name'), decimals: await read<number>(a, 'decimals') }),
    balanceOf: (t, h) => pc.readContract({ address: t, abi, functionName: 'balanceOf', args: [h] }).then((x) => x as bigint, () => null),
    usdValue: (token, amountIn) => bp.usdValue({ chain: chainId, token, amountIn }),
  };
}

async function readCandidate(reader: FindReader, req: FindTokenRequest, chainId: number, address: Address, sources: SourceStatus['name'][], sizes: readonly number[]): Promise<Candidate> {
  const c: Candidate = {
    address, rank: 0, sources, hasCode: null, symbol: null, name: null, decimals: null,
    lookalike: { suspicious: false, symbol: null, name: null },
    depth: notMeasured('not read'), liquidity: { venues: [], totalUsd: null, complete: false },
  };
  try {
    c.hasCode = await reader.hasCode(address);
    if (!c.hasCode) { c.depth = notMeasured('no code at this address'); return c; }
    const t = await reader.erc20(address);
    c.symbol = t.symbol === null ? null : tokenText(t.symbol);
    c.name = t.name === null ? null : tokenText(t.name);
    const sym = t.symbol === null ? null : lookalike(t.symbol);
    const nam = t.name === null ? null : lookalike(t.name);
    c.lookalike = { suspicious: !!(sym?.suspicious || nam?.suspicious), symbol: sym, name: nam };
    if (t.decimals === null || !Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 255) { c.depth = notMeasured('decimals() not read'); return c; }
    c.decimals = t.decimals;
    const { depth, venues } = await measureDepth(reader, address, t.decimals, sizes);
    c.depth = depth;
    c.liquidity = await measureLiquidity(reader, chainId, address, depth, venues);
    if (req.xray) {
      const amountIn = depth.rungs.find((r) => r.usdOut !== null)?.amountIn;
      c.xray = amountIn === undefined
        ? { error: 'not run: no measured size to run it at' }
        : await runXray(req.xray.transport, { chainId, token: address, amountIn, maxTaxBps: req.xray.maxTaxBps ?? 500 }).catch((e) => ({ error: msg(e) }));
    }
  } catch (e) {
    c.reason = `read failed: ${msg(e)}`;
  }
  return c;
}

const depthKey = (c: Candidate) => c.depth.upTo1pct?.usdOut ?? -1n;

/** Find a token by name or ticker on one chain. Never selects one: see FindTokenResult.warnings. */
export async function findToken(req: FindTokenRequest): Promise<FindTokenResult> {
  const query = tokenText(req.query, 64);
  if (query.length === 0) throw new BlazeError('bad_request', 'query: give a name or ticker');
  const chainId = resolveChain(req.chainId);
  const sizes = validSizes(req.sizes ?? DEFAULT_SIZES_USD);
  const max = req.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  if (!Number.isSafeInteger(max) || max < 1) throw new BlazeError('bad_request', 'maxCandidates: a positive integer');
  if (!req.reader && req.rpc === undefined) throw new BlazeError('bad_request', 'rpc: give your RPC for this chain');
  const reader = req.reader ?? rpcReader(chainId, req.rpc!, req.client);
  const fetchFn = req.fetch ?? globalThis.fetch;

  const answers = await Promise.all([fromCoinGecko(fetchFn, query, chainId), fromDexscreener(fetchFn, query, chainId)]);
  const byAddr = new Map<string, { address: Address; sources: SourceStatus['name'][] }>();
  for (const a of answers) for (const p of a.proposals) {
    const k = lc(p.address);
    const e = byAddr.get(k) ?? { address: getAddress(k), sources: [] };
    if (!e.sources.includes(p.source)) e.sources.push(p.source);
    byAddr.set(k, e);
  }
  const all = [...byAddr.values()].sort((x, y) => y.sources.length - x.sources.length || (lc(x.address) < lc(y.address) ? -1 : 1));
  const picked = all.slice(0, max);
  const candidates = await Promise.all(picked.map((p) => readCandidate(reader, req, chainId, p.address, p.sources, sizes)));
  candidates.sort((x, y) => {
    const a = depthKey(x), b = depthKey(y);
    return a === b ? (lc(x.address) < lc(y.address) ? -1 : 1) : (b > a ? 1 : -1);
  });
  candidates.forEach((c, i) => { c.rank = i + 1; });
  if (candidates[0]?.depth.status === 'MEASURED') candidates[0].label = 'most liquid';

  const q = skeleton(query);
  const sameTicker = candidates.filter((c) => c.symbol !== null && skeleton(c.symbol) === q).length;
  const warnings: string[] = [WARNINGS.mostLiquid, WARNINGS.dyor(sameTicker), WARNINGS.notSafety, WARNINGS.liquidityVsDepth, WARNINGS.trust];
  if (candidates.some((c) => c.liquidity.venues.some((v) => V4_KINDS.includes(v.kind)))) warnings.push(WARNINGS.v4);
  return { query, chainId, candidates, sources: answers.map((a) => a.status), omitted: all.length - picked.length, warnings, basis: BASIS };
}
