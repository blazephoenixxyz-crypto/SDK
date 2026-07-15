# Changelog

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
