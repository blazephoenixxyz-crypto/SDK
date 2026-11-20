// ABIs for the 1.0.0 Quoter/Router (struct shapes taken from the pinned XRayProbe ABI, which mirrors
// router-BlazePhoenixCore.sol:50-81), ERC20/WETH and Multicall3. Port of deep-xray-tiers@1998a4d core/abi.mjs,
// reading the pinned probe from probe.ts instead of a file (no I/O in src/xray/).
import { PROBE_ABI, PROBE_KECCAK, PROBE_RUNTIME } from './probe.js';

const pabi = PROBE_ABI as unknown as any[];
const previewT = pabi.find((x) => x.name === 'quoteSelf').outputs[0];
const routeT = previewT.components.find((c: any) => c.name === 'route');
export const PROBE = { abi: PROBE_ABI, runtime: PROBE_RUNTIME, keccak: PROBE_KECCAK } as const;
export const QUOTER_ABI = [{ type: 'function', name: 'previewPlan', stateMutability: 'view',
  inputs: [{ name: 'tIn', type: 'address' }, { name: 'tOut', type: 'address' }, { name: 'amountIn', type: 'uint256' }],
  outputs: [{ ...previewT, name: 'pv' }, { ...routeT, name: 'fallbackRoute' }, { name: 'hasFallback', type: 'bool' }] }] as any;
export const ROUTER_ABI = [{ type: 'function', name: 'swapExactIn', stateMutability: 'nonpayable',
  inputs: [{ ...routeT, name: 'route' }, { name: 'amountIn', type: 'uint256' }, { name: 'userMinOut', type: 'uint256' },
    { name: 'recipient', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] }] as any;
export const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 't', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
] as const;
export const MC3_ABI = [{ type: 'function', name: 'aggregate3Value', stateMutability: 'payable',
  inputs: [{ name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'allowFailure', type: 'bool' },
    { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }],
  outputs: [{ name: 'returnData', type: 'tuple[]', components: [{ name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' }] }] }] as const;
export const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
