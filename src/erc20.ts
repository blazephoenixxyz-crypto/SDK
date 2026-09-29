// =============================================================================
//  Token helpers — approve / wrap / unwrap calldata, Permit2 typed data, and
//  human-amount conversion. Pure: no I/O, no RPC.
// =============================================================================

import { encodeFunctionData } from 'viem';
import { ERC20_ABI, ROUTER_ABI, WETH_ABI } from './abis.js';
import { CHAINS, PERMIT2, resolveChain } from './constants.js';
import { Registry } from './registry.js';
import type { Address, ChainRef, Hex, Route, TxRequest } from './types.js';

/** Unlimited allowance (2^256 − 1). Prefer EXACT amounts. */
export const MAX_UINT256 = (1n << 256n) - 1n;

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;

export interface ApproveOptions {
  /** ERC-20 to approve (the swap's tokenIn). */
  token: Address;
  chain: ChainRef;
  /** Allowance in base units. Be exact; MAX_UINT256 opts into unlimited. */
  amount: bigint;
  /** Who may pull the tokens. Default: the latest deployed Router in this
   *  SDK's embedded snapshot — when using the client, prefer `plan.approval`,
   *  which names the Router of the version you actually quoted. */
  spender?: Address;
}

export function buildApproveTx(opts: ApproveOptions): TxRequest {
  const chainId = resolveChain(opts.chain);
  const spender = opts.spender ?? new Registry({ mode: 'embedded' }).resolve(chainId).contracts.router;
  if (!HEX_ADDR.test(opts.token)) throw new Error(`invalid token address: ${opts.token}`);
  if (!HEX_ADDR.test(spender)) throw new Error(`invalid spender address: ${spender}`);
  if (opts.amount < 0n || opts.amount > MAX_UINT256) throw new Error('amount out of uint256 range');
  return {
    chainId,
    to: opts.token,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, opts.amount] }),
    value: 0n,
  };
}

/** Wrap native ETH → WETH (needed on 1.x routers, which have no native entry). */
export function buildWrapTx(chain: ChainRef, amount: bigint): TxRequest {
  const chainId = resolveChain(chain);
  if (amount <= 0n) throw new Error('amount must be > 0');
  return { chainId, to: CHAINS[chainId].weth, data: encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit' }), value: amount };
}

/** Unwrap WETH → native ETH (the Router always delivers WETH for ETH out). */
export function buildUnwrapTx(chain: ChainRef, amount: bigint): TxRequest {
  const chainId = resolveChain(chain);
  if (amount <= 0n) throw new Error('amount must be > 0');
  return {
    chainId, to: CHAINS[chainId].weth,
    data: encodeFunctionData({ abi: WETH_ABI, functionName: 'withdraw', args: [amount] }), value: 0n,
  };
}

// ── Permit2 (SignatureTransfer) — one historical approval of Permit2 per token,
//    then every swap carries a signature instead of a standing allowance. ────

export function randomPermit2Nonce(): bigint {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

export interface Permit2Transfer {
  permitted: { token: Address; amount: bigint };
  nonce: bigint;
  deadline: bigint;
}

/** EIP-712 typed data for Permit2 PermitTransferFrom — pass to signTypedData.
 *  The spender is the Router (it becomes msg.sender of permitTransferFrom). */
export function permit2TypedData(args: {
  chainId: number; token: Address; amount: bigint; spender: Address; nonce: bigint; deadline: bigint;
}) {
  return {
    domain: { name: 'Permit2', chainId: args.chainId, verifyingContract: PERMIT2 },
    types: {
      PermitTransferFrom: [
        { name: 'permitted', type: 'TokenPermissions' },
        { name: 'spender', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
      TokenPermissions: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
    },
    primaryType: 'PermitTransferFrom' as const,
    message: {
      permitted: { token: args.token, amount: args.amount },
      spender: args.spender,
      nonce: args.nonce,
      deadline: args.deadline,
    },
  };
}

export function encodeSwapExactInWithPermit2(
  route: Route, amountIn: bigint, userMinOut: bigint, recipient: Address, deadline: bigint,
  permit: Permit2Transfer, signature: Hex,
): Hex {
  return encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'swapExactInWithPermit2',
    args: [route as never, amountIn, userMinOut, recipient, deadline, permit, signature],
  });
}

// ── human amounts ──────────────────────────────────────────────────────────

/** "1.5" + 18 → 1500000000000000000n. Pure string math — no floats. */
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

/** 1500000000000000000n + 18 → "1.5" (trailing zeros trimmed). */
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
