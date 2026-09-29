// Stream every BlazePhoenix fill on Base, read from YOUR node.
// BASE_RPC_URL=https://your-base-node npx tsx examples/watch-fills.ts
import { BlazePhoenix } from '@blazephoenix/sdk';

const blaze = new BlazePhoenix({ rpc: { base: process.env.BASE_RPC_URL! } });

const unwatch = await blaze.watchFills({
  chain: 'base',
  onFill: (f) => {
    const proof = f.proof ? ` · quoted ${f.proof.quoted} realised ${f.proof.realized} floor ${f.proof.floorUsed}` : '';
    console.log(`${f.txHash} — ${f.user} swapped ${f.amountIn} (${f.tokenIn}) → ${f.amountOut} (${f.tokenOut}) via ${f.legs} legs${proof}`);
  },
});

process.on('SIGINT', () => { unwatch(); process.exit(0); });
