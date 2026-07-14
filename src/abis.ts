// =============================================================================
//  BlazePhoenix Router + Quoter ABI fragments (match the v1.0.0 deployments).
//  The Route/Hop/Leg tuple mirrors BlazePhoenixCore.sol — a decoded route from
//  `previewPlan` round-trips verbatim into `swapExactIn`.
// =============================================================================

const LEG_COMPONENTS = [
  { name: 'pool', type: 'address' },
  { name: 'hooks', type: 'address' },
  { name: 'kind', type: 'uint8' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'zeroForOne', type: 'bool' },
  { name: 'stable', type: 'bool' },
  { name: 'amountIn', type: 'uint256' },
  { name: 'expectedOut', type: 'uint256' },
  { name: 'auxId', type: 'bytes32' },
] as const;

const HOP_COMPONENTS = [
  { name: 'tokenIn', type: 'address' },
  { name: 'tokenOut', type: 'address' },
  { name: 'amountIn', type: 'uint256' },
  { name: 'expectedOut', type: 'uint256' },
  { name: 'legs', type: 'tuple[]', components: LEG_COMPONENTS },
] as const;

const ROUTE_COMPONENTS = [
  { name: 'hops', type: 'tuple[]', components: HOP_COMPONENTS },
  { name: 'totalOut', type: 'uint256' },
  { name: 'singleOut', type: 'uint256' },
  { name: 'singleOutFloor', type: 'uint256' },
  { name: 'expectedImpactBps', type: 'uint256' },
  { name: 'confidenceWad', type: 'uint256' },
  { name: 'estGas', type: 'uint256' },
  { name: 'hasSurplus', type: 'bool' },
  { name: 'isV4Bundle', type: 'bool' },
] as const;

const PREVIEW_COMPONENTS = [
  { name: 'route', type: 'tuple', components: ROUTE_COMPONENTS },
  { name: 'grossOut', type: 'uint256' },
  { name: 'protocolFee', type: 'uint256' },
  { name: 'safetyBuffer', type: 'uint256' },
  { name: 'netOut', type: 'uint256' },
  { name: 'ironFloor', type: 'uint256' },
  { name: 'userMinOut', type: 'uint256' },
  { name: 'effectiveMinOut', type: 'uint256' },
  { name: 'estGas', type: 'uint256' },
  { name: 'hops', type: 'uint256' },
  { name: 'legs', type: 'uint256' },
  { name: 'topology', type: 'uint8' },
  { name: 'bridgeUsed', type: 'address' },
  { name: 'canExecute', type: 'bool' },
] as const;

export const QUOTER_ABI = [
  {
    type: 'function',
    name: 'previewPlan',
    stateMutability: 'view',
    inputs: [
      { name: 'tIn', type: 'address' },
      { name: 'tOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
    ],
    outputs: [
      { name: 'pv', type: 'tuple', components: PREVIEW_COMPONENTS },
      { name: 'fallbackRoute', type: 'tuple', components: ROUTE_COMPONENTS },
      { name: 'hasFallback', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'previewPlanExact',
    stateMutability: 'view',
    inputs: [
      { name: 'tIn', type: 'address' },
      { name: 'tOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
    ],
    outputs: [
      { name: 'route', type: 'tuple', components: ROUTE_COMPONENTS },
      { name: 'exactOut', type: 'uint256' },
    ],
  },
] as const;

export const ROUTER_ABI = [
  {
    type: 'function',
    name: 'swapExactIn',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'route', type: 'tuple', components: ROUTE_COMPONENTS },
      { name: 'amountIn', type: 'uint256' },
      { name: 'userMinOut', type: 'uint256' },
      { name: 'recipient', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Swap',
    inputs: [
      { name: 'user', type: 'address', indexed: true },
      { name: 'tokenIn', type: 'address', indexed: true },
      { name: 'tokenOut', type: 'address', indexed: true },
      { name: 'amountIn', type: 'uint256', indexed: false },
      { name: 'amountOut', type: 'uint256', indexed: false },
      { name: 'legs', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Surplus',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
] as const;
