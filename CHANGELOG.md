# Changelog

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
