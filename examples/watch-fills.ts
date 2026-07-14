// Stream every BlazePhoenix fill on Base. Needs viem: npm i viem
// RPC_URL=https://your-rpc npx tsx examples/watch-fills.ts
import { watchFills } from '@blazephoenix/sdk';

const unwatch = await watchFills({
  chain: 'base',
  rpcUrl: process.env.RPC_URL!, // bring your own node — the SDK ships no keys
  onFill: (f) => {
    console.log(
      `${f.txHash} — ${f.user} swapped ${f.amountIn} (${f.tokenIn}) → ${f.amountOut} (${f.tokenOut}) via ${f.legs} legs`,
    );
  },
});

process.on('SIGINT', () => { unwatch(); process.exit(0); });
