// Offline conformance tests — no network. Run: npm test
import { toEventSelector, toFunctionSelector, getAbiItem, type AbiFunction } from 'viem';
import { QUOTER_ABI, ROUTER_ABI } from '../src/abis.js';
import { CHAINS, SWAP_TOPIC0, SURPLUS_TOPIC0, resolveChain, FEE_BPS } from '../src/constants.js';
import { BlazePhoenix, deepLink, buildSwapTx, BlazeApiError } from '../src/client.js';
import type { QuoteResponse } from '../src/types.js';

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq<T>(name: string, got: T, want: T) {
  check(name, Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want),
    `got ${String(got)}, want ${String(want)}`);
}

// ── ABI ↔ hardcoded constants coherence ─────────────────────────────────────
eq('Swap topic0 matches ABI',
  toEventSelector(getAbiItem({ abi: ROUTER_ABI, name: 'Swap' }) as never), SWAP_TOPIC0);
eq('Surplus topic0 matches ABI',
  toEventSelector(getAbiItem({ abi: ROUTER_ABI, name: 'Surplus' }) as never), SURPLUS_TOPIC0);
eq('previewPlan selector',
  toFunctionSelector(getAbiItem({ abi: QUOTER_ABI, name: 'previewPlan' }) as AbiFunction),
  '0x49d5f197');
check('swapExactIn present',
  !!getAbiItem({ abi: ROUTER_ABI, name: 'swapExactIn' }));

// ── chain resolution ─────────────────────────────────────────────────────────
eq('base name → 8453', resolveChain('base'), 8453);
eq('8453 number → 8453', resolveChain(8453), 8453);
eq('eth alias → 1', resolveChain('ETH'), 1);
eq('arbitrum-one alias', resolveChain('arbitrum-one'), 42161);
check('unknown chain throws', (() => { try { resolveChain('solana'); return false; } catch { return true; } })());
check('all four chains configured',
  ([1, 8453, 10, 42161] as const).every((id) => CHAINS[id].contracts.quoter.startsWith('0x')));
// The SDK must never ship provider endpoints or keys — only public explorers
// and contract addresses. (Integrators bring their own rpcUrl.)
{
  const s = JSON.stringify(CHAINS).toLowerCase();
  check('SDK ships no RPC providers or keys (by design)',
    !s.includes('alchemy') && !s.includes('drpc') && !s.includes('infura')
    && !s.includes('rpc.') && !s.includes('/v2/'));
}
eq('fee bps', FEE_BPS, 28);

// ── URL building ─────────────────────────────────────────────────────────────
const c = new BlazePhoenix();
const url = c.quoteUrl({ chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 10n ** 18n });
eq('quote URL',
  url,
  'https://blazephoenix.xyz/api/quote?chain=8453&in=WETH&out=USDC&amountIn=1000000000000000000');
const url2 = c.quoteUrl({
  chain: 1, tokenIn: 'ETH', tokenOut: '0x23113e72165a034265Ab8Bf2277CCB7a85Cb7483',
  amountIn: '5', recipient: '0x0000000000000000000000000000000000000001', slippageBps: 50, exact: true,
});
check('quote URL carries optional params',
  url2.includes('recipient=0x0000000000000000000000000000000000000001')
  && url2.includes('slippageBps=50') && url2.includes('exact=1') && url2.includes('chain=1'));

// ── deep links ───────────────────────────────────────────────────────────────
eq('deep link default tab',
  deepLink({ chain: 'base', tokenIn: 'ETH', tokenOut: 'BZPX', amount: '0.5' }),
  'https://blazephoenix.xyz/?tab=swap&chain=8453&in=ETH&out=BZPX&amt=0.5');
eq('deep link api tab', deepLink({ tab: 'api' }), 'https://blazephoenix.xyz/?tab=api');

// ── buildSwapTx guardrails ───────────────────────────────────────────────────
const fakeTx = { to: '0x2a779f9Be49aac57495A8B6467Cc325a8a47Eb9f', data: '0x00', value: '0' } as const;
const withTx = { ok: true, tx: fakeTx, wrapRequired: false } as unknown as QuoteResponse;
eq('buildSwapTx returns tx', buildSwapTx(withTx), fakeTx);
check('buildSwapTx explains missing recipient',
  (() => { try { buildSwapTx({ ok: true, wrapRequired: false } as unknown as QuoteResponse); return false; }
    catch (e) { return String(e).includes('recipient'); } })());
check('buildSwapTx explains native input',
  (() => { try { buildSwapTx({ ok: true, wrapRequired: true } as unknown as QuoteResponse); return false; }
    catch (e) { return String(e).includes('WETH'); } })());

// ── ERC-20 helpers: approve calldata verified against viem ─────────────────
{
  const { buildApproveTx, toBaseUnits, fromBaseUnits, MAX_UINT256 } = await import('../src/erc20.js');
  const { encodeFunctionData } = await import('viem');
  const token = '0x4200000000000000000000000000000000000006' as const; // WETH (Base)
  const amount = 1_500_000_000_000_000_000n;
  const tx = buildApproveTx({ token, chain: 'base', amount });
  const viaViem = encodeFunctionData({
    abi: [{ type: 'function', name: 'approve', stateMutability: 'nonpayable',
      inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }],
      outputs: [{ type: 'bool' }] }],
    functionName: 'approve',
    args: [CHAINS[8453].contracts.router, amount],
  });
  eq('approve: calldata matches viem encode', tx.data, viaViem);
  eq('approve: targets the token', tx.to, token);
  eq('approve: default spender is the chain Router',
    tx.data.slice(34, 74), CHAINS[8453].contracts.router.slice(2).toLowerCase());
  check('approve: bad token rejected',
    (() => { try { buildApproveTx({ token: '0xnope' as never, chain: 'base', amount: 1n }); return false; } catch { return true; } })());
  check('approve: MAX_UINT256 accepted',
    buildApproveTx({ token, chain: 'base', amount: MAX_UINT256 }).data.endsWith('f'.repeat(64)));

  eq('toBaseUnits: 1.5 @18', toBaseUnits('1.5', 18), 1_500_000_000_000_000_000n);
  eq('toBaseUnits: 0.000001 @6', toBaseUnits('0.000001', 6), 1n);
  eq('toBaseUnits: integer', toBaseUnits('42', 0), 42n);
  check('toBaseUnits: too many dp rejected',
    (() => { try { toBaseUnits('1.1234567', 6); return false; } catch { return true; } })());
  check('toBaseUnits: junk rejected',
    (() => { try { toBaseUnits('1,5', 18); return false; } catch { return true; } })());
  eq('fromBaseUnits: round-trip', fromBaseUnits(toBaseUnits('123.456', 18), 18), '123.456');
  eq('fromBaseUnits: trims zeros', fromBaseUnits(1_500_000n, 6), '1.5');
  eq('fromBaseUnits: maxDp truncates', fromBaseUnits(1_234_567n, 6, 2), '1.23');
}

// ── error type ───────────────────────────────────────────────────────────────
const err = new BlazeApiError('no_route', 'no executable route', 422);
check('BlazeApiError shape', err.code === 'no_route' && err.status === 422 && err instanceof Error);

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
