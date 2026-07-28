// @blazephoenix/sdk — quote, build, execute and index BlazePhoenix swaps.
// Docs & live playground: https://blazephoenix.xyz/?tab=api

export {
  BlazePhoenix, BlazeApiError, buildSwapTx, deepLink, pollQuote,
  type ClientOptions, type DeepLinkOptions, type PollOptions,
} from './client.js';
export { resilientFetch, singleflight, type RetryOptions } from './resilience.js';
export {
  API_BASE, CHAINS, PUBLIC_RPCS, FEE_BPS, SWAP_TOPIC0, SURPLUS_TOPIC0, resolveChain,
  type ChainInfo, type SupportedChainId,
} from './constants.js';
export { QUOTER_ABI, ROUTER_ABI } from './abis.js';
export {
  buildApproveTx, toBaseUnits, fromBaseUnits, MAX_UINT256,
  type ApproveOptions,
} from './erc20.js';
export {
  quoteOnChain, watchFills, getFills,
  type OnChainOptions, type WatchFillsOptions,
} from './onchain.js';
export type {
  Address, Hex, ChainRef, TokenRef,
  QuoteRequest, QuoteResponse, QuoteChecks, QuoteSummary, QuoteRoute, QuoteHop, QuoteLeg, QuoteTx,
  ApiErrorBody, BatchResult, BatchResponse,
  ManifestResponse, ManifestChain, Fill,
} from './types.js';
