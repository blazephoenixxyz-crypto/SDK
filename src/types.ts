// =============================================================================
//  Public types. Amounts are bigint everywhere (base units). `toJSON()` in
//  json.ts turns any of these into a JSON-safe shape (decimal strings).
// =============================================================================

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/** Chain selector: id (1, 8453, 10, 42161, 4663) or name ("base", "eth",
 *  "optimism", "arbitrum", "robinhood", …). */
export type ChainRef = number | string;

/** Token selector: 0x-address, or one of the universal symbols every chain
 *  carries: ETH (native), WETH, USDC (the chain's dollar asset), BZPX (Base).
 *  Everything else: pass the 0x address — the SDK never guesses a token. */
export type TokenRef = string;

export interface Leg {
  pool: Address;
  hooks: Address;
  kind: number;
  fee: number;
  tickSpacing: number;
  zeroForOne: boolean;
  stable: boolean;
  amountIn: bigint;
  expectedOut: bigint;
  auxId: Hex;
}

export interface Hop {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  expectedOut: bigint;
  legs: readonly Leg[];
}

export interface Route {
  hops: readonly Hop[];
  totalOut: bigint;
  singleOut: bigint;
  singleOutFloor: bigint;
  expectedImpactBps: bigint;
  confidenceWad: bigint;
  estGas: bigint;
  hasSurplus: boolean;
  isV4Bundle: boolean;
}

/** The Quoter's Preview struct, verbatim. */
export interface Preview {
  route: Route;
  grossOut: bigint;
  /** The EFFECT of the protocol fee on the output, in tokenOut. */
  protocolFee: bigint;
  safetyBuffer: bigint;
  /** grossOut · (1 − fee) · (1 − safety) — the number to compare across venues. */
  netOut: bigint;
  /** Output floor supplied by the Solver (the Iron Law floor). */
  ironFloor: bigint;
  userMinOut: bigint;
  /** max(userMinOut, ironFloor) — what the Router is asked to honour at least. */
  effectiveMinOut: bigint;
  estGas: bigint;
  hops: bigint;
  legs: bigint;
  /** 0 direct, 1 via one bridge, 2 via two. */
  topology: number;
  bridgeUsed: Address;
  canExecute: boolean;
}

export type Verdict = 'blocked' | 'danger' | 'caution' | 'ok';

/** Phoenix Check — deterministic invariants derived from the on-chain preview.
 *  Fails closed: `verdict` is never greener than its weakest invariant. */
export interface QuoteChecks {
  verdict: Verdict;
  priceImpact: { bps: number; verdict: Verdict; hardLineBps: number; cautionBps: number; note: string };
  ironFloor: { enforcedOnChain: true; armed: boolean; ironFloor: bigint; effectiveMinOut: bigint; note: string };
  routeShape: { consistent: boolean; hops: number; legs: number; note: string };
  crossCheck: { basis: string; reproducible: true; note: string };
  disclaimer: string;
}

export interface QuoteRequest {
  /** Optional when your client has a single RPC: the node's own chain is used. */
  chain?: ChainRef;
  tokenIn: TokenRef;
  tokenOut: TokenRef;
  /** Input in base units (bigint, or an integer string). */
  amountIn?: bigint | string;
  /** Input in HUMAN units ("1.5"); decimals are read from the token on your RPC. */
  amount?: string;
  /** Tighten the on-chain floor with your own minimum (base units of tokenOut). */
  userMinOut?: bigint | string;
  /** Protocol version for this call (default: the client's, itself 'latest'). */
  version?: string;
  /** Pin the read to a block (reproducibility / verification of past fills). */
  blockNumber?: bigint;
}

export interface Quote {
  chainId: number;
  version: string;
  quoter: Address;
  router: Address;
  /** Where the contract set came from: embedded pin, remote registry, or your override. */
  deploymentSource: 'embedded' | 'remote' | 'override';
  /** As the Router sees them (native ETH already mapped to WETH). */
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** Caller asked with ETH in: 2.x routes it via swapExactInNative (no pre-wrap). */
  nativeIn: boolean;
  /** Caller asked for ETH out: the Router delivers WETH — unwrap is yours. */
  nativeOut: boolean;
  /** Net output after the protocol fee and safety buffer (= preview.netOut). */
  amountOut: bigint;
  preview: Preview;
  route: Route;
  fallbackRoute?: Route;
  checks: QuoteChecks;
  blockNumber?: bigint;
  quotedAt: number;
}

export interface ExactQuote {
  chainId: number;
  version: string;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** Execution-grade NET output (every concentrated leg dry-run on the pool). */
  exactOut: bigint;
  route: Route;
  quotedAt: number;
}

export interface TxRequest {
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
}

export interface SwapRequest extends QuoteRequest {
  /** Who receives tokenOut. */
  recipient: Address;
  /** The account that will send the swap — enables the allowance check and simulation. */
  from?: Address;
  /** Default 50 (0.5%). minOut = netOut − slippage, never below the on-chain floor. */
  slippageBps?: number;
  /** Seconds from now (default 120, 10–3600) — or pass an absolute `deadline`. */
  deadlineSec?: number;
  deadline?: bigint;
  /**
   * 'route' (default) — execute exactly the route the Quoter returned.
   * 'best'  — 2.x only: Router.swapBestExactIn re-solves in the same transaction
   *           (no quote-to-execution seam; costs the solve on top).
   */
  mode?: 'route' | 'best';
  /** Allowance to request when approval is needed: 'exact' (default) or 'max'. */
  approve?: 'exact' | 'max';
}

export interface ApprovalStep {
  token: Address;
  spender: Address;
  amount: bigint;
  /** Current allowance, when `from` was given (undefined = not checked). */
  current?: bigint;
  tx: TxRequest;
}

export interface SwapPlan {
  quote: Quote;
  entry: 'swapExactIn' | 'swapExactInNative' | 'swapBestExactIn';
  /** 'quoter': the bytes are the Quoter's own previewAndEncode output (2.x),
   *  verified field-by-field against what you asked; 'sdk': encoded locally. */
  encodedBy: 'quoter' | 'sdk';
  tx: TxRequest;
  recipient: Address;
  minOut: bigint;
  deadline: bigint;
  slippageBps: number;
  /** null → no approval needed (native input, or allowance already sufficient). */
  approval: ApprovalStep | null;
  /** tokenOut was ETH: the Router delivered WETH — `buildUnwrapTx` to finish. */
  unwrapAfter: boolean;
  /** Ordered transactions to send: [approval?, swap]. */
  steps: TxRequest[];
}

export interface SimulationResult {
  ok: boolean;
  amountOut?: bigint;
  error?: DecodedError;
}

export interface DecodedError {
  contract: 'Router' | 'Quoter' | 'Solver' | 'Hub' | 'unknown';
  name: string;
  code?: number;
  reason: string;
}

/** A decoded on-chain fill (Router `Swap`, plus the 2.x `ExecutionProof`). */
export interface Fill {
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
  user: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  legs: bigint;
  proof?: { quoted: bigint; realized: bigint; floorUsed: bigint };
}

export interface TokenInfo {
  chainId: number;
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  native: boolean;
}

export interface SolvencyReport {
  chainId: number;
  staking: Address;
  isSolvent: boolean;
  backing: bigint;
  owed: bigint;
  surplus: bigint;
  deficit: bigint;
  collateralRatioWad: bigint;
  totalStaked: bigint;
  totalDebt: bigint;
  rewardReserve: bigint;
  protocolReserve: bigint;
  pendingDistribution: bigint;
  totalBadDebt: bigint;
  totalUncollectedInterest: bigint;
  blockNumber: bigint;
}
