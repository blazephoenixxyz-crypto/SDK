// =============================================================================
//  Protocol constants — BlazePhoenix v1.0.0 deployments.
//  Source of truth at runtime: GET https://blazephoenix.xyz/api/manifest
//  (these statics let the SDK work fully offline / on-chain-only).
// =============================================================================

export const API_BASE = 'https://blazephoenix.xyz';

export type SupportedChainId = 1 | 8453 | 10 | 42161;

export interface ChainInfo {
  chainId: SupportedChainId;
  name: string;
  explorer: string;
  weth: `0x${string}`;
  usdc: `0x${string}`;
  bzpx?: `0x${string}`;
  contracts: {
    hub: `0x${string}`;
    solver: `0x${string}`;
    router: `0x${string}`;
    quoter: `0x${string}`;
  };
}

export const CHAINS: Record<SupportedChainId, ChainInfo> = {
  1: {
    chainId: 1,
    name: 'Ethereum',
    explorer: 'https://etherscan.io',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    contracts: {
      hub: '0xc4FA9a5720fe3294D3AA9fc427E2a760591E57ae',
      solver: '0xc124d91258db0C14bf13b826CF64E16bfEA8a73e',
      router: '0xE1aE5f49013920CF71De8CED4043e14C4d63416b',
      quoter: '0x4a20AA0912388ff7A9221Ab6BFC224cc20Baa0c3',
    },
  },
  8453: {
    chainId: 8453,
    name: 'Base',
    explorer: 'https://basescan.org',
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    bzpx: '0x23113e72165a034265Ab8Bf2277CCB7a85Cb7483',
    contracts: {
      hub: '0x428554DEe93A1B8B5Bc6Fd19adDAfe55106fc04C',
      solver: '0xB1902990260975dD4C89ad74B1f317bc100CB830',
      router: '0x2a779f9Be49aac57495A8B6467Cc325a8a47Eb9f',
      quoter: '0x4cEF0615614B212895F45Aa1D4833B16666E18d3',
    },
  },
  10: {
    chainId: 10,
    name: 'Optimism',
    explorer: 'https://optimistic.etherscan.io',
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    contracts: {
      hub: '0x23113e72165a034265Ab8Bf2277CCB7a85Cb7483',
      solver: '0x0c0d96B237FABa8FE5e8aE77754Ef29109D2B33f',
      router: '0x7262e7483ab6f0db7b8f90eC3a9de3B02Ab36F6A',
      quoter: '0xfB18EF6f62A0278A273Af4b7A46b454F9E482dc2',
    },
  },
  42161: {
    chainId: 42161,
    name: 'Arbitrum',
    explorer: 'https://arbiscan.io',
    weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    contracts: {
      hub: '0x23113e72165a034265Ab8Bf2277CCB7a85Cb7483',
      solver: '0x0c0d96B237FABa8FE5e8aE77754Ef29109D2B33f',
      router: '0x7262e7483ab6f0db7b8f90eC3a9de3B02Ab36F6A',
      quoter: '0xfB18EF6f62A0278A273Af4b7A46b454F9E482dc2',
    },
  },
};

/** Accepts a chain id (number or numeric string) or a human alias. */
export function resolveChain(chain: number | string): SupportedChainId {
  const aliases: Record<string, SupportedChainId> = {
    '1': 1, eth: 1, ethereum: 1, mainnet: 1,
    '8453': 8453, base: 8453,
    '10': 10, op: 10, optimism: 10,
    '42161': 42161, arb: 42161, arbitrum: 42161, 'arbitrum-one': 42161,
  };
  const id = aliases[String(chain).trim().toLowerCase()];
  if (!id) {
    throw new Error(
      `Unsupported chain "${chain}" — use 8453/base, 1/eth, 10/optimism or 42161/arbitrum`,
    );
  }
  return id;
}

/** Protocol fee (bps) applied to quoted output; execution surplus is fee-exempt. */
export const FEE_BPS = 28;

/** Router event topic0 hashes (one `Swap` per fill — index everything with them).
 *  Verified against the ABIs by `npm test` (viem toEventSelector). */
export const SWAP_TOPIC0 =
  '0xd6d34547c69c5ee3d2667625c188acf1006abb93e0ee7cf03925c67cf7760413' as const;
export const SURPLUS_TOPIC0 =
  '0x1a3afef0f067eb51a6bfec6ab3625a4408dd8c3571b72836483e68feb70d1026' as const;
