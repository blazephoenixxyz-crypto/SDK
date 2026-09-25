# Changelog

## 1.0.0 — 100% your RPC

**Breaking.** The SDK no longer talks to `blazephoenix.xyz/api/quote` and ships no RPC
endpoints. Every read is an `eth_call` from your process to the node you configure —
BlazePhoenix pays for none of your reads, and none of them depends on our servers.

### What changed
- `new BlazePhoenix({ rpc })` — `rpc` is a URL, a list (your fallback order), an EIP-1193
  provider, a viem Transport, or a per-chain map of those; or the `BLAZEPHOENIX_RPC_*`
  environment variables (`rpcFromEnv`). Each node's `eth_chainId` is checked once
  (`rpc_chain_mismatch`), and a chain without a node throws `rpc_required`.
- **Versioned deployments.** `version: 'latest' | '1' | '2' | '2.0.0'` per client or per
  call. 1.0.0 is live; 2.0.0 (the final Core/Hub/Solver/Quoter/Router generation) is
  embedded as pending and reaches you through the site registry the day it is deployed —
  pinned addresses cannot be moved remotely, and every remote-sourced set is verified on
  your RPC before first use. `contracts` overrides always win; `registry: { mode: 'embedded' }`
  turns the fetch off.
- **ABIs generated from the Dex sources** (`scripts/gen-abis.mjs`, solc 0.8.36): full Core,
  Hub, Solver, Quoter and Router ABIs, every custom error decodable.
- `buildSwap` — on 2.x, `Quoter.previewAndEncode` returns the preview AND the Router
  calldata in one call; the SDK decodes and verifies every field (amount, recipient,
  deadline, route, minimum) before returning it (`calldata_mismatch` otherwise). On 1.x the
  same `swapExactIn` call is encoded locally. Default slippage 0.5%, never below the
  on-chain floor. Native ETH input (`swapExactInNative`) and `mode: 'best'`
  (`swapBestExactIn`) on 2.x. Approval step with a live allowance check when `from` is set.
- `simulate(plan, from)` and `execute({ wallet, plan })` — approve → simulate → swap →
  realised `amountOut` from the receipt, signed by YOUR WalletClient.
- `quote` accepts `amount` in human units (decimals read on your node), `quoteExact`,
  `quoteBatch` (on-chain `batchQuote` on 2.x), `getFills`/`watchFills` (+ `ExecutionProof`),
  `tokenInfo`, `solvency`, `deployments`, `verifyDeployment`, `toJSON`.
- Errors: `BlazeError` with stable codes; protocol reverts decoded to the reason in the
  contract's own source (`decodeBlazeError`).

### Migrating from 0.5.x
| 0.5.x | 1.0.0 |
|---|---|
| `new BlazePhoenix()` (our API) | `new BlazePhoenix({ rpc: { base: MY_RPC } })` |
| `q.amountOut` (string) | `q.amountOut` (bigint) — `toJSON(q)` for strings |
| `q.quote.impactBps` / `q.quote.effectiveMinOut` | `q.checks.priceImpact.bps` / `q.preview.effectiveMinOut` |
| `quote({ …, recipient })` + `buildSwapTx(q)` | `buildSwap({ …, recipient })` → `plan.steps` |
| `quoteOnChain` / `watchFills({ rpcUrl })` | `blaze.quote` / `blaze.watchFills` |
| ticker resolution (`in=TOSHI`) | pass the 0x address (the SDK never guesses a token) |
| `PUBLIC_RPCS` fallback | removed — bring your node |
| `BlazeApiError` | `BlazeError` |

## 0.5.3

### `QuoteChecks` is now exported
The Phoenix Check type that ships on every `QuoteResponse.checks` is a public
export, so consumers can type the deterministic verdict directly:

```ts
import type { QuoteChecks } from '@blazephoenix/sdk';
```

### Phoenix Bot — a complete, zero-custody Telegram bot
`examples/phoenix-bot.ts` grew from a demo into a full bot, still holding **no
keys**: all five chains with a tappable `/chain` and `/slippage`, human-readable
amounts (decimals inferred, thousands separators), the **Phoenix Check** verdict
on every quote, `/token` shareable group-call cards, `/hot` (the site Radar's
most-traded tokens with per-token **phantom-liquidity** flags), `/about` + `/ask`
(a curated, no-LLM project Q&A that never guesses), **inline mode** for group
calls, the native command menu, and an owner-gated `/stats` (self-tracked, since
Telegram exposes no usage API). Every trade still executes by deep-link into the
user's own wallet — convenience, never custody.

## 0.5.0

### Robinhood Chain (4663)
The SDK now covers all five deployments. `resolveChain` accepts `robinhood`,
`rh`, `robinhood-chain` or `4663`, and `CHAINS[4663]` carries the verified
Router, Quoter, Hub and Solver plus a keyless public RPC. One thing to note when
you wire it: the chain's dollar asset is **USDG, not USDC** — the `usdc` field
holds the chain's canonical dollar token, and a test now pins that address so it
cannot silently drift.

### Bring your own RPC (optional, everywhere)
`rpc` is accepted per request and as a client-wide default:

```ts
const blaze = new BlazePhoenix({ rpc: process.env.MY_RPC });  // once, for every call
await blaze.quote({ chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 10n ** 18n });
```

The API reads through your node instead of its shared pool. The service is free
and keyless either way and always has been — this exists so sustained
automation can carry its own read volume, which is what keeps the free path
viable for callers who cannot bring a node. Your node is tried first and the
public pool remains the fallback, so supplying one can only improve reliability.
`meta.rpc` reports `byo` or `shared`. If you run a bot, this is the single most
considerate line you can add.

### Phoenix Bot example — market context, whale alerts, wallet connect
- `/price` now prints the on-chain execution number **and** DexScreener's market
  reading (price, 24h move, liquidity, volume, pool age) side by side, labelled
  so nobody confuses a reproducible number with a third party's reading.
- `/scan` runs the phantom-liquidity X-Ray on any token: advertised depth versus
  the balances the pools actually hold.
- `/watch` prices each fill and marks the big ones 🐋 (`WHALE_MIN_USD`, default
  $10,000). If the market read is unavailable the fill still reports — we do not
  invent a number to make an alert fire.
- `/connect` opens the app as a Telegram Mini App so the user connects **there**,
  with 300+ wallets. The bot holds no keys and cannot move funds, because it
  never touches them.

## 0.4.0 — 2026-07-15

- **RPC is now optional everywhere.** `quoteOnChain` / `watchFills` / `getFills`
  work with ZERO configuration: when `rpcUrl` is omitted the SDK falls back
  across public keyless endpoints (`PUBLIC_RPCS`, exported). Bring your own
  node for production throughput. Still no providers and no keys shipped —
  enforced by tests (keyless + https-only).
- **`client.health()`** — service health + per-chain live flags, backed by the
  new `GET /api/health` (zero upstream cost server-side: poll freely).
- The API is now self-discovering: `GET /api` describes every endpoint, and
  each quote response carries `units` + `links` — a consumer that sees one
  response can bootstrap the whole integration.

## 0.3.0 — 2026-07-15

- **Resilience core, on by default** — every client call now ships the same
  meta-patterns the BlazePhoenix edge runs: identical concurrent calls share
  ONE request (singleflight), preview quotes ride a 1s micro-cache (never
  recipient/exact — the execution red line), transient failures (network,
  429, 502–504) retry with jittered backoff honouring the server's
  `retry-after`. Tune via `retries` / `cacheTtlMs`; `manifest()` caches 1h.
- **`pollQuote(client, req, onQuote, { intervalMs })`** — the heartbeat of a
  price bot in one line; overlap-safe, returns a stop function.
- **`examples/phoenix-bot.ts`** — a full Telegram bot with ZERO custody:
  quotes on-chain truth, streams real fills, and executes via deep links in
  the USER's own wallet. No private keys, ever.
- Exposed `resilientFetch` / `singleflight` for power users.

## 0.2.1 — 2026-07-14

- The single-quote endpoint now accepts **any traded token symbol** (`in=TOSHI`)
  — the API resolves unknown tickers to the deepest-liquidity token on the
  target chain and echoes the resolution back in `QuoteResponse.resolved`.
  No SDK code change needed (strings pass through); types + docs updated:
  `resolved` / `resolvedNote` fields, `TokenRef` semantics. Batch endpoint
  remains addresses/built-in symbols only (by design).

## 0.2.0 — 2026-07-14

- **`buildApproveTx({ token, chain, amount, spender? })`** — ready-to-send
  ERC-20 `approve` calldata (defaults to the chain's Router as spender).
  Completes the loop: quote → approve → `buildSwapTx` → send. Zero-dependency
  encoding, verified byte-for-byte against viem in the test suite.
- **`toBaseUnits('1.5', 18)` / `fromBaseUnits(v, 18)`** — precise string↔bigint
  amount conversion (no floats), so callers never hand-count decimals.
- **`MAX_UINT256`** — explicit opt-in constant for unlimited approvals.
- CI workflow (typecheck + build + tests on every push/PR).

## 0.1.0 — 2026-07-14

- Initial release: `BlazePhoenix` client (`quote`, `quoteBatch`, `manifest`),
  `buildSwapTx`, `deepLink`, on-chain module (`quoteOnChain`, `watchFills`,
  `getFills`) with optional viem peer, canonical v1.0.0 ABIs + event topics,
  dual ESM/CJS build, offline test suite, no bundled RPC providers or keys.
