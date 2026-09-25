// =============================================================================
//  ABIs. The protocol ABIs are GENERATED from the BlazePhoenix-Dex sources
//  (scripts/gen-abis.mjs) — the Route/Hop/Leg/Preview tuples are exactly the
//  compiled ones, so a decoded route round-trips verbatim into the Router.
//  The 1.x deployments share every function the SDK calls on them
//  (previewPlan, previewPlanWithMinOut, previewPlanExact, swapExactIn,
//  swapExactInWithPermit2); 2.x-only entry points are gated by version.
// =============================================================================

export {
  CORE_ABI, HUB_ABI, SOLVER_ABI, QUOTER_ABI, ROUTER_ABI, BLAZE_ERRORS_ABI, ABI_SOURCE_REVISION,
} from './abis.generated.js';

export const ERC20_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'allowance', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
] as const;

export const WETH_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  {
    type: 'function', name: 'withdraw', stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }], outputs: [],
  },
] as const;

const SOLVENCY_REPORT = [
  { name: 'backing', type: 'uint256' },
  { name: 'owed', type: 'uint256' },
  { name: 'surplus', type: 'uint256' },
  { name: 'deficit', type: 'uint256' },
  { name: 'solvent', type: 'bool' },
  { name: 'collateralRatioWad', type: 'uint256' },
  { name: 'totalStaked', type: 'uint256' },
  { name: 'totalDebt', type: 'uint256' },
  { name: 'rewardReserve', type: 'uint256' },
  { name: 'protocolReserve', type: 'uint256' },
  { name: 'pendingDistribution', type: 'uint256' },
  { name: 'totalBadDebt', type: 'uint256' },
  { name: 'totalUncollectedInterest', type: 'uint256' },
] as const;

/** The staking engine's proof-of-solvency surface (BlazePhoenixStaking 3.x). */
export const STAKING_SOLVENCY_ABI = [
  {
    type: 'function', name: 'solvency', stateMutability: 'view', inputs: [],
    outputs: [{ name: 'r', type: 'tuple', components: SOLVENCY_REPORT }],
  },
  { type: 'function', name: 'isSolvent', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const;
