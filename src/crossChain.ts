// =============================================================================
//  Cross-chain QUOTED price of one token: usdValue (src/usd.ts) on each chain, on
//  each chain's own RPC, in parallel. Every number is a price the BlazePhoenix
//  Quoter quotes for a real amount; there is no executed price and no volume here.
//
//  Fixed-point integers only: a price is USD per whole token scaled by 1e18
//  (USD_E18), rounded down. Formatting happens at presentation (formatQuotedUsd).
//  A chain that measured nothing is 'not_measured' with its reason, never 0.
//
//  The token on each chain is the one the caller names there: a built-in symbol the
//  SDK maps to its own constant address (ETH, WETH, USDC, USDG), or an address.
//  Tokens are never matched across chains by on-chain symbol or name.
//
//  aggregateQuotedPrices is the aggregation without RPC: the same inputs give the same
//  numbers in any port (API, MCP).
// =============================================================================

import { formatUnits, getAddress } from 'viem';
import { BlazePhoenix } from './client.js';
import { CHAINS, resolveChain } from './constants.js';
import { BlazeError } from './errors.js';
import { scrubUrls, type RpcSource } from './rpc.js';
import type { Address, ChainRef, TokenRef } from './types.js';
import type { UsdValue, UsdVia } from './usd.js';

/** Scale of every price: USD per whole token × 1e18. */
export const USD_E18 = 10n ** 18n;
const BPS = 10_000n;
const UINT128_MAX = (1n << 128n) - 1n;
const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const INT = /^[0-9]+$/;
const DECIMAL = /^[0-9]+(\.[0-9]+)?$/;
/** The symbols the SDK maps to its own constant address on each chain. Anything else is an address. */
const BUILTIN_SYMBOLS = ['ETH', 'WETH', 'USDC', 'USDG'];

// ── pure part (no RPC) ───────────────────────────────────────────────────────

/** USD per whole token × 1e18 from one usdValue reading, rounded down:
 *  usdValue · 10^tokenDecimals · 1e18 / (amountIn · 10^dollarDecimals).
 *  null when it rounds to 0 (below 1e-18 USD per whole token): no measurement, not a price of 0. */
export function quotedUnitPriceUsd(usdValue: bigint, amountIn: bigint, tokenDecimals: number, dollarDecimals: number): bigint | null {
  if (usdValue <= 0n) throw new BlazeError('bad_request', 'usdValue must be > 0 (a missing value is null, not 0)');
  if (amountIn <= 0n) throw new BlazeError('bad_request', 'amount must be > 0');
  checkDecimals(tokenDecimals, 'tokenDecimals');
  checkDecimals(dollarDecimals, 'dollarDecimals');
  const p = (usdValue * 10n ** BigInt(tokenDecimals) * USD_E18) / (amountIn * 10n ** BigInt(dollarDecimals));
  return p === 0n ? null : p;
}

/** The second order size on one chain, for the depth weight. */
export interface QuotedDepthPoint {
  /** The first order size (base units): the size priceUsd was quoted at. */
  amountIn: bigint;
  /** The second order size (base units), > amountIn. */
  depthAmountIn: bigint;
  tokenDecimals: number;
  /** USD per whole token × 1e18 quoted at depthAmountIn; null when not measured. */
  depthPriceUsd: bigint | null;
  /** Why depthPriceUsd is null. */
  reason?: string;
}

/** One chain's input to the aggregation. */
export interface QuotedPricePoint {
  chainId: number;
  /** USD per whole token × 1e18 quoted at the first order size; null when not measured. */
  priceUsd: bigint | null;
  /** Timestamp (seconds) of the block the price was quoted in; null when not measured. */
  blockTimestamp: bigint | null;
  /** Why priceUsd is null. */
  reason?: string;
  depth?: QuotedDepthPoint;
}

export interface QuotedPriceAggregateOptions {
  /** Exclude a chain whose block timestamp is older than the newest measured block's timestamp
   *  minus this many seconds. Unset: no chain is excluded for age. */
  maxSkewSeconds?: bigint | number;
}

export interface QuotedIncludedChain {
  chainId: number;
  priceUsd: bigint;
  blockTimestamp: bigint;
  /** The measured depth (USD × 1e18, rounded down; see aggregateQuotedPrices), or null. */
  depthUsd: bigint | null;
}
export interface QuotedExcludedChain { chainId: number; reason: string }

export interface QuotedPriceAggregate {
  /** 'not_measured' when no chain is included: every number below is then null. */
  status: 'measured' | 'not_measured';
  reason?: string;
  /** Median of the included chains' quoted prices (USD × 1e18); the main value. */
  medianPriceUsd: bigint | null;
  /** Mean of the included chains' quoted prices weighted by their measured depth; null (with
   *  depthWeightedReason) unless every included chain has a resolved depth. */
  depthWeightedPriceUsd: bigint | null;
  depthWeightedReason?: string;
  minPriceUsd: bigint | null;
  maxPriceUsd: bigint | null;
  /** (max − min) · 10000 / min, rounded down; null with fewer than two included chains. */
  spreadBps: bigint | null;
  /** Newest minus oldest block timestamp of the included chains; null with fewer than two. */
  skewSeconds: bigint | null;
  /** The newest block timestamp among the measured chains, the reference of maxSkewSeconds. */
  newestBlockTimestamp: bigint | null;
  included: QuotedIncludedChain[];
  excluded: QuotedExcludedChain[];
}

/**
 * Aggregate quoted prices across chains. Pure: no RPC, integers only, the same inputs give
 * the same output in every port.
 *
 * 1. A chain without priceUsd or blockTimestamp is excluded with its reason.
 * 2. With maxSkewSeconds, a chain whose blockTimestamp < newest − maxSkewSeconds is excluded,
 *    and the reason names its age. The newest chain is never excluded for age.
 * 3. Over the included chains: min, max, spreadBps = floor((max − min)·10000 / min) and
 *    skewSeconds = newest − oldest (both null with fewer than two chains), and the median:
 *    odd count → the middle price; even count → floor((a + b) / 2) of the two middle prices
 *    (integer division, rounding down).
 * 4. depthWeightedPriceUsd = Σ Dᵢ·pᵢ / Σ Dᵢ over the included chains, pᵢ the price at the first
 *    size and Dᵢ the depth the two sizes measure on that chain:
 *
 *      Dᵢ = (a₂ − a₁) · p₁ · p₂ / ((p₁ − p₂) · 10^decimals)          [USD × 1e18]
 *
 *    Derivation. A constant-product curve with reserves x (token) and y (USD) quotes
 *    out(a) = y·a / (x + a), so the price per unit is p(a) = y / (x + a) and
 *    1/p(a) = x/y + a/y: 1/p is affine in the order size with slope 1/y. Two quotes give
 *    1/p₂ − 1/p₁ = (a₂ − a₁)/y, so y = (a₂ − a₁)·p₁·p₂ / (p₁ − p₂): the USD depth the curve
 *    behaves as having between the two sizes. A fee on the input, y·(1−f)·a / (x + (1−f)·a),
 *    keeps the slope 1/y; inside one concentrated-liquidity range the virtual reserves follow
 *    the same curve. Across ranges, hops or venues D is the local depth the two quotes
 *    measure, not a reserve. Less impact between the sizes (p₁ − p₂ smaller) → larger D →
 *    more weight; no threshold, no constant. a is in base units, so 10^decimals turns it into
 *    whole tokens and different decimals on different chains compare.
 *
 *    The sum is computed exactly as fractions (Dᵢ = Nᵢ/Mᵢ, every term multiplied by Π Mⱼ)
 *    and rounded down once at the end, so it lies in [min, max] and does not depend on the
 *    order of the chains. If any included chain has no depth reading, or p₂ ≥ p₁ (no impact
 *    resolved at 1e-18 USD between the sizes: its D is not measured, and it is not taken as
 *    infinite), depthWeightedPriceUsd is null and depthWeightedReason names the chain; the
 *    median stands.
 *
 * Throws bad_request on input no producer can emit: a duplicate chain, a price ≤ 0 (a missing
 * price is null), a negative timestamp, depthAmountIn ≤ amountIn, a negative maxSkewSeconds.
 */
export function aggregateQuotedPrices(points: readonly QuotedPricePoint[], opts: QuotedPriceAggregateOptions = {}): QuotedPriceAggregate {
  const maxSkew = opts.maxSkewSeconds === undefined ? undefined : toBig(opts.maxSkewSeconds, 'maxSkewSeconds');
  if (maxSkew !== undefined && maxSkew < 0n) throw new BlazeError('bad_request', 'maxSkewSeconds must be ≥ 0');
  const seen = new Set<number>();
  for (const p of points) {
    if (seen.has(p.chainId)) throw new BlazeError('bad_request', `chain ${p.chainId} appears twice: one price per chain`);
    seen.add(p.chainId);
    if (p.priceUsd !== null && p.priceUsd <= 0n) throw new BlazeError('bad_request', `chain ${p.chainId}: priceUsd must be > 0 (a missing price is null, not 0)`);
    if (p.blockTimestamp !== null && p.blockTimestamp < 0n) throw new BlazeError('bad_request', `chain ${p.chainId}: blockTimestamp must be ≥ 0`);
    if (p.depth) {
      const d = p.depth;
      if (d.amountIn <= 0n || d.depthAmountIn <= d.amountIn) throw new BlazeError('bad_request', `chain ${p.chainId}: depthAmountIn must be > amountIn > 0`);
      if (d.depthPriceUsd !== null && d.depthPriceUsd <= 0n) throw new BlazeError('bad_request', `chain ${p.chainId}: depthPriceUsd must be > 0 (a missing price is null, not 0)`);
      checkDecimals(d.tokenDecimals, 'tokenDecimals');
    }
  }

  const excluded: QuotedExcludedChain[] = [];
  const measured: (QuotedPricePoint & { priceUsd: bigint; blockTimestamp: bigint })[] = [];
  for (const p of points) {
    if (p.priceUsd === null) excluded.push({ chainId: p.chainId, reason: p.reason ?? 'not measured' });
    else if (p.blockTimestamp === null) excluded.push({ chainId: p.chainId, reason: p.reason ?? 'no block timestamp: its age cannot be measured' });
    else measured.push(p as QuotedPricePoint & { priceUsd: bigint; blockTimestamp: bigint });
  }
  const newest = measured.length === 0 ? null : measured.reduce((a, p) => (p.blockTimestamp > a ? p.blockTimestamp : a), measured[0]!.blockTimestamp);
  const kept = measured.filter((p) => {
    if (maxSkew === undefined || newest === null || p.blockTimestamp >= newest - maxSkew) return true;
    excluded.push({ chainId: p.chainId, reason: `block timestamp ${p.blockTimestamp} is ${newest - p.blockTimestamp} s older than the newest measured block (${newest}), more than maxSkewSeconds ${maxSkew}` });
    return false;
  });
  const order = new Map(points.map((p, i) => [p.chainId, i]));
  excluded.sort((a, b) => order.get(a.chainId)! - order.get(b.chainId)!);

  const none: QuotedPriceAggregate = {
    status: 'not_measured', reason: points.length === 0 ? 'no chain given' : 'no chain measured a quoted price',
    medianPriceUsd: null, depthWeightedPriceUsd: null, depthWeightedReason: 'no chain measured',
    minPriceUsd: null, maxPriceUsd: null, spreadBps: null, skewSeconds: null, newestBlockTimestamp: newest,
    included: [], excluded,
  };
  if (kept.length === 0) return none;

  const prices = kept.map((p) => p.priceUsd).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = prices.length;
  const median = n % 2 === 1 ? prices[(n - 1) / 2]! : (prices[n / 2 - 1]! + prices[n / 2]!) / 2n;
  const min = prices[0]!;
  const max = prices[n - 1]!;
  const ts = kept.map((p) => p.blockTimestamp);
  const tsMin = ts.reduce((a, b) => (b < a ? b : a));
  const tsMax = ts.reduce((a, b) => (b > a ? b : a));

  // depth: Dᵢ = Nᵢ / Mᵢ, Nᵢ = (a₂ − a₁)·p₁·p₂, Mᵢ = (p₁ − p₂)·10^decimals
  const frac: { N: bigint; M: bigint }[] = [];
  let depthWhy: string | undefined;
  for (const p of kept) {
    const d = p.depth;
    if (!d) { depthWhy ??= `chain ${p.chainId}: no second order size`; continue; }
    if (d.depthPriceUsd === null) { depthWhy ??= `chain ${p.chainId}: the price at depthAmountIn was not measured${d.reason ? ` (${d.reason})` : ''}`; continue; }
    if (d.depthPriceUsd >= p.priceUsd) {
      depthWhy ??= `chain ${p.chainId}: the price at depthAmountIn is not below the price at amountIn, so no impact is resolved between the two sizes and the depth is not measured (a larger depthAmountIn can resolve it)`;
      continue;
    }
    frac.push({ N: (d.depthAmountIn - d.amountIn) * p.priceUsd * d.depthPriceUsd, M: (p.priceUsd - d.depthPriceUsd) * 10n ** BigInt(d.tokenDecimals) });
  }
  let weighted: bigint | null = null;
  if (depthWhy === undefined) {
    // wᵢ·Π Mⱼ = Nᵢ · Π_{j≠i} Mⱼ: exact integers, one rounding at the end
    const w = frac.map((f, i) => frac.reduce((acc, g, j) => (j === i ? acc : acc * g.M), f.N));
    const den = w.reduce((a, b) => a + b, 0n);
    const num = w.reduce((a, wi, i) => a + wi * kept[i]!.priceUsd, 0n);
    weighted = num / den;
  }
  return {
    status: 'measured',
    medianPriceUsd: median,
    depthWeightedPriceUsd: weighted,
    ...(depthWhy !== undefined ? { depthWeightedReason: depthWhy } : {}),
    minPriceUsd: min,
    maxPriceUsd: max,
    spreadBps: n >= 2 ? ((max - min) * BPS) / min : null,
    skewSeconds: n >= 2 ? tsMax - tsMin : null,
    newestBlockTimestamp: newest,
    included: kept.map((p, i) => ({
      chainId: p.chainId, priceUsd: p.priceUsd, blockTimestamp: p.blockTimestamp,
      depthUsd: depthWhy === undefined ? frac[i]!.N / frac[i]!.M : null,
    })),
    excluded,
  };
}

/** A USD × 1e18 integer as a decimal string for display; 'not measured' for null (never "0"). */
export function formatQuotedUsd(x: bigint | null): string {
  return x === null ? 'not measured' : formatUnits(x, 18);
}

// ── RPC part ─────────────────────────────────────────────────────────────────

export interface CrossChainEntry {
  chain: ChainRef;
  /** ETH, WETH, USDC or USDG (the SDK's own constant address on that chain), or the token's
   *  address ON THIS CHAIN. Any other symbol is refused: tokens are never matched by name.
   *  A token that does not exist on a chain: leave that chain out. */
  token: TokenRef;
  /** First order size in base units of the token on this chain (bigint or integer string).
   *  Give exactly one of amountIn and amount. */
  amountIn?: bigint | string;
  /** First order size in WHOLE tokens, a decimal string ("1", "0.5"), converted on each chain
   *  with the decimals() read on that chain, so every chain quotes the same economic size.
   *  Give exactly one of amountIn and amount. */
  amount?: string;
  /** Your client for this chain; or `rpc`, your node for this chain; or the request's `client`. */
  client?: BlazePhoenix;
  rpc?: RpcSource;
  version?: string;
}
export interface CrossChainPriceRequest {
  chains: readonly CrossChainEntry[];
  /** The client for every entry without its own `client` or `rpc`. */
  client?: BlazePhoenix;
}
export interface CrossChainAverageEntry extends CrossChainEntry {
  /** Second order size, > the first, quoted in the same block to measure depth: base units
   *  (depthAmountIn) or whole tokens (depthAmount). Give exactly one. */
  depthAmountIn?: bigint | string;
  depthAmount?: string;
}
export interface CrossChainAverageRequest {
  chains: readonly CrossChainAverageEntry[];
  client?: BlazePhoenix;
  /** See QuotedPriceAggregateOptions.maxSkewSeconds. */
  maxSkewSeconds?: bigint | number;
}

/** One venue of a route hop: its address, its kind, its share of the hop's input and its expected output. */
export interface QuotedDerivationPool { pool: Address; kind: number; amountIn: bigint; out: bigint }
/** One hop of the Quoter's route for a leg, tokens as labels. */
export interface QuotedDerivationHop { tokenIn: string; tokenOut: string; amountIn: bigint; out: bigint; legs: QuotedDerivationPool[] }
/** One leg of the via that gave the price, as usdValue read it, with the Quoter's route for it. */
export interface QuotedDerivationLeg {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  netOut: bigint | null;
  /** Route.expectedImpactBps the Quoter answered for this leg (null when it answered no route). */
  impactBps: bigint | null;
  /** The route's hops, in order; each hop lists its venues (address, kind, amountIn, out). */
  hops: QuotedDerivationHop[];
  /** The tokens between the route's hops (labels), in order; empty for a one-hop route. */
  bridges: string[];
}
/** How usdValue derived the price on one chain (exposed from usdValue, not recomputed). */
export interface QuotedDerivation {
  /** The via whose value is the minimum, the one the price comes from, as labels:
   *  'TOKEN → WETH → USDC' (TOKEN is the priced token; SDK constants by symbol, others by
   *  address). null when no via measured. */
  path: string | null;
  /** Its legs, amountIn → netOut in base units. */
  legs: QuotedDerivationLeg[];
  /** Present when its second leg was scaled from this amount of the middle token (refX). */
  scaledFrom?: bigint;
  /** Every via usdValue tried, with its status, value and reason. */
  vias: { path: string; status: UsdVia['status']; usd: bigint | null; reason?: string; scaledFrom?: bigint }[];
}

/** One chain's quoted price at one order size. */
export interface QuotedChainPrice {
  chainId: number;
  status: 'measured' | 'not_measured';
  /** Why it is not measured. */
  reason?: string;
  /** The token address the price is for (null when the request failed before resolving it). */
  token: Address | null;
  /** The order size in base units: amountIn as given, or amount converted with this chain's
   *  decimals (null when that conversion was not measured). */
  amountIn: bigint | null;
  /** The whole-token amount as given, when the entry used `amount`. */
  amount?: string;
  /** USD per whole token × 1e18, rounded down (null when not measured). */
  priceUsd: bigint | null;
  /** usdValue of amountIn, dollar-token base units. */
  usdValue: bigint | null;
  dollarDecimals: number | null;
  tokenDecimals: number | null;
  blockNumber: bigint | null;
  blockTimestamp: bigint | null;
  vias: UsdVia[];
  /** The via the price comes from, its legs, and every via with its status (null when the
   *  chain's read failed before usdValue answered). */
  derivation: QuotedDerivation | null;
  /** The Quoter's Route.expectedImpactBps for the first leg of the derivation's via (the leg
   *  quoted at amountIn), from the same previewPlan answer as usdValue: no extra RPC. null with
   *  impactNote when there is none (not measured, or the token is the dollar token). */
  impactBps: bigint | null;
  /** 'measured' when every venue of that route has a kind the Quoter reads reserves or
   *  concentrated liquidity for; 'modeled' when any venue has another kind (V4, V4-native,
   *  external wrapper), for which the Quoter uses a constant default impact. null with impactBps. */
  impactBasis: 'measured' | 'modeled' | null;
  /** Where impactBps comes from: the Quoter's route. null with impactBps. */
  impactSource: 'quoter' | null;
  /** Present when impactBps is modeled (which pools) or null (why). */
  impactNote?: string;
}

export interface CrossChainPrice {
  basis: string;
  /** 'not_measured' when no chain measured: min, max, spreadBps and skewSeconds are then null. */
  status: 'measured' | 'not_measured';
  reason?: string;
  minPriceUsd: bigint | null;
  maxPriceUsd: bigint | null;
  spreadBps: bigint | null;
  skewSeconds: bigint | null;
  chains: QuotedChainPrice[];
}

export interface CrossChainAverage extends QuotedPriceAggregate {
  basis: string;
  /** Per chain: the price at amountIn and, when that measured, at the second size in the same block. */
  chains: (QuotedChainPrice & { depth: QuotedChainPrice | null })[];
}

/** The Quoter's attribute table per venue kind, 4 bits per kind (kind k in bits [4k+3 : 4k]):
 *  bit 0 = reserves, bit 1 = concentrated liquidity at the venue. Mirrors THETA_ATTR in
 *  Blaze-Phoenix-Dex src/BlazePhoenixCore.sol (main 6963c3f); a kind above 8 has no bits. */
const QUOTER_KIND_ATTR = 0x040A9400A9n;

/** Does the Quoter estimate this kind's impact from an on-chain reading (reserves, or the
 *  venue's sqrtPrice and liquidity)? false: it uses a constant default (Solver _legImpactBps). */
export function impactKindMeasured(kind: number): boolean {
  if (!Number.isInteger(kind) || kind < 0) return false;
  return ((QUOTER_KIND_ATTR >> BigInt(4 * kind)) & 3n) !== 0n;
}

const BASIS = 'Quoted prices: the netOut the BlazePhoenix Quoter quotes on each chain for amountIn (usdValue: '
  + 'after the 0.28% fee, including price impact at that size, the dollar token (USDC; USDG on Robinhood Chain) '
  + 'taken as 1 USD, the minimum over the direct route, via WETH and via the route\'s tokens), per whole token, '
  + "read on the caller's RPC. Quoted, not executed; no volume is read.";

/**
 * The quoted USD price of the same token on several chains: usdValue on each chain's RPC, in
 * parallel. Per chain: priceUsd (USD per whole token × 1e18), the value, block number and
 * timestamp, the derivation (the via of the minimum and every via); a chain that measured nothing is 'not_measured' with
 * its reason, never 0. Over the measured chains: min, max, spreadBps, skewSeconds
 * (aggregateQuotedPrices). Throws bad_request / bad_chain for a malformed request (unknown
 * symbol, duplicate chain, no client, both or neither of amountIn and amount); an RPC failure
 * on one chain makes that chain 'not_measured'.
 */
export async function crossChainPrice(req: CrossChainPriceRequest): Promise<CrossChainPrice> {
  const plan = planEntries(req.chains, req.client, false);
  const got = await settle(plan.map(async (e) => (await measureEntry(e)).first));
  const agg = aggregateQuotedPrices(got.map(pointOf));
  return {
    basis: BASIS, status: agg.status, ...(agg.reason ? { reason: agg.reason } : {}),
    minPriceUsd: agg.minPriceUsd, maxPriceUsd: agg.maxPriceUsd, spreadBps: agg.spreadBps, skewSeconds: agg.skewSeconds,
    chains: got,
  };
}

/**
 * crossChainPrice plus a quoted cross-chain average: medianPriceUsd (the main value),
 * depthWeightedPriceUsd (depth measured by quoting the second size in the same block as the
 * first on each chain), min, max, spreadBps, skewSeconds, and the included and excluded chains
 * with the reason. maxSkewSeconds excludes chains whose block is older than the newest by more
 * than that. No measured chain → 'not_measured', no number.
 */
export async function crossChainAverage(req: CrossChainAverageRequest): Promise<CrossChainAverage> {
  if (req.maxSkewSeconds !== undefined) {
    const m = toBig(req.maxSkewSeconds, 'maxSkewSeconds');
    if (m < 0n) throw new BlazeError('bad_request', 'maxSkewSeconds must be ≥ 0');
  }
  const plan = planEntries(req.chains, req.client, true);
  const got = await settle(plan.map(async (e) => {
    const { first, depthAmountIn } = await measureEntry(e);
    if (first.status !== 'measured' || depthAmountIn === null) return { ...first, depth: null };
    // the second size in the block of the first: the two prices differ by size only
    const depth = await measureChain(e, depthAmountIn, first.blockNumber!);
    if (depth.status === 'measured' && depth.blockNumber !== first.blockNumber) {
      return { ...first, depth: { ...depth, status: 'not_measured' as const, priceUsd: null, ...noImpact('the price is not measured'), reason: `quoted in block ${depth.blockNumber}, not in block ${first.blockNumber}` } };
    }
    return { ...first, depth };
  }));
  const agg = aggregateQuotedPrices(got.map((c) => ({
    ...pointOf(c),
    ...(c.status === 'measured' && c.depth ? {
      depth: {
        amountIn: c.amountIn!, depthAmountIn: c.depth.amountIn!, tokenDecimals: c.tokenDecimals!,
        depthPriceUsd: c.depth.priceUsd, ...(c.depth.reason ? { reason: c.depth.reason } : {}),
      },
    } : {}),
  })), req.maxSkewSeconds !== undefined ? { maxSkewSeconds: req.maxSkewSeconds } : {});
  return { basis: BASIS, ...agg, chains: got };
}

// ── internals ────────────────────────────────────────────────────────────────

/** An order size: base units, or a whole-token decimal string converted on the chain. */
type Size = { base: bigint } | { whole: string };
interface PlannedEntry { chainId: number; token: string; size: Size; depth?: Size; client: BlazePhoenix; version?: string }

function sizeOf(base: bigint | string | undefined, whole: string | undefined, what: string, wholeWhat: string): Size {
  if ((base === undefined) === (whole === undefined)) throw new BlazeError('bad_request', `${what}: give exactly one of ${what.split(': ').pop()} (base units) and ${wholeWhat} (whole tokens)`);
  if (whole === undefined) return { base: amountOf(base, what) };
  const w = typeof whole === 'string' ? whole.trim() : '';
  if (!DECIMAL.test(w) || !/[1-9]/.test(w)) throw new BlazeError('bad_request', `${what.split(': ')[0]}: ${wholeWhat} must be a decimal string of whole tokens > 0, like "1" or "0.5"`);
  return { whole: w };
}

/** Whole tokens → base units with `decimals`; null when the string has more fraction digits than the token. */
export function wholeToBase(whole: string, decimals: number): bigint | null {
  const [i, f = ''] = whole.split('.');
  const frac = f.replace(/0+$/, '');
  if (frac.length > decimals) return null;
  return BigInt(i!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

function planEntries(entries: readonly CrossChainAverageEntry[], fallback: BlazePhoenix | undefined, depth: boolean): PlannedEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) throw new BlazeError('bad_request', 'chains: give at least one { chain, token, amountIn | amount }');
  const seen = new Set<number>();
  return entries.map((e) => {
    const chainId = resolveChain(e.chain);
    if (seen.has(chainId)) throw new BlazeError('bad_request', `chain ${chainId} appears twice: one entry per chain`);
    seen.add(chainId);
    const t = String(e.token ?? '').trim();
    if (!HEX_ADDR.test(t) && !BUILTIN_SYMBOLS.includes(t.toUpperCase())) {
      throw new BlazeError('bad_request', `chain ${chainId}: token "${e.token}" is not ${BUILTIN_SYMBOLS.join('/')} or a 0x address — pass the token's address on this chain; tokens are never matched by symbol or name`);
    }
    const dollar = chainId === 4663 ? 'USDG' : 'USDC';
    if ((t.toUpperCase() === 'USDC' || t.toUpperCase() === 'USDG') && t.toUpperCase() !== dollar) {
      throw new BlazeError('bad_request', `chain ${chainId}: its dollar token is ${dollar}; ${t.toUpperCase()} names another token there — pass its address`);
    }
    const size = sizeOf(e.amountIn, e.amount, `chain ${chainId}: amountIn`, 'amount');
    const dsize = depth ? sizeOf(e.depthAmountIn, e.depthAmount, `chain ${chainId}: depthAmountIn`, 'depthAmount') : undefined;
    if (dsize && 'base' in dsize && 'base' in size && dsize.base <= size.base) throw new BlazeError('bad_request', `chain ${chainId}: depthAmountIn must be > amountIn`);
    if (dsize && 'whole' in dsize && 'whole' in size && wholeToBase(dsize.whole, 255)! <= wholeToBase(size.whole, 255)!) throw new BlazeError('bad_request', `chain ${chainId}: depthAmount must be > amount`);
    if (e.client && e.rpc !== undefined) throw new BlazeError('bad_request', `chain ${chainId}: give client or rpc, not both`);
    const client = e.client ?? (e.rpc !== undefined ? new BlazePhoenix({ rpc: { [String(chainId)]: e.rpc } }) : fallback);
    if (!client) throw new BlazeError('bad_request', `chain ${chainId}: no client — give the entry a client or rpc, or the request a client`);
    return { chainId, token: HEX_ADDR.test(t) ? getAddress(t) : t.toUpperCase(), size, ...(dsize ? { depth: dsize } : {}), client, ...(e.version ? { version: e.version } : {}) };
  });
}

/** The first size (converted when whole), its price with impact and derivation, and the second size in base units. */
async function measureEntry(e: PlannedEntry): Promise<{ first: QuotedChainPrice; depthAmountIn: bigint | null }> {
  const wholeGiven = 'whole' in e.size ? e.size.whole : undefined;
  let decimals: number | undefined;
  if ('whole' in e.size || (e.depth && 'whole' in e.depth)) {
    try {
      decimals = (await e.client.tokenInfo(e.chainId, e.token)).decimals;
    } catch (err) {
      const why = `${err instanceof BlazeError ? `${err.code}: ` : ''}${(err as Error)?.message ?? String(err)}`;
      return { first: failed(e, null, `decimals() not measured on your RPC, so a whole-token amount cannot be converted on this chain (${why})`, wholeGiven), depthAmountIn: null };
    }
  }
  const toBase = (s: Size, name: string): bigint | string => {
    if ('base' in s) return s.base;
    const b = wholeToBase(s.whole, decimals!);
    return b === null ? `${name} "${s.whole}" has more fraction digits than this token's ${decimals} decimals on this chain` : b;
  };
  const a = toBase(e.size, 'amount');
  if (typeof a === 'string') return { first: failed(e, null, a, wholeGiven), depthAmountIn: null };
  if (a > UINT128_MAX) throw new BlazeError('bad_request', `chain ${e.chainId}: amount exceeds uint128 in base units`);
  let d: bigint | null = null;
  if (e.depth) {
    const x = toBase(e.depth, 'depthAmount');
    if (typeof x === 'string') return { first: failed(e, a, x, wholeGiven), depthAmountIn: null };
    if (x <= a) throw new BlazeError('bad_request', `chain ${e.chainId}: the second size (${x}) must be > the first (${a}) in base units`);
    if (x > UINT128_MAX) throw new BlazeError('bad_request', `chain ${e.chainId}: depthAmount exceeds uint128 in base units`);
    d = x;
  }
  let first = await measureChain(e, a);
  if (wholeGiven !== undefined) first = { ...first, amount: wholeGiven };
  if (first.status === 'measured' && decimals !== undefined && first.tokenDecimals !== decimals) {
    first = { ...first, status: 'not_measured', priceUsd: null, ...noImpact('the amount is not measured'), reason: `decimals() read ${decimals} for the conversion and ${first.tokenDecimals} in block ${first.blockNumber}: the amount is not measured` };
  }
  return { first, depthAmountIn: d };
}

async function measureChain(e: PlannedEntry, amountIn: bigint, blockNumber?: bigint): Promise<QuotedChainPrice> {
  let v: UsdValue;
  try {
    v = await e.client.usdValue({ chain: e.chainId, token: e.token, amountIn, ...(e.version ? { version: e.version } : {}), ...(blockNumber !== undefined ? { blockNumber } : {}) });
  } catch (err) {
    if (isCallerError(err)) throw err;
    return failed(e, amountIn, `${err instanceof BlazeError ? `${err.code}: ` : ''}${(err as Error)?.message ?? String(err)}`);
  }
  const base: Omit<QuotedChainPrice, keyof Impact> = {
    chainId: e.chainId, status: 'not_measured', token: v.token, amountIn, priceUsd: null, usdValue: v.usdValue,
    dollarDecimals: v.dollarDecimals, tokenDecimals: v.tokenDecimals, blockNumber: v.blockNumber, blockTimestamp: v.blockTimestamp, vias: v.vias,
    derivation: derivationOf(e, v),
  };
  const no = (reason: string): QuotedChainPrice => ({ ...base, reason, ...noImpact('the price is not measured') });
  if (v.blockNumber === null) return no('no block held through the reads (a reorg each time, or a node without EIP-1898 blockHash)');
  if (v.usdValue === null || v.dollarDecimals === null) {
    const why = v.vias.map((x) => x.reason).filter(Boolean).slice(0, 3).join('; ');
    return no(`no via measured${why ? `: ${why}` : ''}`);
  }
  if (v.tokenDecimals === null) return no("the token's decimals() failed on your RPC: no price per whole token");
  if (v.blockTimestamp === null) return no('your RPC returned no block timestamp: the age of the price cannot be measured');
  const p = quotedUnitPriceUsd(v.usdValue, amountIn, v.tokenDecimals, v.dollarDecimals);
  if (p === null) return no('below 1e-18 USD per whole token: not measured, not a price of 0');
  return { ...base, status: 'measured', priceUsd: p, ...impactOf(e, v) };
}

type Impact = Pick<QuotedChainPrice, 'impactBps' | 'impactBasis' | 'impactSource' | 'impactNote'>;
const noImpact = (why: string): Impact => ({ impactBps: null, impactBasis: null, impactSource: null, impactNote: why });

/** Route.expectedImpactBps of the first leg of the via the price comes from, labelled measured or modeled. */
function impactOf(e: PlannedEntry, v: UsdValue): Impact {
  const best = v.vias.find((x) => x.status !== 'not measured' && x.usd === v.usdValue);
  if (best?.status === 'identity') return noImpact('the token is the dollar token: nothing is quoted');
  const leg = best?.legs[0];
  if (leg?.impactBps === undefined || leg.route === undefined) return noImpact('the Quoter answer carried no route for this leg');
  const modeled = leg.route.flatMap((h) => h.legs).filter((g) => !impactKindMeasured(g.kind));
  if (modeled.length === 0) return { impactBps: leg.impactBps, impactBasis: 'measured', impactSource: 'quoter' };
  const pools = modeled.map((g) => `${getAddress(g.pool)} (kind ${g.kind})`).join(', ');
  return {
    impactBps: leg.impactBps, impactBasis: 'modeled', impactSource: 'quoter',
    impactNote: `modeled, not measured: the Quoter has no reserves or concentrated-liquidity reading for ${pools} on chain ${e.chainId} and uses a constant default impact for it`,
  };
}

/** Labels for the derivation: the priced token is TOKEN, the SDK's constants by symbol, others by address. */
function derivationOf(e: PlannedEntry, v: UsdValue): QuotedDerivation {
  const c = CHAINS[e.chainId as keyof typeof CHAINS];
  const label = (a: Address) => {
    const x = a.toLowerCase();
    if (x === v.token.toLowerCase()) return BUILTIN_SYMBOLS.includes(e.token) ? e.token : 'TOKEN';
    if (x === v.dollarToken.toLowerCase()) return e.chainId === 4663 ? 'USDG' : 'USDC';
    if (c && x === c.weth.toLowerCase()) return 'WETH';
    return getAddress(a);
  };
  const show = (via: UsdVia) => via.path.map(label).join(' → ');
  const best = v.usdValue === null ? undefined : v.vias.find((x) => x.status !== 'not measured' && x.usd === v.usdValue);
  return {
    path: best ? show(best) : null,
    legs: best ? best.legs.map((l) => {
      const hops = (l.route ?? []).map((h) => ({
        tokenIn: label(h.tokenIn), tokenOut: label(h.tokenOut), amountIn: h.amountIn, out: h.out,
        legs: h.legs.map((g) => ({ pool: getAddress(g.pool), kind: g.kind, amountIn: g.amountIn, out: g.out })),
      }));
      return {
        tokenIn: label(l.tokenIn), tokenOut: label(l.tokenOut), amountIn: l.amountIn, netOut: l.out ?? null,
        impactBps: l.impactBps ?? null, hops, bridges: hops.slice(0, -1).map((h) => h.tokenOut),
      };
    }) : [],
    ...(best?.scaledFrom !== undefined ? { scaledFrom: best.scaledFrom } : {}),
    vias: v.vias.map((x) => ({ path: show(x), status: x.status, usd: x.usd ?? null, ...(x.reason ? { reason: x.reason } : {}), ...(x.scaledFrom !== undefined ? { scaledFrom: x.scaledFrom } : {}) })),
  };
}

function failed(e: PlannedEntry, amountIn: bigint | null, why: string, amount?: string): QuotedChainPrice {
  return {
    chainId: e.chainId, status: 'not_measured', reason: scrubUrls(why), token: null, amountIn, ...(amount !== undefined ? { amount } : {}),
    priceUsd: null, usdValue: null, dollarDecimals: null, tokenDecimals: null, blockNumber: null, blockTimestamp: null, vias: [],
    derivation: null, ...noImpact('the price is not measured'),
  };
}

/** allSettled over the chains; a malformed request (bad_request, bad_chain) is thrown, not reported as a chain. */
async function settle<T>(work: Promise<T>[]): Promise<T[]> {
  const r = await Promise.allSettled(work);
  for (const x of r) if (x.status === 'rejected') throw x.reason;
  return r.map((x) => (x as PromiseFulfilledResult<T>).value);
}

function pointOf(c: QuotedChainPrice): QuotedPricePoint {
  return c.status === 'measured'
    ? { chainId: c.chainId, priceUsd: c.priceUsd, blockTimestamp: c.blockTimestamp }
    : { chainId: c.chainId, priceUsd: null, blockTimestamp: null, reason: c.reason ?? 'not measured' };
}

const isCallerError = (e: unknown) => e instanceof BlazeError && (e.code === 'bad_request' || e.code === 'bad_chain');

function amountOf(v: bigint | string | undefined, what: string): bigint {
  let a: bigint;
  if (typeof v === 'bigint') a = v;
  else if (typeof v === 'string' && INT.test(v.trim())) a = BigInt(v.trim());
  else throw new BlazeError('bad_request', `${what} must be an integer in base units`);
  if (a <= 0n) throw new BlazeError('bad_request', `${what} must be > 0`);
  if (a > UINT128_MAX) throw new BlazeError('bad_request', `${what} exceeds uint128`);
  return a;
}

function toBig(v: bigint | number, what: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  throw new BlazeError('bad_request', `${what} must be an integer`);
}

function checkDecimals(d: number, what: string) {
  if (!Number.isInteger(d) || d < 0 || d > 255) throw new BlazeError('bad_request', `${what} must be an integer in 0..255`);
}
