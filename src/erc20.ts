// =============================================================================
//  ERC-20 helpers — zero dependencies. Completes the integration loop:
//    quote → buildApproveTx (once per token) → buildSwapTx → send.
//  Plus human-amount conversion so callers never hand-count decimals.
// =============================================================================

import { CHAINS, resolveChain } from './constants.js';
import type { Address, ChainRef, Hex, QuoteTx } from './types.js';

/** Unlimited allowance (2^256 − 1). Prefer EXACT amounts — pass the amount you
 *  are about to swap; use MAX_UINT256 only when you consciously want one
 *  approval forever (bots with their own key management). */
export const MAX_UINT256 = (1n << 256n) - 1n;

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;

// approve(address,uint256)
const APPROVE_SELECTOR = '0x095ea7b3';

function pad32(hexNo0x: string): string {
  return hexNo0x.padStart(64, '0');
}

export interface ApproveOptions {
  /** ERC-20 token to approve (the swap's tokenIn). */
  token: Address;
  /** Chain id or name — picks the Router as the default spender. */
  chain: ChainRef;
  /** Allowance in base units. Be exact; MAX_UINT256 opts into unlimited. */
  amount: bigint;
  /** Override the spender (defaults to the BlazePhoenix Router). */
  spender?: Address;
}

/** Ready-to-send `approve` transaction for the Router (or a custom spender).
 *  Send it once per token before the first swap; then swap freely. */
export function buildApproveTx(opts: ApproveOptions): QuoteTx {
  const chainId = resolveChain(opts.chain);
  const spender = opts.spender ?? CHAINS[chainId].contracts.router;
  if (!HEX_ADDR.test(opts.token)) throw new Error(`invalid token address: ${opts.token}`);
  if (!HEX_ADDR.test(spender)) throw new Error(`invalid spender address: ${spender}`);
  if (opts.amount < 0n || opts.amount > MAX_UINT256) throw new Error('amount out of uint256 range');
  const data = (APPROVE_SELECTOR
    + pad32(spender.slice(2).toLowerCase())
    + pad32(opts.amount.toString(16))) as Hex;
  return { to: opts.token, data, value: '0' };
}

/** "1.5" + 18 decimals → 1500000000000000000n. Pure string math — no floats,
 *  no precision loss. Rejects more fractional digits than the token carries. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new Error(`invalid decimals: ${decimals}`);
  }
  const s = amount.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`invalid amount: "${amount}" (use e.g. "1.5")`);
  const [, whole, frac = ''] = m;
  if (frac.length > decimals) {
    throw new Error(`"${amount}" has ${frac.length} fractional digits — token only carries ${decimals}`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** 1500000000000000000n + 18 decimals → "1.5" (trailing zeros trimmed).
 *  `maxDp` optionally truncates the fractional part for display. */
export function fromBaseUnits(v: bigint | string, decimals: number, maxDp?: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new Error(`invalid decimals: ${decimals}`);
  }
  const n = typeof v === 'bigint' ? v : BigInt(v);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, '0');
  if (maxDp !== undefined) frac = frac.slice(0, Math.max(0, maxDp));
  frac = frac.replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
