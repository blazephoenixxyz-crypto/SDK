// =============================================================================
//  On-chain module — skip HTTP entirely: quote on the Quoter from your own
//  node and watch the Router's fills. Needs the optional `viem` peer:
//      npm i viem
//  You supply the RPC URL — the SDK ships no keys and no default endpoints.
// =============================================================================

import { QUOTER_ABI, ROUTER_ABI } from './abis.js';
import { CHAINS, resolveChain } from './constants.js';
import type { Address, Fill } from './types.js';

async function loadViem() {
  try {
    return await import('viem');
  } catch {
    throw new Error("this feature needs the optional peer dependency 'viem' — npm i viem");
  }
}

export interface OnChainOptions {
  chain: number | string;
  /** Your RPC endpoint for that chain (the SDK ships none by design). */
  rpcUrl: string;
}

/** previewPlan straight from the chain — the exact numbers the API serves. */
export async function quoteOnChain(
  opts: OnChainOptions & { tokenIn: Address; tokenOut: Address; amountIn: bigint },
) {
  const { createPublicClient, http } = await loadViem();
  const chainId = resolveChain(opts.chain);
  const client = createPublicClient({ transport: http(opts.rpcUrl) });
  const [pv, , hasFallback] = (await client.readContract({
    address: CHAINS[chainId].contracts.quoter,
    abi: QUOTER_ABI,
    functionName: 'previewPlan',
    args: [opts.tokenIn, opts.tokenOut, opts.amountIn],
  })) as readonly [Record<string, unknown>, unknown, boolean];
  return { preview: pv, hasFallback, chainId };
}

export interface WatchFillsOptions extends OnChainOptions {
  onFill: (fill: Fill) => void;
  /** Poll interval in ms (default 4000). */
  pollMs?: number;
}

/** Stream every BlazePhoenix fill on a chain (one Router `Swap` event per
 *  swap). Returns an unwatch function. */
export async function watchFills(opts: WatchFillsOptions): Promise<() => void> {
  const { createPublicClient, http, parseAbiItem } = await loadViem();
  const chainId = resolveChain(opts.chain);
  const client = createPublicClient({ transport: http(opts.rpcUrl) });
  return client.watchEvent({
    address: CHAINS[chainId].contracts.router,
    event: parseAbiItem(
      'event Swap(address indexed user, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 legs)',
    ),
    pollingInterval: opts.pollMs ?? 4_000,
    onLogs: (logs) => {
      for (const log of logs) {
        const a = log.args as {
          user: Address; tokenIn: Address; tokenOut: Address;
          amountIn: bigint; amountOut: bigint; legs: bigint;
        };
        opts.onFill({
          txHash: log.transactionHash as `0x${string}`,
          blockNumber: log.blockNumber ?? 0n,
          user: a.user, tokenIn: a.tokenIn, tokenOut: a.tokenOut,
          amountIn: a.amountIn, amountOut: a.amountOut, legs: a.legs,
        });
      }
    },
  });
}

/** Historic fills over a block range (for indexing / the quoted-vs-executed
 *  verification pattern documented at https://blazephoenix.xyz/?tab=api). */
export async function getFills(
  opts: OnChainOptions & { fromBlock: bigint; toBlock: bigint },
): Promise<Fill[]> {
  const { createPublicClient, http, parseAbiItem } = await loadViem();
  const chainId = resolveChain(opts.chain);
  const client = createPublicClient({ transport: http(opts.rpcUrl) });
  const logs = await client.getLogs({
    address: CHAINS[chainId].contracts.router,
    event: parseAbiItem(
      'event Swap(address indexed user, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 legs)',
    ),
    fromBlock: opts.fromBlock,
    toBlock: opts.toBlock,
  });
  return logs.map((log) => {
    const a = log.args as {
      user: Address; tokenIn: Address; tokenOut: Address;
      amountIn: bigint; amountOut: bigint; legs: bigint;
    };
    return {
      txHash: log.transactionHash as `0x${string}`,
      blockNumber: log.blockNumber ?? 0n,
      user: a.user, tokenIn: a.tokenIn, tokenOut: a.tokenOut,
      amountIn: a.amountIn, amountOut: a.amountOut, legs: a.legs,
    };
  });
}

export { ROUTER_ABI, QUOTER_ABI };
