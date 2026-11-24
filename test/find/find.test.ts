// findToken: candidates from two indexes, read on the caller's node through an injected reader,
// ranked by measured depth. Deterministic fakes, no network (test/find/fake.ts).
// Each test names the mutant of src/find or src/text.ts that turns it red.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findToken, impactBps, reach, lookalike, skeleton, tokenText, WARNINGS, type DepthRung } from '../../src/find/index.js';
import { addr, dexPair, fakeFetch, fakeReader, USDC, WETH, type FakeToken } from './fake.js';

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
/** A venue quoting about 1 USD per whole token with `depthUsd` USD on each side of its curve. */
const venue = (n: number, kind: number, depthUsd: bigint, balUsd = depthUsd, pair = USDC) => ({
  pairAddress: addr(n), kind, pair, rt: depthUsd * E18, rp: pair === USDC ? depthUsd * E6 : (depthUsd * E18) / 3000n, balT: balUsd * E18,
  balP: pair === USDC ? balUsd * E6 : (balUsd * E18) / 3000n,
});
const tok = (symbol: string, v?: ReturnType<typeof venue>, extra: Partial<FakeToken> = {}): FakeToken => ({ symbol, name: symbol, decimals: 18, venue: v, ...extra });
const lower = (a: string) => a.toLowerCase();
/** The fake's constant-product quote, recomputed here as an oracle independent of src/find. */
const cp = (rt: bigint, rp: bigint, x: bigint) => (rp * x) / (rt + x);

// Mutant: drop the Cyrillic rows of CONFUSABLE -> impostor not suspicious and not proposed (skeleton differs).
// Mutant: matchesQuery compares tokenText instead of skeleton -> the impostor is never listed.
test('[vector] a Cyrillic impostor of the ticker is listed, flagged, and the real one is not flagged', async () => {
  const real = addr(0x1001), fake = addr(0x1002);
  const { reader } = fakeReader({ [lower(real)]: tok('PEPE', venue(0x2001, 0, 1_000_000n)), [lower(fake)]: tok('РЕРЕ', venue(0x2002, 0, 1_000n)) });
  const r = await findToken({ query: 'PEPE', chainId: 8453, reader, fetch: fakeFetch({ cg: { coins: [], details: {} }, dex: { pairs: [dexPair(real, 'PEPE'), dexPair(fake, 'РЕРЕ')] } }) });
  const imp = r.candidates.find((c) => c.address === fake)!;
  assert.ok(imp, 'impostor listed');
  assert.equal(imp.lookalike.suspicious, true);
  assert.match(imp.lookalike.symbol!.reasons.join('|'), /confusable letters: U\+0420 U\+0415 U\+0420 U\+0415 look like ASCII PEPE/);
  assert.equal(r.candidates.find((c) => c.address === real)!.lookalike.suspicious, false);
  assert.equal(r.candidates[0].address, real);
});

// Mutants: scripts.length > 2 (mixed), drop the hidden-characters check, drop the NFKC check.
test('[unit] lookalike: mixed scripts, hidden characters, compatibility forms, plain ASCII', () => {
  assert.deepEqual(lookalike('PEPЕ').scripts, ['Latin', 'Cyrillic']);
  assert.ok(lookalike('PEPЕ').reasons.includes('mixed scripts: Latin + Cyrillic'));
  assert.equal(lookalike('PE​PE').reasons[0], 'hidden characters: invisible or control characters were removed');
  assert.equal(lookalike('PE\u{E0041}PE').suspicious, true);
  assert.ok(lookalike('ＰＥＰＥ').reasons.some((x) => x.startsWith('compatibility forms')));
  assert.equal(skeleton('ＰＥＰＥ'), 'PEPE');
  assert.deepEqual(lookalike('PEPE'), { suspicious: false, reasons: [], scripts: ['Latin'], skeleton: 'PEPE' });
  assert.equal(tokenText('a‮b'), 'a b');
});

// Mutant: sameTicker counts every candidate (4) instead of those whose on-chain symbol reads as the query (3).
test('[vector] three tokens use the ticker: the DYOR warning counts them, a name-only match is not counted', async () => {
  const toks: Record<string, FakeToken> = {};
  const pairs = [];
  for (let i = 0; i < 3; i++) { const a = addr(0x3000 + i); toks[lower(a)] = tok('PEPE', venue(0x4000 + i, 0, 10_000n * BigInt(i + 1))); pairs.push(dexPair(a, 'PEPE')); }
  const other = addr(0x3009);
  toks[lower(other)] = tok('PEPE2', venue(0x4009, 0, 5_000n), { name: 'Pepe' });
  pairs.push(dexPair(other, 'PEPE2', 'Pepe'));
  const r = await findToken({ query: 'pepe', chainId: 8453, reader: fakeReader(toks).reader, fetch: fakeFetch({ cg: { coins: [], details: {} }, dex: { pairs } }) });
  assert.equal(r.candidates.length, 4);
  assert.ok(r.warnings.includes(WARNINGS.dyor(3)));
  assert.equal(r.warnings[0], WARNINGS.mostLiquid);
  assert.ok(r.warnings.includes(WARNINGS.notSafety) && r.warnings.includes(WARNINGS.liquidityVsDepth) && r.warnings.includes(WARNINGS.trust));
});

// Mutant: sort by liquidity.totalUsd instead of depth -> the concentrated venue ranks first.
// Mutant: reverse the comparator -> the shallow one first. Mutant: label on every candidate.
test('[vector] concentrated venue out of range: high liquidity, low depth, ranked below the deeper token', async () => {
  const conc = addr(0x5001), deep = addr(0x5002);
  const cv = venue(0x6001, 1, 10_000n, 10_000_000n);
  const { reader } = fakeReader({ [lower(conc)]: tok('PEPE', cv), [lower(deep)]: tok('PEPE', venue(0x6002, 0, 1_000_000n)) });
  const r = await findToken({ query: 'PEPE', chainId: 8453, reader, fetch: fakeFetch({ cg: { coins: [], details: {} }, dex: { pairs: [dexPair(conc, 'PEPE'), dexPair(deep, 'PEPE')] } }) });
  const [first, second] = r.candidates;
  assert.equal(first.address, deep);
  assert.equal(first.label, 'most liquid');
  assert.equal(second.label, undefined);
  assert.equal(second.address, conc);
  assert.ok(second.liquidity.totalUsd! > first.liquidity.totalUsd!, 'concentrated venue holds more');
  // 10M USDC at 1, plus 10M tokens at the price measured on the smallest rung (10 USD), which the
  // curve quotes slightly below 1 USD: the probe and the rung both carry the curve's impact.
  const probe = cp(cv.rt, cv.rp, E18), a10 = (10n * E6 * E18) / probe;
  assert.equal(second.depth.rungs[0].amountIn, a10);
  assert.equal(second.liquidity.totalUsd, cv.balP + (cv.balT * cp(cv.rt, cv.rp, a10)) / a10);
  assert.equal(first.depth.upTo1pct!.usdSize, 10_000);
  assert.equal(second.depth.upTo1pct!.usdSize, 100);
  assert.equal(second.depth.upTo5pct!.usdSize, 100);
  assert.equal(second.liquidity.complete, true);
});

// Mutant: fromCoinGecko returns ok:true on a thrown search -> source failure hidden.
test('[vector] one index down: listed with its error, the other still proposes', async () => {
  const a = addr(0x7001);
  const r = await findToken({ query: 'PEPE', chainId: 8453, reader: fakeReader({ [lower(a)]: tok('PEPE', venue(0x7101, 0, 1000n)) }).reader, fetch: fakeFetch({ cg: 'down', dex: { pairs: [dexPair(a, 'PEPE')] } }) });
  assert.deepEqual(r.sources[0], { name: 'coingecko', ok: false, error: 'getaddrinfo ENOTFOUND api.coingecko.com' });
  assert.deepEqual(r.sources[1], { name: 'dexscreener', ok: true });
  assert.equal(r.candidates.length, 1);
});

// Mutant: drop the early return on hasCode false -> usdValue is called, a depth is reported.
test('[vector] no code at the address: hasCode false, no depth pretended, nothing quoted', async () => {
  const a = addr(0x8001);
  const f = fakeReader({ [lower(a)]: tok('PEPE', venue(0x8101, 0, 1000n), { code: false }) });
  const r = await findToken({ query: 'PEPE', chainId: 8453, reader: f.reader, fetch: fakeFetch({ cg: { coins: [], details: {} }, dex: { pairs: [dexPair(a, 'PEPE')] } }) });
  const c = r.candidates[0];
  assert.equal(c.hasCode, false);
  assert.equal(c.depth.status, 'NOT_MEASURED');
  assert.equal(c.depth.reason, 'no code at this address');
  assert.equal(c.depth.upTo1pct, null);
  assert.equal(c.label, undefined);
  assert.equal(f.calls.usdValue, 0);
});

// Mutants: `>` -> `>=` in reach (100 and 500 excluded); impactBps rounded down (3333 instead of 3334).
test('[range] 1% and 5% thresholds at +-1 bps, impact rounded up', () => {
  const rung = (usdSize: number, impact: number | null): DepthRung => ({ usdSize, amountIn: BigInt(usdSize), usdOut: impact === null ? null : BigInt(usdSize), impactBps: impact });
  assert.equal(reach([rung(1, 0), rung(2, 100), rung(3, 101)], 100)!.usdSize, 2);
  assert.equal(reach([rung(1, 0), rung(2, 99), rung(3, 100)], 100)!.usdSize, 3);
  assert.equal(reach([rung(1, 0), rung(2, 500), rung(3, 501)], 500)!.usdSize, 2);
  assert.equal(reach([rung(1, 0), rung(2, null), rung(3, 0)], 500)!.usdSize, 1);
  assert.equal(impactBps(1000n, 1n, 990n, 1n), 100);
  assert.equal(impactBps(1000n, 1n, 989n, 1n), 110);
  assert.equal(impactBps(3n, 1n, 2n, 1n), 3334);
  assert.equal(impactBps(10n, 1n, 100n, 10n), 0);
});

// Mutant: amountIn scaled by dollarDecimals instead of the token's decimals -> decimals 0 and 18 red.
// Mutant: amountIn scaled by 10^18 instead of the token's decimals -> decimals 0 and 6 red.
// The venue is linear (exactly 1 USD per whole token, no impact), so the sizes are exact.
// Mutant: reach does not skip leading sizes below one base unit -> decimals 0 at 1000 USD is NOT_MEASURED.
for (const decimals of [0, 6, 18]) {
  test(`[range] decimals ${decimals}: the 10 USD size is 10 whole tokens at 1 USD`, async () => {
    const a = addr(0x9000 + decimals), u = 1_000_000_000n;
    const v = { pairAddress: addr(0x9100 + decimals), kind: 0, pair: USDC, rt: u * 10n ** BigInt(decimals), rp: u * E6, balT: 0n, balP: 0n, linear: true };
    const r = await findToken({ query: 'PEPE', chainId: 8453, sizes: [10, 100], reader: fakeReader({ [lower(a)]: { symbol: 'PEPE', name: 'Pepe', decimals, venue: v } }).reader, fetch: fakeFetch({ cg: { coins: [], details: {} }, dex: { pairs: [dexPair(a, 'PEPE')] } }) });
    assert.equal(r.candidates[0].depth.rungs[0].amountIn, 10n * 10n ** BigInt(decimals));
  });
}
test('[range] decimals 0 at 1000 USD per token: sizes below one base unit are skipped, depth still measured', async () => {
  const a = addr(0x9201);
  const v = { pairAddress: addr(0x9202), kind: 0, pair: USDC, rt: 1_000_000n, rp: 1_000_000n * 1000n * E6, balT: 0n, balP: 0n };
  const r = await findToken({ query: 'PEPE', chainId: 8453, sizes: [10, 100, 1000, 10_000], reader: fakeReader({ [lower(a)]: { symbol: 'PEPE', name: 'Pepe', decimals: 0, venue: v } }).reader, fetch: fakeFetch({ cg: { coins: [], details: {} }, dex: { pairs: [dexPair(a, 'PEPE')] } }) });
  const d = r.candidates[0].depth;
  assert.equal(d.rungs[0].reason, 'size below one base unit');
  assert.equal(d.status, 'MEASURED');
  assert.equal(d.upTo1pct!.usdSize, 10_000);
});

// Mutant: dedupe keyed by the address as written -> two candidates for one token.
test('[vector] the same address in two cases from two indexes is one candidate with both sources', async () => {
  const a = addr(0xabcdef);
  const r = await findToken({
    query: 'PEPE', chainId: 8453, reader: fakeReader({ [lower(a)]: tok('PEPE', venue(0xa001, 0, 1000n)) }).reader,
    fetch: fakeFetch({ cg: { coins: [{ id: 'pepe', symbol: 'pepe', name: 'Pepe' }], details: { pepe: { platforms: { base: a } } } }, dex: { pairs: [dexPair(lower(a), 'PEPE')] } }),
  });
  assert.equal(r.candidates.length, 1);
  assert.deepEqual(r.candidates[0].sources.sort(), ['coingecko', 'dexscreener']);
  assert.equal(r.candidates[0].address, a);
});

// Mutant: drop 4 from V4_KINDS -> reason becomes "venue kind 4"; add 9 to BALANCE_KINDS -> the external venue is read.
test('[vector] V4 venue liquidity is NOT_MEASURED with its reason, never 0; an external kind is not read', async () => {
  const a = addr(0xb001), b = addr(0xb002);
  const f = fakeReader({ [lower(a)]: tok('PEPE', venue(0xb101, 4, 1_000_000n)), [lower(b)]: tok('PEPE', venue(0xb102, 9, 1000n)) });
  const r = await findToken({ query: 'PEPE', chainId: 8453, reader: f.reader, fetch: fakeFetch({ cg: { coins: [], details: {} }, dex: { pairs: [dexPair(a, 'PEPE'), dexPair(b, 'PEPE')] } }) });
  const v4 = r.candidates.find((c) => c.address === a)!.liquidity;
  assert.equal(v4.venues[0].status, 'NOT_MEASURED');
  assert.equal(v4.venues[0].reason, 'V4: balances sit in the shared PoolManager, not at the venue');
  assert.equal(v4.totalUsd, null);
  assert.equal(v4.complete, false);
  assert.equal(r.candidates.find((c) => c.address === b)!.liquidity.venues[0].reason, 'venue kind 9: where its balances sit is not known here');
  assert.ok(r.warnings.includes(WARNINGS.v4));
  assert.equal(f.calls.balanceOf, 0);
});

// Mutant: WETH valued at 1 instead of usdValue of one WETH -> total off by 3000x.
test('[vector] a WETH-paired venue is valued at the measured WETH price', async () => {
  const a = addr(0xc001);
  const r = await findToken({ query: 'PEPE', chainId: 8453, reader: fakeReader({ [lower(a)]: tok('PEPE', venue(0xc101, 0, 300_000n, 300_000n, WETH)) }).reader, fetch: fakeFetch({ cg: { coins: [], details: {} }, dex: { pairs: [dexPair(a, 'PEPE')] } }) });
  const total = r.candidates[0].liquidity.totalUsd!;
  assert.ok(total > 599_000n * E6 && total <= 600_000n * E6, String(total));
});

// Mutant: add a selected/best/official field anywhere in the result.
test('[vector] never selects: no selected, best or official key anywhere in the result', async () => {
  const a = addr(0xd001);
  const r = await findToken({ query: 'PEPE', chainId: 8453, reader: fakeReader({ [lower(a)]: tok('PEPE', venue(0xd101, 0, 1000n)) }).reader, fetch: fakeFetch({ cg: { coins: [], details: {} }, dex: { pairs: [dexPair(a, 'PEPE')] } }) });
  const keys: string[] = [];
  JSON.stringify(r, (k, v) => { keys.push(k); return typeof v === 'bigint' ? v.toString() : v; });
  for (const k of ['selected', 'best', 'official', 'recommended']) assert.ok(!keys.includes(k), k);
});

// Mutants: drop the sizes validation; accept an empty query; drop the rpc check.
test('[unit] bad requests throw bad_request', async () => {
  // Both indexes down, so a mutant that lets a bad request through resolves (red) without the network.
  const reader = fakeReader({}).reader, fetch = fakeFetch({});
  await assert.rejects(findToken({ query: ' \u200b ', chainId: 8453, reader, fetch }), /query/);
  await assert.rejects(findToken({ query: 'PEPE', chainId: 8453, reader, fetch, sizes: [100, 10] }), /sizes/);
  await assert.rejects(findToken({ query: 'PEPE', chainId: 8453, fetch }), /rpc: give your RPC/);
});
