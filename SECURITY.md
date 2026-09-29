# Security Policy

**Please do not open a public issue for security reports.**

Report privately to **contact@blazephoenix.xyz**. Include the affected contract,
endpoint or package, a minimal proof of concept or the exact conditions to
reproduce, and your assessment of severity. We aim to acknowledge a report within
72 hours.

## Scope

Six surfaces are in scope. The campaign page,
[blazephoenix.xyz/bounty](https://blazephoenix.xyz/bounty), carries the same list
and the reporting window.

| Surface | What is covered | Hunt for | Source |
|---|---|---|---|
| DEX aggregator | Router, Solver, Hub, Quoter and Core: the deployed contracts and the release that launches after the campaign. `GET /api/deployments` is the authoritative list of what is deployed. | A quote diverging from execution; the Iron-Law floor bypassed; route weight sourced from self-reported pool state; a hostile hook reaching a user's swap. | [Blaze-Phoenix-Dex](https://github.com/blazephoenixxyz-crypto/Blaze-Phoenix-Dex) |
| Staking engine | `BlazePhoenixStaking` and `BlazePhoenixMathLib`, published ahead of launch so they can be broken first. | Insolvency reachable, or value paid to the wrong party even while the conservation guard balances. | [Blaze-Phoenix-Staking](https://github.com/blazephoenixxyz-crypto/Blaze-Phoenix-Staking) |
| Public API | `/api/quote`, `/api/verify`, `/api/stats`, `/api/tape`, `/api/openapi.json` and the rest of `blazephoenix.xyz/api`. | A response that makes a caller sign a worse trade than the chain would settle; cache poisoning; injection; authorisation bypass. | [Blaze-Phoenix-API](https://github.com/blazephoenixxyz-crypto/Blaze-Phoenix-API) |
| MCP server and agent surfaces | `blazephoenix.xyz/mcp`, `/.well-known/mcp.json`, `/agents`, `llms.txt`, the machine-readable files, and the local server `@blazephoenix/mcp`. | A tool call or file that steers an AI agent into signing a harmful transaction, leaking data, or trusting forged content. | [blazephoenix-mcp](https://github.com/blazephoenixxyz-crypto/blazephoenix-mcp) |
| SDK and calldata | `@blazephoenix/sdk`, and the route and calldata the API, MCP server and front end hand to integrators. | Calldata that encodes a different recipient, token, amount or minimum than the caller asked for. | [SDK](https://github.com/blazephoenixxyz-crypto/SDK) |
| Website | `blazephoenix.xyz`: the swap, staking and API tabs. | The interface showing one trade and asking the wallet to sign another; stored or reflected XSS with impact. | none published |

## Out of scope

- Third-party code: pools, tokens, bridges, wallets, RPC providers, Cloudflare, GitHub, unless our code consumes them unsafely.
- Limits the whitepaper already states and bounds (for example the ≈2.7 % sandwich cap on a 1 %-of-depth trade, or quote staleness under your signed minimum), unless you beat the stated bound.
- Anything already in `/security/advisories` or a Hall of Fame register: a finding that is already fixed and published.
- Price movement, MEV and front-running that settle at or above the minimum the user signed.
- Attacks that need a compromised private key, admin key, or the victim's own device.
- Volumetric DoS, load testing, spam, and rate-limit exhaustion of the free public API.
- Missing headers or cookie flags, SPF/DKIM/DMARC, clickjacking, CSRF, and CORS on public read-only endpoints, without demonstrated impact.
- Self-XSS, tab-nabbing, open redirects and text injection without impact.
- Outdated dependencies or versions without a working exploit.
- Gas optimisations, style, best-practice and informational notes.
- Theoretical reports without a proof of concept, and unverified AI-generated reports.
- Display glitches (stale figures, layout) that cannot change what a user signs.
- Social engineering, phishing and physical attacks.

## Testing rules

- **Contracts.** Test on a fork. Every contract is deterministic and forkable. Do
  not test against other users' funds on mainnet.
- **API, MCP endpoint and website.** Test only against `blazephoenix.xyz`, or
  against your own local run of the published source. Do not test other hostnames,
  or the infrastructure and third-party services behind them.
- **SDK and local MCP server.** They run entirely on your own RPC. Test them locally.
- **No volumetric testing.** No denial-of-service, load testing, spam or
  rate-limit exhaustion of the public API.
- **Stop at proof of concept.** Show the issue with the minimum needed; do not
  extract value or read data beyond it.
- **Disclosure.** Do not disclose before a fix. A report that tests against other
  users' funds on mainnet, or discloses before a fix, is disqualified.

## Awards, safe harbour and recognition

Awards, the duplicate-report rule, the safe-harbour terms and the recognition policy
are in
[Blaze-Phoenix-Dex `SECURITY.md`](https://github.com/blazephoenixxyz-crypto/Blaze-Phoenix-Dex/blob/main/SECURITY.md).
The reporting window is on the campaign page,
[blazephoenix.xyz/bounty](https://blazephoenix.xyz/bounty). If you are unsure
whether something is in bounds, ask first at the address above.
