# @blazephoenix/sdk

Official TypeScript SDK for **[BlazePhoenix](https://blazephoenix.xyz)** — the on-chain
DEX aggregator on **Base · Ethereum · Optimism · Arbitrum · Robinhood Chain**.

**1.x runs 100% on YOUR RPC.** Every quote is an `eth_call` from your process to your
node, against the Quoter contract that settles the swap. There is no BlazePhoenix API
in the read path, no key, and the package ships no RPC endpoints (a test enforces it).
We don't pay for your reads, and you don't depend on our servers being up.

```bash
npm i @blazephoenix/sdk viem
# or straight from GitHub (builds on install):  npm i github:blazephoenixxyz-crypto/SDK viem
```

## BlazePhoenix in one sentence

BlazePhoenix is the fully on-chain DEX aggregator — the route is computed inside the transaction that executes it — paired with an oracle-free staking engine that proves its own solvency on every transaction. V2, the generation now in development, targets Base, Optimism, Arbitrum, Robinhood Chain and further L2s and is not planned for Ethereum L1. The V1 generation deployed today runs on Base, Ethereum, Optimism, Arbitrum and Robinhood Chain.

**Swap** in the [app](https://blazephoenix.xyz/?tab=swap) · **integrate** with the [SDK](https://github.com/blazephoenixxyz-crypto/SDK) (`npm i @blazephoenix/sdk`) · **connect an agent** to the [MCP server](https://github.com/blazephoenixxyz-crypto/blazephoenix-mcp) (`https://blazephoenix.xyz/mcp`, no key)

## Reading guide by level

- **New to DeFi:** [BlazePhoenix in five minutes](https://blazephoenix.xyz/learn/blazephoenix-in-five-minutes), then [What is a DEX aggregator](https://blazephoenix.xyz/learn/what-is-a-dex-aggregator) and [How to swap tokens safely](https://blazephoenix.xyz/learn/how-to-swap-safely).
- **Comfortable with swaps:** [Anatomy of a DEX aggregator](https://blazephoenix.xyz/learn/anatomy-of-an-aggregator) and [BlazePhoenix vs the established aggregators](https://blazephoenix.xyz/learn/how-we-compare).
- **Engineers and researchers:** the [Technical Whitepaper v2.3](https://blazephoenix.xyz/whitepaper.md) (DOI [10.5281/zenodo.23084091](https://doi.org/10.5281/zenodo.23084091)), the contract source in [Blaze-Phoenix-Dex](https://github.com/blazephoenixxyz-crypto/Blaze-Phoenix-Dex) and [Blaze-Phoenix-Staking](https://github.com/blazephoenixxyz-crypto/Blaze-Phoenix-Staking), and [On-chain quoting](https://blazephoenix.xyz/learn/on-chain-quoting).
- **Models and agents:** [https://blazephoenix.xyz/llms.txt](https://blazephoenix.xyz/llms.txt) and the [reading guide](https://blazephoenix.xyz/reading-guide.md).

## Trust and verification

Each item links to the place where it can be checked. The full list is at [https://blazephoenix.xyz/trust](https://blazephoenix.xyz/trust).

- **Verified contracts:** source-verified on Sourcify and the chain explorers; every address per chain at [/api/deployments](https://blazephoenix.xyz/api/deployments).
- **Source available:** the contract source is public under the [Business Source License 1.1](https://github.com/blazephoenixxyz-crypto/Blaze-Phoenix-Dex/blob/main/LICENSE), converting to GPL-2.0-or-later on 2030-06-01.
- **Public CI:** [GitHub Actions](https://github.com/blazephoenixxyz-crypto/Blaze-Phoenix-Dex/actions) on every push, including the Certora Prover and Halmos.
- **Bug bounty:** a [public programme](https://blazephoenix.xyz/bounty) with [credited researchers](https://blazephoenix.xyz/security/researchers) and [published advisories](https://blazephoenix.xyz/security/advisories).
- **Whitepaper DOI:** [10.5281/zenodo.24372939](https://doi.org/10.5281/zenodo.24372939) (v2.3.1; v2.3 at [10.5281/zenodo.23084091](https://doi.org/10.5281/zenodo.23084091)); research papers DOI [10.5281/zenodo.24372935](https://doi.org/10.5281/zenodo.24372935); papers timestamped with [OpenTimestamps](https://blazephoenix.xyz/provenance/provenance.json).
- **Contact:** contact@blazephoenix.xyz ([security.txt](https://blazephoenix.xyz/.well-known/security.txt)); official channels at [/official](https://blazephoenix.xyz/official).
- **Audit status:** an independent external audit is scheduled before launch.

## Quote → build → execute

```ts
import { BlazePhoenix } from '@blazephoenix/sdk';

const blaze = new BlazePhoenix({
  rpc: { base: process.env.BASE_RPC_URL },   // YOUR node — any provider's free tier is enough
});

// 1) the Quoter's preview, read on your node ("amount" is human units)
const q = await blaze.quote({ chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC', amount: '1.5' });
q.amountOut;           // net output after the 0.28% fee (bigint, base units)
q.checks.verdict;      // Phoenix Check: ok | caution | danger | blocked (fails closed)
q.version;             // protocol version that answered ('1.0.0' today, '2.0.0' once deployed)

// 2) the swap transaction(s): calldata verified against the request (swap math; `simulate: true`
//    asks the Router from `from` whether it settles) + the approval step if needed
const plan = await blaze.buildSwap({
  chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC', amount: '1.5',
  recipient: me, from: me,           // `from` enables the allowance check
  slippageBps: 50,                   // default 50; never below the on-chain floor
  exact: true,                       // optional: minOut from previewPlanExact (one more eth_call)
  simulate: true,                    // optional: eth_call the swap from `from`; a revert throws not_executable
});
plan.steps;       // [approve?, swap] — { chainId, to, data, value }
plan.minOut;      // the minimum the Router will enforce for you
                  // (your userMinOut as given, when set; refused below the quote net of slippage)
plan.encodedBy;   // 'quoter' on 2.x (the Quoter's own bytes, verified) · 'sdk' on 1.x

// 3) optional: dry-run on your node, then execute with YOUR wallet
await blaze.simulate(plan, me);                    // { ok, amountOut } or the decoded revert
const res = await blaze.execute({ wallet, plan }); // approve → simulate → swap → receipt
res.amountOut;                                     // realised, from the Router's Swap event
```

The Quoter's `canExecute` is swap math: it does not see what the tokens do to the payer (a transfer tax,
a per-account cap, the payer's own balance). Whether the bytes settle is answered only by the Router's own
call from the account that will send them: `simulate(plan, from)`, `buildSwap({ simulate: true })` or
`execute`. With `simulate: true` and the approval still missing, no eth_call is made: `plan.simulation` is
`{ ok: false, error.name: 'allowance' }`; send the approval, then simulate again before the swap.

`execute` takes a viem `WalletClient`. The SDK never asks for, stores or touches a key.

## Your RPC, your way

```ts
new BlazePhoenix({ rpc: 'https://your-base-node.example/KEY' });            // one node — its own chain
new BlazePhoenix({ rpc: ['https://node-a.example', 'https://node-b.example'] }); // your fallback order
new BlazePhoenix({ rpc: window.ethereum });                                  // the user's wallet (EIP-1193)
new BlazePhoenix({ rpc: http('https://…', { batch: true }) });               // any viem Transport
new BlazePhoenix({ rpc: { base: '…', eth: ['…', '…'], arbitrum: provider } }); // per chain
new BlazePhoenix();   // reads BLAZEPHOENIX_RPC_BASE / _ETHEREUM / _OPTIMISM / _ARBITRUM / _ROBINHOOD
                      // (comma-separated for fallback) or BLAZEPHOENIX_RPC_URL
```

- Each node is asked for `eth_chainId` once. Quoting Base contracts on an Ethereum node
  throws `rpc_chain_mismatch` instead of returning garbage.
- With a single node, `chain` may be omitted: the node's own chain is used.
- A chain without a configured node throws `rpc_required` — nothing silently falls back
  to someone else's infrastructure.
- `https://` and `wss://` only (`http://` allowed for `localhost` — your anvil/geth).
  URLs are redacted in every error message and in its `cause` chain, because keys live in them.

## Versions — pick yours

Protocol versions are deployments, not SDK versions:

| version | status | what it is |
|---|---|---|
| `1.0.0` | **live** on all five chains | the generation deployed at launch |
| `2.0.0` | pending | the generation in development (Router, Solver, Hub, Quoter and Gate, with the Core and Math libraries; Balancer V2/V3 and Curve NG are reached through the Gate), targeting Base, Optimism, Arbitrum, Robinhood Chain and further L2s and not Ethereum L1, from [BlazePhoenix-Dex](https://github.com/blazephoenixxyz-crypto/Blaze-Phoenix-Dex) (`VERSION()` = `"2.0.0"`) |

```ts
new BlazePhoenix({ rpc, version: 'latest' }); // default: newest version deployed on each chain
new BlazePhoenix({ rpc, version: '1' });      // stay on 1.x
await blaze.quote({ ...req, version: '2.0.0' }); // per call
```

The SDK adapts to what each version can do (`featuresOf(version)`):

| capability | 1.x | 2.x |
|---|---|---|
| preview + Router calldata in ONE call (`previewAndEncode`) | — (encoded by the SDK) | ✅ verified field by field |
| native ETH in, no pre-wrap (`swapExactInNative`) | wrap first: `buildWrapTx` | ✅ |
| solve + execute in the same tx (`mode: 'best'` → `swapBestExactIn`) | — | ✅ |
| on-chain `batchQuote` | parallel previews | ✅ chunked |
| `ExecutionProof` on every fill (quoted vs realised vs floor) | — | ✅ |

### Only pinned addresses are routed to by default

The registry has three layers:

1. **Embedded** — shipped in the package. Non-zero addresses are **pins**: nothing fetched
   at runtime can move them, and by default they are the only Router and Quoter addresses
   a quote or a swap uses. A new deployment reaches you with a new SDK release.
2. **Remote** — `GET https://blazephoenix.xyz/api/deployments` (static JSON, refreshed every
   10 min in the background; the first lookup waits at most 3 s). It can only fill what the
   snapshot doesn't know — e.g. the 2.0.0 addresses the day they are deployed — and only for
   versions that can be verified on-chain (2.x+). Those versions are listed, but routed to
   only with `registry: { remoteVersions: true }`: the on-chain check reads the entry's own
   contracts, so it cannot tell a real deployment from a look-alike. With the opt-in, every
   remote-sourced set is still **verified on your RPC before first use**:
   code at every address, `VERSION()` matches, and the Quoter, Router and Solver all point at
   the same Hub and Solver. Anything else fails closed (`deployment_unverified`).
3. **Your overrides** — always win:

```ts
new BlazePhoenix({
  rpc,
  contracts: { base: { router: '0x…', quoter: '0x…', version: '2.0.0' } }, // your fork / audit target
  registry: { mode: 'embedded' },   // never touch the network for addresses
});
await blaze.deployments();          // the chains × versions table this client sees
await blaze.verifyDeployment({ chain: 'base' }); // run the on-chain checks yourself
```

## Why the calldata can be trusted

On 2.x, `Quoter.previewAndEncode` returns the preview **and** the exact `swapExactIn` bytes that
execute it. The Quoter's own source says what that is worth — *"a compromised Quoter fools the
interface"* — so the SDK never forwards those bytes blind. It decodes them with the Router ABI
and refuses (`calldata_mismatch`) unless the amount, recipient, deadline, the route
(identical to the previewed one, connecting tokenIn → tokenOut) and a minimum at least the
on-chain floor all match what you asked. Your slippage then only ever **tightens** that minimum.

## More

```ts
await blaze.quoteExact(req);          // previewPlanExact: every concentrated leg dry-run on its venue.
                                      // `exactOut` is net of the protocol fee on every Quoter; `quoterOut` is the
                                      // scalar exactly as the Quoter returned it (gross of the fee on a 1.x Quoter)
await blaze.quoteBatch([req1, req2]); // per-item { ok, quote } | { ok:false, error }
await blaze.getFills({ chain: 'base', lookbackBlocks: 5_000n }); // Swap (+ ExecutionProof on 2.x)
const stop = await blaze.watchFills({ chain: 'base', onFill: console.log });
await blaze.tokenInfo('base', '0x…');  // symbol / name / decimals
await blaze.solvency();                // staking proof-of-solvency; `not_deployed` where no engine is registered
toJSON(quote);                         // bigint → string, for HTTP / queues / LLMs
```

Pure helpers (no RPC): `buildApproveTx`, `buildWrapTx`, `buildUnwrapTx`, `permit2TypedData`,
`encodeSwapExactInWithPermit2`, `encodeSwapExactIn`, `encodeSwapExactInNative`, `encodeSwapBestExactIn`,
`decodeSwapExactIn`, `verifySwapExactIn`, `tightenMinOut`, `minOutFor`, `phoenixCheck`,
`decodeBlazeError`, `toBaseUnits`, `fromBaseUnits`, `deepLink`, `usdFromVias`.

Tokens: `0x` addresses, or the universal symbols `ETH` (native), `WETH`, `USDC` (the chain's
dollar asset — USDG on Robinhood), `BZPX`. Anything else: pass the address. The SDK never
guesses a token from a ticker.

## USD value

```ts
const v = await blaze.usdValue({ chain: 'base', token: '0x…', amountIn: 10n ** 18n });
// v.label 'USD (via USDC)', v.usdValue (dollar-token base units), v.usd, v.unitPrice, v.vias, v.spread,
// v.blockNumber, v.rpc.requests (1 to 4)
```

The USD value of an amount, read on the Quoter only: no oracle, no price API. The dollar token
(`USDC`; `USDG` on Robinhood Chain) is taken as 1 USD, hence the label `USD (via USDC)`.

- **The amount matters.** Each number is the `netOut` the Quoter answers for that amount, after
  the 0.28% fee and including price impact, so 10 tokens and 10,000 tokens can price differently.
- **Vias.** The direct quote to the dollar token; via WETH (token → WETH for the amount, then 1 WETH
  → dollar token, scaled); and via each token the direct route touches (token → X for the amount,
  then the route's own amount of X, `refX`, → dollar token, scaled), up to 8 vias. A scaled leg
  carries the impact at `refX`, not at the amount the first leg delivered; `scaledFrom` shows `refX`.
- **The value is the minimum** over the vias that measured something. `spread` (min, max, diff,
  bps) shows how far they are apart; there is no threshold and no verdict.
- **"not measured", never 0.** A via whose call reverts, whose route has 0 hops or whose `netOut` is 0
  measured nothing. If no via measured, `usdValue` is `null` and `usd` is `'not measured'`.
- **One block, pinned by hash.** The client reads the block header (`eth_getBlockByNumber`, `latest`
  or your `blockNumber`; `eth_getBlockByHash` for your `blockHash`) and runs every eth_call of
  one `usdValue` at that block's hash (EIP-1898, `requireCanonical: true`), never at a block
  number: after a reorg a number names another block. The result's `blockHash` is that hash. The
  block read inside the call must equal the header's number, and a pinned `blockNumber` or
  `blockHash` must get its own header; otherwise it is an `rpc_error`.
- **"not measured" is a result, not an error.** If the node loses the block between the calls
  (a reorg), discovery restarts on a new block, at most `USD_SNAPSHOT_TRIES` (2) snapshots. If the
  block is lost every time, or the node takes no `blockHash` block parameter, `usdValue` returns
  `'not measured'` (`usdValue`, `blockNumber`, `dollarDecimals` and `tokenDecimals` `null`, no vias)
  instead of throwing, and never falls back to a read by number. `usdNotMeasured` builds it.
- **1 to 4 eth_calls.** One `Multicall3.aggregate3` eth_call reads the block number, the
  decimals and every quote; a second one, at the same block hash, runs only when the direct
  route touches more tokens; a restart repeats both. `rpc.requests` counts these eth_calls (a
  failed one included), not the header reads: the client's own setup
  can add requests the first time a chain is used (`eth_chainId` once per node, and the on-chain
  check of a deployment taken from the remote registry). On Arbitrum and Robinhood Chain the block
  number is read from ArbSys (`arbBlockNumber()`), because `block.number` there is the L1 block,
  not the block RPC tags count. `usdFromVias` is the same computation without RPC.

## Cross-chain quoted price

```ts
const p = await crossChainPrice({ client: blaze, chains: [
  { chain: 'base', token: '0x…', amount: '1' },          // whole tokens, converted per chain
  { chain: 'arbitrum', token: '0x…', amountIn: 10n ** 18n }, // or base units
] });
// p.chains[i].priceUsd (USD per whole token × 1e18, or null), .derivation, .impactBps,
// .impactBasis, .impactSource; p.minPriceUsd, p.maxPriceUsd, p.spreadBps, p.skewSeconds

const a = await crossChainAverage({ client: blaze, maxSkewSeconds: 120, chains: [
  { chain: 'base', token: '0x…', amountIn: 10n ** 18n, depthAmountIn: 10n ** 20n },
  { chain: 'arbitrum', token: '0x…', amountIn: 10n ** 18n, depthAmountIn: 10n ** 20n },
] });
// a.medianPriceUsd (the main value), a.depthWeightedPriceUsd, a.included, a.excluded
```

The QUOTED price of one token on several chains: `usdValue` on each chain, on each chain's own
RPC, in parallel. Every number is a price the BlazePhoenix Quoter quotes for `amountIn` at one
block; nothing here is an executed price.

- **The token is the one you name on each chain**: `ETH`, `WETH`, `USDC` or `USDG` (the SDK's own
  address on that chain) or an address. Any other symbol is refused; tokens are never matched by
  on-chain symbol or name. A token that does not exist on a chain: leave that chain out (do not
  list it); there is no fallback to another token.
- **What a price is.** The `netOut` the Quoter quotes for that size, after the 0.28 % fee and
  with the price impact at that size; the dollar token (USDC; USDG on Robinhood Chain) is taken
  as 1 USD; the minimum over the vias `usdValue` tries (direct, via WETH, via the route's
  tokens). Read on your RPC; no volume is read.
- **The size: `amountIn` or `amount`, exactly one.** `amountIn` is in base units of the token on
  that chain. `amount` is a decimal string in whole tokens (`'1'`, `'0.5'`), converted on each
  chain with the `decimals()` read on that chain, so every chain quotes the same economic size
  (the conversion is checked against the decimals read in the pinned block). Both or neither
  throws `bad_request`; more fraction digits than the token has, or a `decimals()` that fails,
  makes that chain `'not_measured'` with its reason, nothing quoted. `depthAmountIn` /
  `depthAmount` work the same way.
- **Integers, rounded down.** A price is USD per whole token × 1e18 (`USD_E18`),
  `usdValue · 10^tokenDecimals · 1e18 / (amountIn · 10^dollarDecimals)`; `formatQuotedUsd`
  formats it. A chain that measured nothing, or a price below 1e-18 USD, is `'not_measured'` with
  its reason, never 0. A malformed request (unknown symbol, a chain twice, no client) throws.
- **Median first.** `medianPriceUsd` is the median of the included chains (two middle prices:
  their mean, rounded down). `spreadBps = (max − min) · 10000 / min` and `skewSeconds` (newest −
  oldest block timestamp) are `null` with fewer than two chains; with no chain measured the status
  is `'not_measured'` and there is no number. `maxSkewSeconds` excludes a chain whose block is
  older than the newest measured block by more than that, and says so in `excluded`.
- **Weighted by depth.** `depthWeightedPriceUsd = Σ Dᵢ·pᵢ / Σ Dᵢ`, where each chain also quotes
  `depthAmountIn` in the same block and `Dᵢ = (a₂ − a₁) · p₁ · p₂ / ((p₁ − p₂) · 10^decimals)`:
  for a constant-product curve 1/p is affine in the order size, and D is the USD depth the two
  quotes measure (less impact between the sizes → more weight; no threshold). The sum is exact
  in fractions, rounded down once. If a chain's second price is not below its first, its depth is
  not measured: `depthWeightedPriceUsd` is `null`, `depthWeightedReason` names the chain, and the
  median stands.
- **Derivation.** Each chain's `derivation` is taken from `usdValue`, not recomputed: `path`, the
  via whose value is the minimum (`'TOKEN → WETH → USDC'`; SDK constants by symbol, other tokens
  by address); its `legs` (`amountIn → netOut` in base units, the leg's `impactBps`, the route's
  `hops` with each venue's address, `kind`, `amountIn` and `out`, and the `bridges` between hops);
  `scaledFrom` when the second leg was scaled from a reference amount of the middle token; and
  `vias`, every via tried with its status, value and reason.
- **Impact.** `impactBps` is the Quoter's `Route.expectedImpactBps` for the first leg of that via
  (the leg quoted at `amountIn`), from the same `previewPlan` answer as the price: no extra RPC.
  The Solver computes `expectedImpactBps` as the mean of its legs' impacts weighted by each leg's
  amount, not compounded across hops. `impactSource` is `'quoter'`. `impactBasis` is
  `'measured'` when every venue of that route has a kind the Quoter reads reserves or
  concentrated liquidity for, and `'modeled'` when any venue has another kind (V4, V4-native,
  external wrapper): the Quoter then uses a constant default impact for it, the number is kept,
  and `impactNote` names those venues. When the chain is not measured, or the token is the
  dollar token itself (nothing is quoted), `impactBps`, `impactBasis` and `impactSource` are
  `null` and `impactNote` says why; never 0. The second size is quoted under the first quote's
  block hash (`usdValue({ blockHash })`), not its height: after a reorg that replaced that block,
  or from another block, the second size is not measured either: no price, no impact.
- `aggregateQuotedPrices` is the same aggregation without RPC; `quotedUnitPriceUsd` is the price
  of one reading; `wholeToBase` converts whole tokens to base units; `impactKindMeasured(kind)`
  is the Quoter's kind table. `usdValue` now also returns `blockTimestamp`, from the header whose
  hash pinned the reads, and `blockHash`, that hash; `usdValue({ blockHash })` reads the block
  with that hash or throws `rpc_error`. Each `UsdLeg` carries the Quoter's `impactBps` and
  `route` (additive fields).

## Find a token by name

```ts
import { findToken } from '@blazephoenix/sdk/find';

const r = await findToken({ query: 'PEPE', chainId: 8453, rpc: 'https://your-node.example' });
// r.candidates: address, rank, label ('most liquid' on the first only), proposedBy, hasCode,
// symbol / name / decimals read on your RPC, lookalike, depth, liquidity (and xray, when asked)
// r.mode: 'onchain' (the default); r.discovery: the index's block, coverage per source, complete
// r.sources: [{ name: 'onchain', ok, error? }]; r.warnings; r.basis
```

Candidates for a name or ticker, found on chain and ranked by the depth your RPC measures. It
never picks one: the result has no `selected` or `best` field, and the choice stays with you.

- **Found on chain, by default.** The candidates come from an index of the venues that the
  Hub's admitted factories created, built from their creation events on your RPC, and matched
  against the symbols and names read there. No third party sees the query: `fetch` is never
  called. Layer 1 covers every small source from block 0 and the recent 7-day window of the
  large ones (more than 250,000 creation events); later calls only walk up.
  `index: 'full'` also takes the large sources down to block 0. The index lives in `store`
  (in memory by default; `FileStore` keeps it on disk). A store holds one Hub's index per chain:
  a run refuses a store with another Hub's cursor. One writer per directory and chain: runs in one
  process wait for each other on any `FileStore` with the same `dir` string (compared as written,
  trailing slashes removed: `./idx` and an absolute path to it are two locks), but two processes must not
  update one directory at once. A custom `IndexStore` must make each `append`
  call atomic (all its operations stored or none). `indexStatus` uses the default `smallMax`
  unless you pass the one the index was built with. `r.discovery` says what was covered:
  the block, each source's range and its count against the on-chain counter, and whether the
  index is complete. When it is not, the first label reads "most liquid of those found"; not
  found in the covered range is not "does not exist". An index that fails is listed in
  `sources` with its error and gives no candidates; it never falls back to a third party.
- **Trust point: your RPC. Found on chain is not endorsed.** Anyone can create a venue: a match
  only says that a venue from an admitted factory pairs the token. Before the depth ladder, matches are ranked by what their
  venues hold in the bridge tokens (WETH, USDC) in the index's block; those under 0.1% of the
  deepest are counted in the warnings and left out (`includeDust: true` lists them, still within
  `maxCandidates`: if `omitted` is above 0, raise `maxCandidates` to see the rest). That
  measure, `prefilterUsd`, is a lower bound: venues paired with other tokens, venues whose
  balances do not sit at their address, and unread balances add nothing.
  Everything shown about a candidate (code, symbol, name, decimals, depth, balances) is read on
  your RPC.
- **Centralized search: opt-in only.** `sources: 'centralized'` asks the CoinGecko and
  Dexscreener public search instead, without keys; `sources: 'both'` asks both and gives each
  candidate an `agreement`. Those indexes then see the query and become a trust point: they
  only propose, and can miss a token, list an impostor, or be down. A failed index is listed in
  `sources` with its error, and the result does not pretend to be complete. `fetch` is
  injectable.
- **"Most liquid" is not "official".** The label on the first candidate says it has the deepest
  measured depth; no list here is official. Impostors copy tickers: the warnings count how many
  candidates read as the ticker, and `lookalike` flags hidden characters, mixed scripts,
  letters from other scripts that look like ASCII, and compatibility forms.
- **Depth.** `usdValue` at each order size (`sizes`, whole USD, default 10 to 1,000,000):
  `upTo1pct` and `upTo5pct` are the largest sizes whose impact, against the smallest size and
  rounded up, stays within 1% and 5%. The ladder makes this a lower bound: "sells up to N before
  1% impact". Ranking uses `upTo1pct`.
- **Liquidity is not depth.** `liquidity` is the token balances the venues on the measured route
  hold, valued at the measured price (the candidate at its smallest measured size, the dollar
  token at 1, WETH at the `usdValue` of one WETH). In concentrated venues (V3, V4) much of it can
  sit outside the current price range: high liquidity with low depth is possible.
- **NOT_MEASURED, never 0.** A Uniswap V4 venue keeps its balances in the shared PoolManager, not
  at the venue, so its liquidity is `NOT_MEASURED` with that reason. So is any venue kind whose
  balances are not known to sit at its address, and any token that is neither the candidate, the
  dollar token nor WETH. No code at an address: `hasCode: false` and no depth is quoted.
- **Liquidity is not safety.** It can be withdrawn at any time. Pass `xray: { transport }` to run
  the X-Ray on each candidate with code (off by default).

## Errors

Every failed node read inside a client method, `solvency()` and `watchFills`' `onError` included, is a
`BlazeError` with a stable `code`; protocol reverts carry `revert`. Outside that guarantee: an error your own
wallet throws in `execute` (`getChainId`, `sendTransaction`) reaches you as the wallet threw it, and the
standalone helpers (`toBaseUnits`, `buildApproveTx`, …) can throw a plain `Error` on malformed input.
The enumerated protocol errors (`RouterE` / `QuoterE` / `SolverE` / `HubE` /
`GateE` / `AdapterE`) and `Panic` decode to a numeric `revert.code` and the reason from the contract's own
source; any other custom error the Dex declares decodes by name with no `code` (its arguments are data,
not codes), and an `Error(string)` keeps its text, cleaned:

| code | meaning |
|---|---|
| `rpc_required` | no node configured for that chain |
| `rpc_chain_mismatch` | the node serves a different chain |
| `rpc_error` | your node failed (network, rate limit). If waiting for the receipt of a transaction `execute` already sent fails, `details.hash` / `details.approvalHash` name it |
| `bad_chain` | the chain is not one the SDK supports (name or id) |
| `no_route` | the Solver found no executable path (`SolverE(5)`) or the quote reverted |
| `not_executable` | the Quoter's swap math says the route cannot execute now (`canExecute = false`), or, with `simulate: true`, the Router's eth_call from `from` reverts |
| `calldata_mismatch` | Quoter bytes did not match your request — refused |
| `min_implausible` | `buildSwap`: `userMinOut` below the quote net of `slippageBps` (or the on-chain floor) |
| `min_above_exact` | `buildSwap({ exact: true })`: `userMinOut` above `exactOut` less the 50 bps safety margin |
| `deployment_unverified` | a registry deployment failed on-chain verification |
| `unsupported_by_version` | e.g. native ETH input on a 1.x Router |
| `not_deployed` / `bad_request` / `wallet_chain_mismatch` / `reverted` | as named |

## MCP (AI agents)

[`@blazephoenix/mcp`](https://github.com/blazephoenixxyz-crypto/blazephoenix-mcp) wraps this SDK as
a local MCP server — the agent's tools run on your machine, on your RPC.

For agents, [`llms.txt`](llms.txt) describes this package in the [llmstxt.org](https://llmstxt.org) format.

## Examples

[`examples/`](examples): `quote.ts`, `watch-fills.ts`, `telegram-bot.ts`, and
[`phoenix-bot.ts`](examples/phoenix-bot.ts) — a complete zero-custody Telegram bot on your own nodes.

## Regenerating the ABIs

The protocol ABIs are compiled from the Solidity sources, never written by hand:

```bash
npm i --no-save solc@0.8.36 && npm run gen:abis   # expects ../Blaze-Phoenix-Dex
```

## License

MIT — deliberately permissive so anyone can integrate. The protocol contracts are BUSL-1.1.
