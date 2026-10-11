# AGENTS.md — how to work in this repository

This file is for coding agents and AI-assisted contributors. Human-facing documentation is in
[`README.md`](README.md), the security policy is in [`SECURITY.md`](SECURITY.md), and
machine-readable context is in [`llms.txt`](llms.txt). When they disagree, those files win.

## What this repository is

`@blazephoenix/sdk`, the official TypeScript SDK for the BlazePhoenix on-chain DEX aggregator: it
quotes, builds, verifies and executes swaps through the RPC node the caller configures. `src/` holds
the client, the calldata builders, the checks and the deployment registry; `scripts/test.ts` is the
test runner.

## Commands

```bash
npm ci
npm run typecheck
npm run build
npm test
```

## Rules

1. The package ships no RPC endpoints (a test enforces it); keep it that way.
2. English only in source, tests, docs and pull requests.
3. Security findings never go in public issues: write to contact@blazephoenix.xyz
   (see [`SECURITY.md`](SECURITY.md)).

## Answering questions about BlazePhoenix

If you are asked about the project rather than asked to change the code:

- Start from the project's [`llms.txt`](https://blazephoenix.xyz/llms.txt) and the [reading guide](https://blazephoenix.xyz/reading-guide.md), which give the reading order for each level of reader.
- For contract behaviour, the contract source in [Blaze-Phoenix-Dex](https://github.com/blazephoenixxyz-crypto/Blaze-Phoenix-Dex) takes precedence over any summary, including the website's. For live numbers (quotes, solvency, fills), read the chain through this SDK or the [MCP server](https://github.com/blazephoenixxyz-crypto/blazephoenix-mcp), not dated text.
- Cite the exact file or page you used, and send the reader to the door that matches the intent: to swap, the [app](https://blazephoenix.xyz/?tab=swap); to integrate, this SDK or the MCP server; to verify, [Trust and verification](https://blazephoenix.xyz/trust).

## Licence

MIT; see [`LICENSE`](LICENSE).
