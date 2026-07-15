// =============================================================================
//  Wire types — mirror the public API responses (numbers travel as decimal
//  strings; convert with BigInt(...) where you need math).
// =============================================================================

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/** Chain selector: id (1, 8453, 10, 42161) or name ("base", "eth", …). */
export type ChainRef = number | string;

/** Token selector: 0x-address, ETH / WETH / USDC / BZPX, or (single-quote
 *  endpoint only) ANY traded symbol — the API resolves unknown tickers to the
 *  deepest-liquidity token on that chain and echoes the resolution back in
 *  `resolved`. Pass 0x addresses when you need precision; the batch endpoint
 *  takes addresses/built-in symbols only. */
export type TokenRef = string;

export interface QuoteRequest {
  chain: ChainRef;
  tokenIn: TokenRef;
  tokenOut: TokenRef;
  /** Input amount in the token's base units (wei-style). */
  amountIn: bigint | string;
  /** When set, the response includes ready-to-send `tx` calldata. */
  recipient?: Address;
  /** 0–5000. Default: the protocol's own execution floor (effectiveMinOut). */
  slippageBps?: number;
  /** 10–3600 seconds. Default 120. */
  deadlineSec?: number;
  /** Execution-grade re-quote (previewPlanExact) — slower, sharper. */
  exact?: boolean;
}

export interface QuoteLeg {
  pool: Address;
  hooks: Address;
  kind: number;
  fee: number;
  tickSpacing: number;
  zeroForOne: boolean;
  stable: boolean;
  amountIn: string;
  expectedOut: string;
  auxId: Hex;
}

export interface QuoteHop {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: string;
  expectedOut: string;
  legs: QuoteLeg[];
}

export interface QuoteRoute {
  hops: QuoteHop[];
  totalOut: string;
  singleOut: string;
  singleOutFloor: string;
  expectedImpactBps: string;
  confidenceWad: string;
  estGas: string;
  hasSurplus: boolean;
  isV4Bundle: boolean;
}

export interface QuoteSummary {
  grossOut: string;
  protocolFee: string;
  netOut: string;
  ironFloor: string;
  effectiveMinOut: string;
  impactBps: number;
  estGas: string;
  hops: number;
  legs: number;
  canExecute: boolean;
  hasSurplus: boolean;
  feeBps: number;
}

export interface QuoteTx {
  to: Address;
  data: Hex;
  value: '0';
}

export interface QuoteResponse {
  ok: true;
  mode: 'preview' | 'exact';
  chainId: number;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: string;
  /** Net output after the protocol fee — the number to compare across venues. */
  amountOut: string;
  quote?: QuoteSummary;          // preview mode
  route: QuoteRoute;
  tx?: QuoteTx;                  // present when `recipient` was sent
  wrapRequired: boolean;         // in=ETH → wrap to WETH first
  unwrapAfter?: boolean;         // out=ETH → Router delivers WETH
  /** Present when a symbol was resolved server-side: per side
   *  { symbol, address, name?, liquidityUsd }. Always check it when quoting
   *  by ticker — it tells you exactly which token you got. */
  resolved?: Record<string, { symbol: string; address: Address; name?: string; liquidityUsd: number }>;
  resolvedNote?: string;
  executeWith?: { router: Address; function: string; note: string };
  meta: { quotedAt: number; latencyMs: number; rpcTried: number };
}

export interface ApiErrorBody {
  ok: false;
  code: string;
  error: string;
  chainId?: number;
}

export type BatchResult = QuoteResponse | ApiErrorBody;

export interface BatchResponse {
  ok: true;
  count: number;
  results: BatchResult[];
}

export interface ManifestChain {
  chainId: number;
  name: string;
  live: boolean;
  explorer: string;
  contracts: { hub: Address; solver: Address; router: Address; quoter: Address; staking: Address };
  weth: Address;
  usdc: Address;
  bzpx?: Address;
}

export interface ManifestResponse {
  ok: true;
  name: string;
  version: string;
  url: string;
  docs: string;
  quoteApi: string;
  token: { symbol: string; chain: string; address: Address; basescan: string; totalSupply: string };
  feeBps: number;
  chains: ManifestChain[];
  events: Record<string, { signature: string; topic0: Hex }>;
  contact: string;
}

export interface HealthResponse {
  ok: true;
  service: string;
  version: string;
  now: number;
  chains: { chainId: number; name: string; live: boolean }[];
}

/** A decoded on-chain fill (Router `Swap` event). */
export interface Fill {
  txHash: Hex;
  blockNumber: bigint;
  user: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  legs: bigint;
}
