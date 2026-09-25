// BASE_RPC_URL=https://your-base-node npx tsx examples/quote.ts
// Every number below is an eth_call on YOUR node — no API, no key of ours.
import { BlazePhoenix, fromBaseUnits } from '@blazephoenix/sdk';

const blaze = new BlazePhoenix({ rpc: { base: process.env.BASE_RPC_URL! } });

// 1 WETH → USDC on Base ("amount" is human units; decimals are read on-chain)
const q = await blaze.quote({ chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC', amount: '1' });

console.log(`protocol v${q.version} (${q.deploymentSource}) · quoter ${q.quoter}`);
console.log('amountOut (USDC):', fromBaseUnits(q.amountOut, 6));
console.log('impact (bps):', q.checks.priceImpact.bps, '| est gas:', q.preview.estGas);
console.log('route hops:', q.route.hops.length, '| Phoenix Check:', q.checks.verdict);

// Build the swap for your address — verified calldata, approval step included.
const me = process.env.ME as `0x${string}` | undefined;
if (me) {
  const plan = await blaze.buildSwap({
    chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC', amount: '1',
    recipient: me, from: me, slippageBps: 50,
  });
  console.log(`send ${plan.steps.length} tx(s):`, plan.steps.map((t) => ({ to: t.to, value: t.value })));
  console.log('minimum enforced:', fromBaseUnits(plan.minOut, 6), 'USDC · encoded by', plan.encodedBy);
  console.log('simulation:', await blaze.simulate(plan, me));
}
