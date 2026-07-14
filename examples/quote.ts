// npx tsx examples/quote.ts
import { BlazePhoenix } from '@blazephoenix/sdk';

const blaze = new BlazePhoenix();

// 1 WETH → USDC on Base (amountIn is base units)
const q = await blaze.quote({
  chain: 'base',
  tokenIn: 'WETH',
  tokenOut: 'USDC',
  amountIn: 10n ** 18n,
});

console.log('amountOut (USDC, 6dp):', q.amountOut);
console.log('impact (bps):', q.quote?.impactBps, '| est gas:', q.quote?.estGas);
console.log('route hops:', q.route.hops.length, '| surplus expected:', q.quote?.hasSurplus);
