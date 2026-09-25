// @blazephoenix/sdk 1.x — quote, build, verify and execute BlazePhoenix swaps
// 100% on YOUR RPC. No API in the read path, no key, no endpoints shipped.
// Docs: https://github.com/blazephoenixxyz-crypto/SDK

export {
  BlazePhoenix, deepLink, pollQuote,
  type ClientOptions, type BatchItem, type ExecuteOptions, type ExecuteResult,
  type DeploymentReport, type DeploymentCheck, type DeepLinkOptions, type PollOptions,
} from './client.js';
export {
  RpcRouter, rpcFromEnv, transportFrom, isAllowedRpcUrl, redact,
  type RpcConfig, type RpcSource, type Eip1193Like, type TransportOptions,
} from './rpc.js';
export {
  Registry,
  type RegistryOptions, type ResolvedDeployment, type ContractOverride, type ContractOverrides, type DeploymentSource,
} from './registry.js';
export {
  EMBEDDED_DEPLOYMENTS, CONTRACT_KEYS, featuresOf, isDeployed, compareVersions, matchesSelector, validateRegistry,
  type ContractSet, type ContractKey, type DeploymentRegistry, type DeploymentVersion, type DeploymentStatus,
  type VersionSelector, type VersionFeatures,
} from './deployments.js';
export {
  API_BASE, DEPLOYMENTS_URL, CHAINS, SUPPORTED_CHAIN_IDS, NATIVE_TOKEN, PERMIT2, ZERO_ADDRESS, FEE_BPS,
  SWAP_TOPIC0, SURPLUS_TOPIC0, EXECUTION_PROOF_TOPIC0, FEE_TOPIC0, resolveChain,
  type ChainInfo, type SupportedChainId,
} from './constants.js';
export {
  QUOTER_ABI, ROUTER_ABI, SOLVER_ABI, HUB_ABI, CORE_ABI, BLAZE_ERRORS_ABI, ABI_SOURCE_REVISION,
  ERC20_ABI, WETH_ABI, STAKING_SOLVENCY_ABI,
} from './abis.js';
export {
  encodeSwapExactIn, encodeSwapExactInNative, encodeSwapBestExactIn, decodeSwapExactIn,
  verifySwapExactIn, tightenMinOut, minOutFor, routeFingerprint,
  type DecodedSwapExactIn, type SwapExpectation,
} from './calldata.js';
export { phoenixCheck, routeIsConsistent, HARD_IMPACT_BPS, CAUTION_IMPACT_BPS } from './checks.js';
export {
  BlazeError, decodeBlazeError, decodeRevertData, describeProtocolError,
  type BlazeErrorCode,
} from './errors.js';
export {
  buildApproveTx, buildWrapTx, buildUnwrapTx, permit2TypedData, randomPermit2Nonce, encodeSwapExactInWithPermit2,
  toBaseUnits, fromBaseUnits, MAX_UINT256,
  type ApproveOptions, type Permit2Transfer,
} from './erc20.js';
export { toJSON, type Jsonify } from './json.js';
export { resilientFetch, singleflight, type RetryOptions } from './resilience.js';
export type {
  Address, Hex, ChainRef, TokenRef, Leg, Hop, Route, Preview, Verdict, QuoteChecks,
  QuoteRequest, Quote, ExactQuote, TxRequest, SwapRequest, ApprovalStep, SwapPlan,
  SimulationResult, DecodedError, Fill, TokenInfo, SolvencyReport,
} from './types.js';
