// =============================================================================
//  Router calldata — encode, decode, and VERIFY.
//
//  On 2.x the Quoter hands back the exact bytes that execute its preview
//  (previewAndEncode). The Quoter's own header says what that is worth: "a
//  compromised Quoter fools the interface". So the SDK never forwards those
//  bytes blind — it decodes them with the Router ABI and checks every field
//  against what YOU asked for before anything reaches a wallet.
// =============================================================================

import { decodeFunctionData, encodeFunctionData } from 'viem';
import { ROUTER_ABI } from './abis.js';
import { routeIsConsistent } from './checks.js';
import { BlazeError } from './errors.js';
import type { Address, Hex, Route } from './types.js';

export function encodeSwapExactIn(route: Route, amountIn: bigint, userMinOut: bigint, recipient: Address, deadline: bigint): Hex {
  return encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'swapExactIn',
    args: [route as never, amountIn, userMinOut, recipient, deadline],
  });
}

export function encodeSwapExactInNative(route: Route, userMinOut: bigint, recipient: Address, deadline: bigint): Hex {
  return encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'swapExactInNative',
    args: [route as never, userMinOut, recipient, deadline],
  });
}

export function encodeSwapBestExactIn(
  tokenIn: Address, tokenOut: Address, amountIn: bigint, userMinOut: bigint, recipient: Address, deadline: bigint,
): Hex {
  return encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'swapBestExactIn',
    args: [tokenIn, tokenOut, amountIn, userMinOut, recipient, deadline],
  });
}

export interface DecodedSwapExactIn {
  route: Route;
  amountIn: bigint;
  userMinOut: bigint;
  recipient: Address;
  deadline: bigint;
}

/** Decode swapExactIn calldata (throws on any other selector). */
export function decodeSwapExactIn(data: Hex): DecodedSwapExactIn {
  const d = decodeFunctionData({ abi: ROUTER_ABI, data });
  if (d.functionName !== 'swapExactIn') {
    throw new BlazeError('calldata_mismatch', `expected swapExactIn calldata, got ${d.functionName}`);
  }
  const [route, amountIn, userMinOut, recipient, deadline] = d.args as unknown as [Route, bigint, bigint, Address, bigint];
  return { route, amountIn, userMinOut, recipient, deadline };
}

/** Deterministic structural fingerprint of a route (bigint-safe). */
export function routeFingerprint(r: Route): string {
  return JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? `${v}n` : typeof v === 'string' ? v.toLowerCase() : v));
}

export interface SwapExpectation {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  recipient: Address;
  deadline: bigint;
  /** The encoded minimum must be at least this (the SDK's slippage floor). */
  minOutAtLeast: bigint;
  /** When given, the encoded route must be exactly this one (the previewed route). */
  route?: Route;
}

/**
 * Verify Quoter-produced swapExactIn bytes against the caller's intent.
 * Returns the decoded call; throws `calldata_mismatch` listing every field
 * that disagrees. Pure — no I/O.
 */
export function verifySwapExactIn(data: Hex, want: SwapExpectation): DecodedSwapExactIn {
  const got = decodeSwapExactIn(data);
  const bad: string[] = [];
  if (got.amountIn !== want.amountIn) bad.push(`amountIn ${got.amountIn} ≠ ${want.amountIn}`);
  if (got.recipient.toLowerCase() !== want.recipient.toLowerCase()) bad.push(`recipient ${got.recipient} ≠ ${want.recipient}`);
  if (got.deadline !== want.deadline) bad.push(`deadline ${got.deadline} ≠ ${want.deadline}`);
  if (got.userMinOut < want.minOutAtLeast) bad.push(`userMinOut ${got.userMinOut} < required ${want.minOutAtLeast}`);
  if (got.userMinOut === 0n) bad.push('userMinOut is zero');
  if (!routeIsConsistent(got.route, want.tokenIn, want.tokenOut)) bad.push('route does not connect tokenIn → tokenOut');
  if (want.route && routeFingerprint(got.route) !== routeFingerprint(want.route)) bad.push('encoded route differs from the previewed route');
  if (bad.length) {
    throw new BlazeError('calldata_mismatch',
      `Quoter calldata refused — it does not execute what you asked for: ${bad.join('; ')}`,
      { details: { mismatches: bad } });
  }
  return got;
}

/** Re-encode verified swapExactIn bytes with a TIGHTER minimum. The route and
 *  every other field are carried over from the Quoter's own encoding. */
export function tightenMinOut(data: Hex, minOut: bigint): Hex {
  const d = decodeSwapExactIn(data);
  if (minOut <= d.userMinOut) return data;
  return encodeSwapExactIn(d.route, d.amountIn, minOut, d.recipient, d.deadline);
}

/** minOut from a net quote and a slippage tolerance, never below the floor. */
export function minOutFor(netOut: bigint, slippageBps: number, floor: bigint): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5_000) {
    throw new BlazeError('bad_request', 'slippageBps must be an integer between 0 and 5000');
  }
  const bySlip = netOut - (netOut * BigInt(slippageBps)) / 10_000n;
  return bySlip > floor ? bySlip : floor;
}
