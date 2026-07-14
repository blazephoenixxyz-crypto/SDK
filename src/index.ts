// @blazephoenix/sdk — quote, build, execute and index BlazePhoenix swaps.
// Docs & live playground: https://blazephoenix.xyz/?tab=api

export {
  BlazePhoenix, BlazeApiError, buildSwapTx, deepLink,
  type ClientOptions, type DeepLinkOptions,
} from './client.js';
export {
  API_BASE, CHAINS, FEE_BPS, SWAP_TOPIC0, SURPLUS_TOPIC0, resolveChain,
  type ChainInfo, type SupportedChainId,
} from './constants.js';
export { QUOTER_ABI, ROUTER_ABI } from './abis.js';
export {
  quoteOnChain, watchFills, getFills,
  type OnChainOptions, type WatchFillsOptions,
} from './onchain.js';
export type {
  Address, Hex, ChainRef, TokenRef,
  QuoteRequest, QuoteResponse, QuoteSummary, QuoteRoute, QuoteHop, QuoteLeg, QuoteTx,
  ApiErrorBody, BatchResult, BatchResponse,
  ManifestResponse, ManifestChain, Fill,
} from './types.js';
