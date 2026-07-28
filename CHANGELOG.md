# Changelog

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
