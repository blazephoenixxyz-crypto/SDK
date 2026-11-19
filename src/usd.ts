// =============================================================================
//  USD value of a token amount, measured on the BlazePhoenix Quoter and nothing
//  else: no oracle, no price API. Every number is the netOut the Quoter answers
//  for a real amount (after the protocol fee, including price impact), read in
//  ONE Multicall3.aggregate3 eth_call so every via comes from the same block.
//
//  The dollar token (CHAINS[chain].usdc: USDC, or USDG on Robinhood Chain) is
//  taken as 1 USD. The value is the MINIMUM over the vias that measured
//  something; a via that measured nothing is "not measured", never 0.
// =============================================================================

import { formatUnits, parseAbi } from 'viem';
import { FEE_BPS } from './constants.js';
import { BlazeError } from './errors.js';
import type { Address, ChainRef, Route, TokenRef } from './types.js';

/** Multicall3, same address on every EVM chain it is deployed to. */
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const MULTICALL3_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getBlockNumber() view returns (uint256 blockNumber)',
]);

/** Vias per call, the direct one included. */
export const USD_MAX_VIAS = 8;
/** WETH → dollar leg is priced at 1 WETH and scaled. */
const ONE_WETH = 10n ** 18n;
const UINT128_MAX = (1n << 128n) - 1n;

export interface UsdValueRequest {
  chain?: ChainRef;
  /** Address or built-in symbol (ETH, WETH, USDC/USDG, BZPX). */
  token: TokenRef;
  /** Amount in base units (bigint, or an integer string). The value depends on it: impact is included. */
  amountIn: bigint | string;
  version?: string;
  /** Pin every read to this block (default: latest, then pinned to the block it answered). */
  blockNumber?: bigint;
}

export interface UsdLeg {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** The Quoter's netOut for this leg, when it measured one. */
  out?: bigint;
}

export interface UsdVia {
  /** token → … → dollar token. */
  path: Address[];
  status: 'measured' | 'not measured' | 'identity';
  /** Dollar-token base units, present when status is 'measured' or 'identity'. */
  usd?: bigint;
  /** Why nothing was measured (revert reason, empty route, netOut 0). */
  reason?: string;
  legs: UsdLeg[];
  /** For a two-leg via: the amount of the middle token the second leg was priced at
   *  (refX). That leg is scaled linearly from refX, so its impact is the impact at
   *  refX, not at the amount the first leg delivered. */
  scaledFrom?: bigint;
}

export interface UsdSpread { min: bigint; max: bigint; diff: bigint; bps: number }

export interface UsdValue {
  chainId: number;
  version: string;
  /** "USD (via USDC)", or "USD (via USDG)" on Robinhood Chain: the dollar token is taken as 1 USD. */
  label: string;
  dollarToken: Address;
  dollarDecimals: number;
  token: Address;
  amountIn: bigint;
  tokenDecimals: number | null;
  blockNumber: bigint;
  /** Minimum over the measured vias, in dollar-token base units; null when no via measured. */
  usdValue: bigint | null;
  /** usdValue in dollar units, or 'not measured' (never "0"). */
  usd: string;
  /** usdValue per whole token, 18 decimals; 'not measured' without a value or the token's decimals. */
  unitPrice: string;
  vias: UsdVia[];
  /** Over the measured vias, when there are at least two. No threshold, no verdict. */
  spread: UsdSpread | null;
  rpc: { requests: number };
  basis: string;
}

/** One leg as read from the Quoter: its netOut and hop count, or why the read failed. */
export interface UsdLegReading {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  netOut?: bigint;
  hops?: number;
  error?: string;
}
export interface UsdViaReading { path: Address[]; legs: UsdLegReading[] }

/** Everything usdFromVias needs, all of it read in the same block. */
export interface UsdReadings {
  chainId: number;
  version: string;
  dollarToken: Address;
  dollarDecimals: number;
  token: Address;
  amountIn: bigint;
  tokenDecimals: number | null;
  blockNumber: bigint;
  vias: UsdViaReading[];
  rpcRequests: number;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The vias to read for `amountIn` of `token`: direct, via WETH (unless the token is
 *  WETH), then each token the direct route touches, in route order, up to USD_MAX_VIAS. */
export function planUsdVias(token: Address, amountIn: bigint, dollar: Address, weth: Address, direct?: Route): UsdViaReading[] {
  const vias: UsdViaReading[] = [{ path: [token, dollar], legs: [{ tokenIn: token, tokenOut: dollar, amountIn }] }];
  const two = (x: Address, refX: bigint): UsdViaReading => ({
    path: [token, x, dollar],
    legs: [{ tokenIn: token, tokenOut: x, amountIn }, { tokenIn: x, tokenOut: dollar, amountIn: refX }],
  });
  if (!same(token, weth)) vias.push(two(weth, ONE_WETH));
  const seen = new Set([token, dollar, weth].map((a) => a.toLowerCase()));
  for (const hop of direct?.hops ?? []) {
    for (const x of [hop.tokenIn, hop.tokenOut]) {
      if (vias.length >= USD_MAX_VIAS) return vias;
      if (seen.has(x.toLowerCase())) continue;
      seen.add(x.toLowerCase());
      const refX = direct!.hops.find((h) => same(h.tokenIn, x))?.amountIn ?? 0n;
      if (refX > 0n) vias.push(two(x, refX));
    }
  }
  return vias;
}

function measure(v: UsdViaReading): UsdVia {
  const legs: UsdLeg[] = v.legs.map((l) => ({
    tokenIn: l.tokenIn, tokenOut: l.tokenOut, amountIn: l.amountIn, ...(l.netOut !== undefined ? { out: l.netOut } : {}),
  }));
  const scaled = v.legs.length === 2 ? { scaledFrom: v.legs[1]!.amountIn } : {};
  const no = (reason: string): UsdVia => ({ path: v.path, status: 'not measured', reason, legs, ...scaled });
  if (v.legs.length < 1 || v.legs.length > 2) return no('a via has one or two legs');
  for (const l of v.legs) {
    if (l.error !== undefined) return no(l.error);
    if (l.hops === 0) return no('the Quoter found no route (0 hops)');
    if (l.netOut === undefined || l.netOut === 0n) return no('netOut is 0: no measurement, not a price of 0');
  }
  const usd = v.legs.length === 1
    ? v.legs[0]!.netOut!
    : v.legs[1]!.amountIn === 0n ? 0n : (v.legs[0]!.netOut! * v.legs[1]!.netOut!) / v.legs[1]!.amountIn;
  if (usd === 0n) return no('below one base unit of the dollar token: no measurement, not a price of 0');
  return { path: v.path, status: 'measured', usd, legs, ...scaled };
}

/** The USD value from Quoter readings (pure: no RPC). The SDK's usdValue() and the hosted
 *  decoder share it. Value = MIN over the measured vias; none measured → null, never 0. */
export function usdFromVias(r: UsdReadings): UsdValue {
  if (r.amountIn <= 0n) throw new BlazeError('bad_request', 'amount must be > 0');
  if (r.amountIn > UINT128_MAX) throw new BlazeError('bad_request', 'amount exceeds uint128 (the Router refuses it)');
  const identity = same(r.token, r.dollarToken);
  const vias: UsdVia[] = identity
    ? [{ path: [r.dollarToken], status: 'identity', usd: r.amountIn, legs: [] }]
    : r.vias.map(measure);
  const got = vias.filter((v) => v.usd !== undefined).map((v) => v.usd!);
  const usdValue = got.length === 0 ? null : got.reduce((a, b) => (b < a ? b : a));
  const max = got.length === 0 ? null : got.reduce((a, b) => (b > a ? b : a));
  const spread = usdValue !== null && max !== null && got.length >= 2
    ? { min: usdValue, max, diff: max - usdValue, bps: Number(((max - usdValue) * 10_000n) / max) }
    : null;
  const unit = usdValue === null || r.tokenDecimals === null
    ? 'not measured'
    : formatUnits((usdValue * 10n ** BigInt(r.tokenDecimals + 18)) / (r.amountIn * 10n ** BigInt(r.dollarDecimals)), 18);
  const symbol = r.chainId === 4663 ? 'USDG' : 'USDC';
  return {
    chainId: r.chainId,
    version: r.version,
    label: `USD (via ${symbol})`,
    dollarToken: r.dollarToken,
    dollarDecimals: r.dollarDecimals,
    token: r.token,
    amountIn: r.amountIn,
    tokenDecimals: r.tokenDecimals,
    blockNumber: r.blockNumber,
    usdValue,
    usd: usdValue === null ? 'not measured' : formatUnits(usdValue, r.dollarDecimals),
    unitPrice: unit,
    vias,
    spread,
    rpc: { requests: r.rpcRequests },
    basis: `The netOut the Quoter answers for amountIn, after the ${FEE_BPS / 100}% fee and including price impact, `
      + `with ${symbol} taken as 1 USD; the minimum over the measured vias; X→${symbol} legs priced at refX and scaled linearly.`,
  };
}
