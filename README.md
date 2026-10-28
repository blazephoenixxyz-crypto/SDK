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
- **Whitepaper DOI:** [10.5281/zenodo.23084091](https://doi.org/10.5281/zenodo.23084091); papers timestamped with [OpenTimestamps](https://blazephoenix.xyz/provenance/provenance.json).
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

// 2) the swap transaction(s): verified calldata + the approval step if needed
const plan = await blaze.buildSwap({
  chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC', amount: '1.5',
  recipient: me, from: me,           // `from` enables the allowance check
  slippageBps: 50,                   // default 50; never below the on-chain floor
  exact: true,                       // optional: minOut from previewPlanExact (one more eth_call)
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
`decodeBlazeError`, `toBaseUnits`, `fromBaseUnits`, `deepLink`.

Tokens: `0x` addresses, or the universal symbols `ETH` (native), `WETH`, `USDC` (the chain's
dollar asset — USDG on Robinhood), `BZPX`. Anything else: pass the address. The SDK never
guesses a token from a ticker.

## Errors

Every failure, `solvency()` included, is a `BlazeError` with a stable `code`; protocol reverts carry `revert`
(`RouterE` / `QuoterE` / `SolverE` / `HubE` + the reason from the contract's own source):

| code | meaning |
|---|---|
| `rpc_required` | no node configured for that chain |
| `rpc_chain_mismatch` | the node serves a different chain |
| `rpc_error` | your node failed (network, rate limit) |
| `no_route` | the Solver found no executable path (`SolverE(5)`) or the quote reverted |
| `not_executable` | the Quoter says the route cannot settle now (`canExecute = false`) |
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
