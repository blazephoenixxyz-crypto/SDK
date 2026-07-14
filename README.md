# @blazephoenix/sdk

Official TypeScript SDK for **[BlazePhoenix](https://blazephoenix.xyz)** — the on-chain
DEX aggregator on **Base · Ethereum · Optimism · Arbitrum**.

Every number the API serves is computed **on-chain** by the Quoter contract
(`previewPlan`) — your bot, your frontend and the site itself all read the same truth.
**No API key. No signup. Open CORS.**

> Live docs & playground: **https://blazephoenix.xyz/?tab=api**

```bash
npm i github:blazephoenixxyz-crypto/SDK   # builds on install — no registry needed
# (or, once published to npm:)  npm i @blazephoenix/sdk
# optional (only for the on-chain module: quoteOnChain / watchFills / getFills):
npm i viem
```

## Quote → approve → send (the whole loop)

```ts
import { BlazePhoenix, buildSwapTx, buildApproveTx, toBaseUnits } from '@blazephoenix/sdk';

const blaze = new BlazePhoenix();
const amountIn = toBaseUnits('1.5', 18);   // "1.5" WETH → 1500000000000000000n

const q = await blaze.quote({
  chain: 'base',                 // 8453 | 'base' | 1 | 'eth' | 10 | 42161 …
  tokenIn: 'WETH',               // 0x-address, ETH/WETH/USDC/BZPX — or ANY traded
                                 //   symbol ('TOSHI', 'DEGEN'…): resolved to the
                                 //   deepest-liquidity token, echoed in q.resolved
  tokenOut: 'USDC',
  amountIn,
  recipient: '0xYOU',            // ← makes the API return ready-to-send calldata
  slippageBps: 50,
});

// once per token: allow the Router to pull tokenIn (exact amount — or MAX_UINT256)
await wallet.sendTransaction(buildApproveTx({ chain: 'base', token: q.tokenIn, amount: amountIn }));
// then execute exactly what was quoted:
await wallet.sendTransaction(buildSwapTx(q));   // { to, data, value }
```

## Batch quotes (screeners / arb loops)

```ts
const { results } = await blaze.quoteBatch([
  { chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 10n ** 18n },
  { chain: 'base', tokenIn: 'WETH', tokenOut: 'BZPX', amountIn: 10n ** 18n },
  { chain: 'arbitrum', tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 10n ** 18n },
]); // one round-trip (max 10), per-item errors inline
```

## Deep links (bot buttons / referral posts)

```ts
import { deepLink } from '@blazephoenix/sdk';

deepLink({ chain: 'base', tokenIn: 'ETH', tokenOut: 'BZPX', amount: '0.5' });
// → https://blazephoenix.xyz/?tab=swap&chain=8453&in=ETH&out=BZPX&amt=0.5
```

## On-chain module (optional `viem` peer)

Zero middlemen — same numbers, straight from your own node. **The SDK ships no
RPC endpoints and no keys by design**: you bring your own `rpcUrl`.

```ts
import { quoteOnChain, watchFills, getFills } from '@blazephoenix/sdk';

const { preview } = await quoteOnChain({
  chain: 'base', rpcUrl: RPC,
  tokenIn: '0x4200000000000000000000000000000000000006',
  tokenOut: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amountIn: 10n ** 18n,
});

const unwatch = await watchFills({
  chain: 'base', rpcUrl: RPC,
  onFill: (f) => console.log(f.txHash, f.amountIn, '→', f.amountOut),
});
```

`getFills({ chain, rpcUrl, fromBlock, toBlock })` gives you the raw fill history —
the input for the **quoted-vs-executed verification pattern** documented on the
API page: re-run each fill's quote at its block and compare with the executed
amount the event recorded. Verify us, don't trust us.

## Errors

HTTP-level failures throw `BlazeApiError` with a stable `code`:

| code | meaning |
|---|---|
| `bad_*` (400) | invalid parameter — message names the field |
| `no_route` (422) | Quoter reverted: no executable route for this pair/size |
| `rpc_unreachable` (502) | all upstream RPCs failed — retry shortly |

## Reference

- REST endpoint: `GET https://blazephoenix.xyz/api/quote`
- Batch: `POST https://blazephoenix.xyz/api/quote/batch`
- Manifest (contracts / token / event topics): `GET https://blazephoenix.xyz/api/manifest`
- Examples: [`examples/`](examples) — plain quote, Telegram bot, fill watcher
- Protocol fee: 0.28% on quoted output; **execution surplus is fee-exempt → user**

## License

MIT — the SDK is deliberately permissive so anyone can integrate.
(The BlazePhoenix protocol and site carry their own licenses.)
