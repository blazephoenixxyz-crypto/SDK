# @blazephoenix/sdk

Official TypeScript SDK for **[BlazePhoenix](https://blazephoenix.xyz)** — the on-chain
DEX aggregator on **Base · Ethereum · Optimism · Arbitrum · Robinhood Chain**.

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

Zero middlemen — same numbers, straight from the chain. **RPC optional since
v0.4.0**: omit `rpcUrl` and the SDK falls back across public keyless endpoints
(bring your own node for production throughput). Still zero providers and zero
keys shipped — enforced by tests.

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

## Resilient by default (v0.3.0)

Every call ships the same meta-patterns the BlazePhoenix edge runs — no config:

- identical concurrent calls **coalesce into one request** (singleflight)
- preview quotes ride a **1s micro-cache** (`cacheTtlMs`; never applied to
  `recipient`/`exact` requests — execution data stays fresh, always)
- transient failures (network, 429, 502–504) **retry with backoff** and honour
  the server's `retry-after` (`retries`, default 2)

```ts
// a price loop in one line — overlap-safe, stop() when done:
import { pollQuote } from '@blazephoenix/sdk';
const stop = pollQuote(blaze,
  { chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 10n ** 18n },
  (q) => console.log('WETH→USDC', q.amountOut),
  { intervalMs: 4000 });
```

## 🔥 Phoenix Bot — zero-custody Telegram bot

[`examples/phoenix-bot.ts`](examples/phoenix-bot.ts) is a complete Telegram bot
with a difference: **it never holds a key**. It quotes on-chain truth, streams
real fills (`/watch`), and executes by deep-linking users into their OWN wallet
(they sign inside the Telegram Mini App). The famous trading bots custody your
funds; this one can't lose what it never touches.

**Commands:** `/price` · `/quote` · `/token` (shareable group call card) ·
`/hot` (most-traded tokens + 🫧 phantom-liquidity flags, from the site Radar) ·
`/chain` & `/slippage` (tappable, all 5 chains) · `/scan` (Pool X-Ray) ·
`/watch`·`/stop` · `/connect` · `/about` · `/ask` (curated, no-LLM project Q&A) ·
`/links` · `/menu` · `/stats` (owner-only usage). Every quote carries the
deterministic **Phoenix Check** verdict. Works in groups and via **inline mode**
(`@yourbot 0.5 ETH USDC` in any chat).

```bash
npm i grammy viem
BOT_TOKEN=...            # from @BotFather (keep it secret; never paste in chat)
RPC_URL=https://…        # optional — public endpoints used when unset
WHALE_MIN_USD=10000      # optional — /watch 🐋 alert threshold
METRICS_FILE=./stats.json # optional — persist /stats across restarts
ADMIN_ID=123456789       # optional — lock /stats to your Telegram id
npx tsx examples/phoenix-bot.ts
```

Enable **inline mode** in @BotFather (`/setinline`) and set the avatar
(`/setuserpic`) so the bot carries the brand. The `type QuoteChecks` import is
type-only (elided at runtime), so the example runs against any published SDK.

## Bring your own RPC (optional, v0.5.0)

Set `rpc` once on the client and every read goes through **your** node instead
of the shared pool:

```ts
const blaze = new BlazePhoenix({ rpc: process.env.MY_RPC });
// or per call:
await blaze.quote({ chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 10n ** 18n, rpc });
```

The service stays **free and keyless either way** — this exists so sustained
automation carries its own read volume, which is what keeps the free path
viable for callers who cannot bring a node. Your node is tried first and the
public pool remains the fallback, so supplying one can only make calls more
reliable, never less. `meta.rpc` in the response reads `byo` or `shared`.

Any free tier is enough. Lock the key to your domain or IP in the provider
dashboard if it will run in a browser. Full guide:
<https://blazephoenix.xyz/learn/bring-your-own-rpc>

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

## Deployed contracts (verified)

![solvency](https://img.shields.io/endpoint?url=https%3A%2F%2Fblazephoenix.xyz%2Fapi%2Fbadge)
— live `isSolvent()` read from the Base staking contract ·
[full proof-of-solvency report](https://blazephoenix.xyz/solvency)

| Chain | Contract | Address |
|---|---|---|
| Base (8453) | Router | [`0x2a779f9Be49aac57495A8B6467Cc325a8a47Eb9f`](https://basescan.org/address/0x2a779f9Be49aac57495A8B6467Cc325a8a47Eb9f) |
| Base (8453) | Quoter | [`0x4cEF0615614B212895F45Aa1D4833B16666E18d3`](https://basescan.org/address/0x4cEF0615614B212895F45Aa1D4833B16666E18d3) |
| Base (8453) | Staking | [`0x3f60C7aa0c36a78D200405feBE143d2Cf3fA0c77`](https://basescan.org/address/0x3f60C7aa0c36a78D200405feBE143d2Cf3fA0c77) |
| Base (8453) | BZPX token | [`0x23113e72165a034265Ab8Bf2277CCB7a85Cb7483`](https://basescan.org/address/0x23113e72165a034265Ab8Bf2277CCB7a85Cb7483) |
| Ethereum (1) | Router | [`0xE1aE5f49013920CF71De8CED4043e14C4d63416b`](https://etherscan.io/address/0xE1aE5f49013920CF71De8CED4043e14C4d63416b) |
| Ethereum (1) | Quoter | [`0x4a20AA0912388ff7A9221Ab6BFC224cc20Baa0c3`](https://etherscan.io/address/0x4a20AA0912388ff7A9221Ab6BFC224cc20Baa0c3) |
| Optimism (10) | Router | [`0x7262e7483ab6f0db7b8f90eC3a9de3B02Ab36F6A`](https://optimistic.etherscan.io/address/0x7262e7483ab6f0db7b8f90eC3a9de3B02Ab36F6A) |
| Optimism (10) | Quoter | [`0xfB18EF6f62A0278A273Af4b7A46b454F9E482dc2`](https://optimistic.etherscan.io/address/0xfB18EF6f62A0278A273Af4b7A46b454F9E482dc2) |
| Arbitrum (42161) | Router | [`0x7262e7483ab6f0db7b8f90eC3a9de3B02Ab36F6A`](https://arbiscan.io/address/0x7262e7483ab6f0db7b8f90eC3a9de3B02Ab36F6A) |
| Arbitrum (42161) | Quoter | [`0xfB18EF6f62A0278A273Af4b7A46b454F9E482dc2`](https://arbiscan.io/address/0xfB18EF6f62A0278A273Af4b7A46b454F9E482dc2) |

Always cross-check against the live manifest: `https://blazephoenix.xyz/api/manifest`.

## Learn the engineering

The protocol is documented from the deployed bytecode — every article ends with
a command to reproduce its claims:

- **The mathematics** (every formula; the originals are ours): https://blazephoenix.xyz/learn/the-mathematics
- **Integrate any bot** (keyless / keyed / ethers / viem / Python / AI-agent): https://blazephoenix.xyz/learn/integrate-any-bot
- **Web 2.5 vs Web 3.0** (the decision on-chain, not just settlement): https://blazephoenix.xyz/learn/web25-vs-web30
- **Machine-readable measured cases**: https://blazephoenix.xyz/measured-cases.json
- **Agent guide**: https://blazephoenix.xyz/llms.txt

## Citing BlazePhoenix

This repository ships a `CITATION.cff`, so GitHub shows a **“Cite this
repository”** button. Please cite with attribution and a link — the protocol's
original constructions (the Iron Law Φ, the Vitality Field Ψ, the
Capital-Anchored Filter, the Master Conservation Identity) are © 2026
BlazePhoenix.

## License

MIT — the SDK is deliberately permissive so anyone can integrate.
(The BlazePhoenix protocol and site carry their own licenses.)
