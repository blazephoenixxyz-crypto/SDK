// =============================================================================
//  Chain metadata — the parts of a chain that never move: ids, explorers, the
//  canonical wrapped-native and dollar tokens. Contract ADDRESSES are not here:
//  they are versioned, and live in deployments.ts (embedded snapshot) and in
//  the site's registry (GET https://blazephoenix.xyz/api/deployments).
//
//  The SDK ships NO RPC endpoints and NO keys. Every read goes through the node
//  YOU configure — see rpc.ts. That is the whole point of 1.0.
// =============================================================================

export const API_BASE = 'https://blazephoenix.xyz';

/** Where the live, versioned deployment registry is published. Static JSON —
 *  no RPC is ever performed on your behalf by the site. */
export const DEPLOYMENTS_URL = `${API_BASE}/api/deployments`;

export type SupportedChainId = 1 | 8453 | 10 | 42161 | 4663;

export const SUPPORTED_CHAIN_IDS: readonly SupportedChainId[] = [8453, 1, 10, 42161, 4663];

export interface ChainInfo {
  chainId: SupportedChainId;
  name: string;
  /** Short env-var friendly key: BASE, ETHEREUM, OPTIMISM, ARBITRUM, ROBINHOOD. */
  key: string;
  explorer: string;
  weth: `0x${string}`;
  /** The chain's canonical dollar asset (USDG on Robinhood Chain). */
  usdc: `0x${string}`;
  bzpx?: `0x${string}`;
  /** BlazePhoenix staking engine, where live. */
  staking?: `0x${string}`;
  /** Approximate seconds per block — used to size log scans. */
  blockTime: number;
}

export const CHAINS: Record<SupportedChainId, ChainInfo> = {
  1: {
    chainId: 1,
    name: 'Ethereum',
    key: 'ETHEREUM',
    explorer: 'https://etherscan.io',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    blockTime: 12,
  },
  8453: {
    chainId: 8453,
    name: 'Base',
    key: 'BASE',
    explorer: 'https://basescan.org',
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    bzpx: '0x23113e72165a034265Ab8Bf2277CCB7a85Cb7483',
    staking: '0x3f60C7aa0c36a78D200405feBE143d2Cf3fA0c77',
    blockTime: 2,
  },
  10: {
    chainId: 10,
    name: 'Optimism',
    key: 'OPTIMISM',
    explorer: 'https://optimistic.etherscan.io',
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    blockTime: 2,
  },
  42161: {
    chainId: 42161,
    name: 'Arbitrum',
    key: 'ARBITRUM',
    explorer: 'https://arbiscan.io',
    weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    blockTime: 0.25,
  },
  // Robinhood Chain — the dollar asset is USDG, not USDC; the `usdc` field
  // carries the chain's canonical dollar token. Explorer is Blockscout.
  4663: {
    chainId: 4663,
    name: 'Robinhood',
    key: 'ROBINHOOD',
    explorer: 'https://robinhoodchain.blockscout.com',
    weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    usdc: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    blockTime: 2,
  },
};

const ALIASES: Record<string, SupportedChainId> = {
  '1': 1, eth: 1, ethereum: 1, mainnet: 1,
  '8453': 8453, base: 8453,
  '10': 10, op: 10, optimism: 10,
  '42161': 42161, arb: 42161, arbitrum: 42161, 'arbitrum-one': 42161,
  '4663': 4663, rh: 4663, robinhood: 4663, 'robinhood-chain': 4663,
};

/** Accepts a chain id (number or numeric string) or a human alias. */
export function resolveChain(chain: number | string): SupportedChainId {
  const id = ALIASES[String(chain).trim().toLowerCase()];
  if (!id) {
    throw new Error(
      `Unsupported chain "${chain}" — use 8453/base, 1/eth, 10/optimism, `
      + `42161/arbitrum or 4663/robinhood`,
    );
  }
  return id;
}

/** Non-throwing variant, for config parsing. */
export function tryResolveChain(chain: number | string): SupportedChainId | undefined {
  return ALIASES[String(chain).trim().toLowerCase()];
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/** The native-ETH sentinel accepted anywhere a token is (the Router trades
 *  ERC-20s: native input is wrapped by `swapExactInNative` on 2.x routers). */
export const NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as const;

/** Canonical Permit2 (same address on every chain; the Router's default). */
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;

/** Protocol fee in bps. Since 2026-08-22 it is charged ONCE per route on the
 *  first bridge currency the Router holds; `preview.protocolFee` reports its
 *  effect on the output in tokenOut. */
export const FEE_BPS = 28;

/** Router event topic0 hashes. Verified against the ABIs by `npm test`. */
export const SWAP_TOPIC0 =
  '0xd6d34547c69c5ee3d2667625c188acf1006abb93e0ee7cf03925c67cf7760413' as const;
/** 1.x routers only — the fee-exempt surplus promise died with the 2.x fee model. */
export const SURPLUS_TOPIC0 =
  '0x1a3afef0f067eb51a6bfec6ab3625a4408dd8c3571b72836483e68feb70d1026' as const;
/** 2.x routers: quoted vs realised vs floor, emitted beside every Swap. */
export const EXECUTION_PROOF_TOPIC0 =
  '0xb5a62bcb8753e37706da20862f2a32a16831ef0144567eb15b1da49547e9f84c' as const;
/** 2.x routers: what was charged, in which token, split between treasuries. */
export const FEE_TOPIC0 =
  '0x18fa25e22e0f1f39ef2130081363ba86a1259e598e669558683dabfc15bfe731' as const;
