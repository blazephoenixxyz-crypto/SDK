// findToken with on-chain discovery: the index on the caller's RPC proposes the candidates by default
// (never fetch), the pre-filter keeps the tokens within 0.1% of the deepest bridge balance, and the
// Quoter's depth orders what is kept. The chain is FakeChain (logs, Hub, Multicall3) with ERC-20
// decimals() and balanceOf() added; depth comes from fakeReader. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, encodeFunctionResult, getAddress, parseAbi, type Address, type Hex } from 'viem';
import { findToken, WARNINGS, type FindTokenRequest } from '../../src/find/index.js';
import { MemoryStore, type IndexStore } from '../../src/find/onchain/store.js';
import { floorAndQueue, measureMatches, type Queued } from '../../src/find/onchain/prefilter.js';
import { MULTICALL3 } from '../../src/find/onchain/symbols.js';
import type { UsdValue } from '../../src/usd.js';
import { FakeChain, factoryLog, v2Log, v4Log, word, type FakeChainOptions, type FakeLog, type FakeToken as ChainToken } from './fake-rpc.js';
import { dexPair, fakeFetch, fakeReader, USDC, WETH, type FakeToken } from './fake.js';

const CHAIN = 8453;
const HUB = getAddress('0x0000000000000000000000000000000000000011');
const F2 = getAddress('0x00000000000000000000000000000000000000f2');
const F3 = getAddress('0x00000000000000000000000000000000000000f3');
const tk = (n: number) => getAddress('0x' + (0xa00 + n).toString(16).padStart(40, '0'));
const pair = (n: number) => getAddress('0x' + (0x100000 + n).toString(16).padStart(40, '0'));
const lc = (s: string) => s.toLowerCase();
const E18 = 10n ** 18n, E6 = 10n ** 6n;
const MC_ABI = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }', 'function aggregate3(Call3[] calls) payable returns (Result[] returnData)']);

/** FakeChain plus decimals() and balanceOf(holder) for the tokens in `erc20`; every other subcall goes to FakeChain. */
class Erc20Chain extends FakeChain {
  constructor(o: FakeChainOptions, readonly erc20: Record<string, { decimals: number; balances: Record<string, bigint> }>) { super(o); }
  override async request(a: { method: string; params?: unknown[] }): Promise<unknown> {
    const c = a.params?.[0] as { to?: string; data?: Hex } | undefined;
    if (a.method !== 'eth_call' || lc(c?.to ?? '') !== lc(MULTICALL3)) return super.request(a);
    const calls = decodeFunctionData({ abi: MC_ABI, data: c!.data! }).args[0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[];
    const mine = (x: { target: Address; callData: Hex }) => this.erc20[lc(x.target)] && (x.callData.startsWith('0x313ce567') || x.callData.startsWith('0x70a08231'));
    const rest = calls.filter((x) => !mine(x));
    const other = rest.length
      ? decodeFunctionResult({ abi: MC_ABI, functionName: 'aggregate3', data: (await super.request({ method: 'eth_call', params: [{ to: MULTICALL3, data: encodeFunctionData({ abi: MC_ABI, functionName: 'aggregate3', args: [rest] }) }, a.params?.[1]] })) as Hex }) as readonly { success: boolean; returnData: Hex }[]
      : [];
    let j = 0;
    const res = calls.map((x) => {
      if (!mine(x)) return other[j++];
      const t = this.erc20[lc(x.target)];
      if (x.callData.startsWith('0x313ce567')) return { success: true, returnData: word(t.decimals) };
      const holder = `0x${x.callData.slice(-40)}`;
      const bal = t.balances[lc(holder)];
      return bal === undefined ? { success: false, returnData: '0x' as Hex } : { success: true, returnData: word(bal) };
    });
    return encodeFunctionResult({ abi: MC_ABI, functionName: 'aggregate3', result: res });
  }
}

/** noPair: no V2 pair (its venues come from `o.logs`); block: the V2 pair's creation block. */
interface Tok { n: number; symbol?: string; usdcBalance?: bigint; depthUsd: bigint; pairWith?: Address; noPair?: boolean; block?: number }
/** A Hub with one V2 factory F2 (counter = its pairs) and one pair per token, finalized at 900. */
function world(toks: Tok[], o: Partial<FakeChainOptions> = {}) {
  const logs: FakeLog[] = [factoryLog(HUB, F2, 0, 5)];
  const chainTokens: Record<string, ChainToken> = {
    [lc(USDC)]: { symbol: { string: 'USDC' }, name: { string: 'USD Coin' } },
    [lc(WETH)]: { symbol: { string: 'WETH' }, name: { string: 'Wrapped Ether' } },
  };
  const usdcBal: Record<string, bigint> = {};
  const readerToks: Record<string, FakeToken> = {};
  let pairs = 0;
  toks.forEach((t, i) => {
    const other = t.pairWith ?? USDC;
    const [t0, t1] = lc(tk(t.n)) < lc(other) ? [tk(t.n), other] : [other, tk(t.n)];
    if (t.noPair !== true) logs.push(v2Log(F2, t0, t1, pair(t.n), t.block ?? 100 + i, 0, ++pairs));
    chainTokens[lc(tk(t.n))] = { symbol: { string: t.symbol ?? 'PEPE' }, name: { string: t.symbol ?? 'PEPE' } };
    if (t.pairWith === undefined && t.usdcBalance !== undefined) usdcBal[lc(pair(t.n))] = t.usdcBalance;
    readerToks[lc(tk(t.n))] = { symbol: t.symbol ?? 'PEPE', name: t.symbol ?? 'PEPE', decimals: 18, venue: { pairAddress: pair(t.n), kind: 0, pair: USDC, rt: t.depthUsd * E18, rp: t.depthUsd * E6, balT: t.depthUsd * E18, balP: t.depthUsd * E6 } };
  });
  if (!chainTokens[lc(addrX)]) chainTokens[lc(addrX)] = { symbol: { string: 'X' }, name: { string: 'X' } };
  const chain = new Erc20Chain(
    { head: 1000, finalized: 900, hub: HUB, factoryCount: 1, counters: { [F2]: pairs }, bridges: [], tokens: chainTokens, ...o, logs: [...logs, ...(o.logs ?? [])] },
    { [lc(USDC)]: { decimals: 6, balances: usdcBal }, [lc(WETH)]: { decimals: 18, balances: {} } },
  );
  const inner = fakeReader(readerToks);
  const pins: { token: Address; blockHash: Hex }[] = [];
  // The index's block hash is FakeChain's: a read pinned there is the pre-filter's bridge price.
  // The dollar token answers itself (usdFromVias' identity via: usd = amountIn).
  const reader = {
    ...inner.reader,
    usdValue: async (token: Address, amountIn: bigint, blockHash?: Hex): Promise<UsdValue> => {
      if (blockHash !== undefined && blockHash === chain.hashOf(chain.finalized!)) {
        pins.push({ token, blockHash });
        const u = await inner.reader.usdValue(WETH, amountIn);
        return lc(token) === lc(USDC) ? { ...u, token, usdValue: amountIn, dollarDecimals: 6 } : u;
      }
      return inner.reader.usdValue(token, amountIn, blockHash);
    },
  };
  return { chain, reader, pins, store: new MemoryStore() as IndexStore };
}
const addrX = getAddress('0x00000000000000000000000000000000000000ee');

/** globalThis.fetch replaced by one that records and throws, for the length of `f`. */
async function noFetch<T>(f: () => Promise<T>): Promise<{ out: T; fetched: number }> {
  const real = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; throw new Error('fetch must not be called'); }) as typeof fetch;
  try { return { out: await f(), fetched }; } finally { globalThis.fetch = real; }
}
const find = (w: ReturnType<typeof world>, extra: Partial<FindTokenRequest> = {}) =>
  findToken({ query: 'PEPE', chainId: CHAIN, rpc: w.chain, reader: w.reader, store: w.store, hub: HUB, sizes: [10, 100], ...extra });

// Mutant: default sources 'both' (src/find/index.ts) -> globalThis.fetch is called.
test('[vector] default is on-chain discovery: globalThis.fetch is never called, the index proposes', async () => {
  const w = world([{ n: 1, usdcBalance: 1_000n * E6, depthUsd: 100_000n }]);
  const { out: r, fetched } = await noFetch(() => find(w));
  assert.equal(fetched, 0);
  assert.equal(r.mode, 'onchain');
  assert.deepEqual(r.sources.map((s) => [s.name, s.ok]), [['onchain', true]]);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].address, tk(1));
  assert.deepEqual(r.candidates[0].proposedBy, [`onchain:${F2}`]);
  assert.equal(r.candidates[0].prefilterUsd, 1_000n * E6);
  assert.equal(r.candidates[0].agreement, undefined);
  assert.equal(r.discovery!.complete, true);
  assert.equal(r.discovery!.matched, 1);
  assert.equal(r.candidates[0].label, 'most liquid');
  assert.ok(r.warnings.includes(WARNINGS.notEndorsed));
  assert.ok(!r.warnings.includes(WARNINGS.trust) && !r.warnings.includes(WARNINGS.thirdParties));
  assert.ok(w.pins.length > 0 && w.pins.every((p) => p.blockHash === w.chain.hashOf(900)), 'bridge price pinned to the index block');
});

// Mutant: drop the sources check -> an unknown mode runs instead of throwing.
test('[unit] an unknown sources or index mode throws bad_request; on-chain without rpc throws', async () => {
  const w = world([{ n: 1, usdcBalance: 1n, depthUsd: 1000n }]);
  await assert.rejects(find(w, { sources: 'all' as never }), (e: any) => e.code === 'bad_request' && /sources: 'onchain', 'centralized' or 'both'/.test(e.message));
  await assert.rejects(find(w, { index: 'layer2' as never }), (e: any) => e.code === 'bad_request' && /index: 'layer1' or 'full'/.test(e.message));
  await assert.rejects(findToken({ query: 'PEPE', chainId: CHAIN, reader: w.reader }), (e: any) => e.code === 'bad_request' && /rpc: give your RPC/.test(e.message));
});

// Mutant: run the index in centralized mode too -> an 'onchain' source appears.
test('[vector] centralized keeps the old behaviour: third-party sources only, no discovery, trust warnings', async () => {
  const w = world([{ n: 1, usdcBalance: 1n, depthUsd: 1000n }]);
  const r = await findToken({ sources: 'centralized', query: 'PEPE', chainId: CHAIN, reader: w.reader, sizes: [10, 100], fetch: fakeFetch({ cg: { coins: [], details: {} }, dex: { pairs: [dexPair(tk(1), 'PEPE')] } }) });
  assert.equal(r.mode, 'centralized');
  assert.equal(r.discovery, null);
  assert.deepEqual(r.sources.map((s) => s.name), ['coingecko', 'dexscreener']);
  assert.deepEqual(r.candidates[0].proposedBy, ['dexscreener']);
  assert.equal(r.candidates[0].prefilterUsd, undefined);
  assert.equal(r.candidates[0].label, 'most liquid');
  assert.ok(r.warnings.includes(WARNINGS.trust) && r.warnings.includes(WARNINGS.thirdParties));
  assert.ok(!r.warnings.includes(WARNINGS.notEndorsed));
  assert.equal(w.chain.calls.length, 0, 'no RPC request for an index');
});

// Mutant: agreement `on && off` -> `on || off` -> an onchain-only candidate reads 'both'.
test('[vector] both: agreement says who proposed each candidate', async () => {
  const w = world([{ n: 1, usdcBalance: 5_000n * E6, depthUsd: 100_000n }, { n: 2, usdcBalance: 4_000n * E6, depthUsd: 50_000n }]);
  const off = tk(9);
  const reader = { ...w.reader, erc20: async (a: Address) => (lc(a) === lc(off) ? { symbol: 'PEPE', name: 'PEPE', decimals: 18 } : w.reader.erc20(a)) };
  const r = await find(w, { sources: 'both', reader, fetch: fakeFetch({ cg: { coins: [], details: {} }, dex: { pairs: [dexPair(tk(1), 'PEPE'), dexPair(off, 'PEPE')] } }) });
  assert.equal(r.mode, 'both');
  assert.deepEqual(r.sources.map((s) => s.name), ['onchain', 'coingecko', 'dexscreener']);
  const by = (a: Address) => r.candidates.find((c) => c.address === a)!;
  assert.equal(by(tk(1)).agreement, 'both');
  assert.deepEqual(by(tk(1)).proposedBy, [`onchain:${F2}`, 'dexscreener']);
  assert.equal(by(tk(2)).agreement, 'onchain-only');
  assert.equal(by(off).agreement, 'centralized-only');
  assert.equal(by(off).prefilterUsd, undefined);
  assert.ok(r.warnings.includes(WARNINGS.notEndorsed) && r.warnings.includes(WARNINGS.thirdParties));
});

// deepest 1_000_000 base units; 1000 × 1000 = deepest stays, 999 × 1000 < deepest falls.
const floorWorld = () => world([
  { n: 1, usdcBalance: 1_000_000n, depthUsd: 100_000n },
  { n: 2, usdcBalance: 1_000n, depthUsd: 1_000n },
  { n: 3, usdcBalance: 999n, depthUsd: 1_000n },
]);

// Mutant: `m * 1000n >= deepest` -> `>` (prefilter.ts) -> the token exactly at 0.1% is dropped.
test('[range] pre-filter floor at +-1 base unit: exactly 0.1% of the deepest stays, one below is counted and left out', async () => {
  const r = await find(floorWorld());
  const got = r.candidates.map((c) => c.address);
  assert.ok(got.includes(tk(2)), 'at the floor: kept');
  assert.ok(!got.includes(tk(3)), 'one base unit below: left out');
  assert.equal(r.discovery!.belowFloor, 1);
  assert.equal(r.omitted, 0);
  assert.ok(r.warnings.includes('1 more below 0.1% of the deepest (includeDust: true lists them)'));
});

// Mutant: ignore includeDust in floorAndQueue -> the dust token is still left out.
test('[range] includeDust lists the tokens below the floor, still counted, with no left-out warning', async () => {
  const r = await find(floorWorld(), { includeDust: true });
  const dust = r.candidates.find((c) => c.address === tk(3));
  assert.ok(dust, 'listed');
  assert.equal(dust!.prefilterUsd, 999n);
  assert.equal(r.discovery!.belowFloor, 1);
  assert.ok(!r.warnings.some((x) => x.includes('below 0.1% of the deepest')));
});

// Mutant: a null measure counts as below the floor -> the unmeasured token is dropped. Mutant: M ++ U -> tk(3) cut.
test('[vector] a token with no measure (no bridge venue) is kept, in its own lane: absent is not zero', async () => {
  const toks: Tok[] = [{ n: 1, usdcBalance: 1_000_000n, depthUsd: 100_000n }, { n: 2, usdcBalance: 900_000n, depthUsd: 90_000n }, { n: 3, pairWith: addrX, depthUsd: 1_000_000n }];
  const all = await find(world(toks));
  const x = all.candidates.find((c) => c.address === tk(3));
  assert.ok(x, 'unmeasured token kept');
  assert.equal(x!.prefilterUsd, null);
  assert.equal(all.discovery!.belowFloor, 0);
  // Two lanes, measured first: the unmeasured token holds the second slot, the second measured one is cut and named.
  const cut = await find(world(toks), { maxCandidates: 2 });
  assert.deepEqual(cut.candidates.map((c) => c.address).sort(), [tk(1), tk(3)].sort(), 'interleaved with the measured ones');
  assert.equal(cut.omitted, 1);
  assert.deepEqual(cut.omittedAddresses, [tk(2)]);
});

// Mutant: floorAndQueue ignores prefilterPartial (prefilter.ts `below`) -> the partly read token is dropped as dust.
// A partial sum is a lower bound: one venue read, the other not. Below the floor it proves nothing.
test('[vector] a token whose venue reads partly failed is kept: a partial sum is not floored (absent is not zero)', async () => {
  const toks: Tok[] = [{ n: 1, usdcBalance: 1_000_000n, depthUsd: 100_000n }, { n: 3, usdcBalance: 999n, depthUsd: 1_000n }];
  // tk(3) also has a WETH venue whose balanceOf fails on the node (Erc20Chain: no WETH balance).
  const extra = v2Log(F2, tk(3), WETH, pair(33), 110, 0, 3);
  const r = await find(world(toks, { logs: [extra], counters: { [F2]: 3 } }));
  const x = r.candidates.find((c) => c.address === tk(3));
  assert.ok(x, 'kept: its unread venue may hold the depth');
  assert.equal(x!.prefilterUsd, 999n, 'the measure is still what was read');
  assert.equal(r.discovery!.belowFloor, 0);
  // Control: the same token fully read at 999 falls (see the floor test above).
  const full = await find(world(toks));
  assert.ok(!full.candidates.some((c) => c.address === tk(3)));
  assert.equal(full.discovery!.belowFloor, 1);
});

// Mutant: final order by prefilterUsd instead of the Quoter depth -> the big-balance shallow token ranks first.
test('[vector] homonym flood: 20 dust impostors left out, a big-balance shallow one does not outrank the deep token', async () => {
  const toks: Tok[] = [
    { n: 1, usdcBalance: 100_000n * E6, depthUsd: 1_000_000n },
    { n: 2, usdcBalance: 10_000_000n * E6, depthUsd: 1_000n },
    ...Array.from({ length: 20 }, (_, i): Tok => ({ n: 100 + i, usdcBalance: 1n * E6, depthUsd: 10n })),
  ];
  const r = await find(world(toks));
  assert.equal(r.discovery!.matched, 22);
  assert.equal(r.discovery!.belowFloor, 20);
  assert.deepEqual(r.candidates.map((c) => c.address), [tk(1), tk(2)]);
  assert.ok(r.candidates[1].prefilterUsd! > r.candidates[0].prefilterUsd!, 'the shallow one holds more');
  assert.equal(r.candidates[0].label, 'most liquid');
  assert.ok(r.warnings.includes('20 more below 0.1% of the deepest (includeDust: true lists them)'));
});

// Mutant: label complete always true -> 'most liquid' on a partial index.
test('[vector] partial index (maxRequests): first candidate is the most liquid of those found, with the coverage warning', async () => {
  const w = world([{ n: 1, usdcBalance: 1_000n * E6, depthUsd: 100_000n }], { factoryCount: 2, logs: [factoryLog(HUB, F3, 1, 6)] });
  const r = await find(w, { query: tk(1), maxRequests: 6 });
  assert.equal(r.discovery!.run!.stopped, 'requests');
  assert.equal(r.discovery!.complete, false);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].depth.status, 'MEASURED');
  assert.equal(r.candidates[0].label, 'most liquid of those found');
  assert.ok(r.warnings.some((x) => x.startsWith('On-chain coverage is incomplete (blocks 0..900;')));
  assert.match(r.sources[0].note ?? '', /index run stopped \(requests\)/);
});

// Mutant: drop the none-found warning.
test('[vector] zero candidates on chain: the covered range is named, not found is not "does not exist"', async () => {
  const r = await find(world([{ n: 1, usdcBalance: 1n, depthUsd: 1000n }]), { query: 'NOPE' });
  assert.equal(r.candidates.length, 0);
  assert.equal(r.discovery!.complete, true);
  assert.ok(r.warnings.includes('none found in the covered range (blocks 0..900); not found is not "does not exist"'));
});

// Mutant: rethrow in fromIndex's catch -> findToken rejects.
test('[vector] an index that cannot run: source onchain ok:false with its error, no candidate, never falls back to fetch', async () => {
  const w = world([{ n: 1, usdcBalance: 1n, depthUsd: 1000n }]);
  const broken: IndexStore = { load: async () => { throw new Error('store unreadable'); }, append: async () => {} };
  const { out: r, fetched } = await noFetch(() => find(w, { store: broken }));
  assert.equal(fetched, 0);
  assert.deepEqual(r.sources, [{ name: 'onchain', ok: false, error: 'store unreadable' }]);
  assert.equal(r.candidates.length, 0);
  assert.equal(r.discovery, null);
  assert.equal(r.candidates.filter((c) => c.label).length, 0);
});

// ---- Tokens the pre-filter cannot measure (Uniswap V4 venues, pairs with no bridge token) ----
// The measured and the not (fully) measured share the maxCandidates slots in two interleaved lanes,
// measured first; the not-measured lane goes by the block of the token's first venue (older first:
// nobody can create a venue in the past), then proposers, then address. Every address left out is
// named in omittedAddresses, with a warning. A V4 venue's liquidity is not measured by this patch.
const PM = getAddress('0x00000000000000000000000000000000000000a4');
const REAL = 900;
const poolId = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const sorted = (a: Address, b: Address): [Address, Address] => (lc(a) < lc(b) ? [a, b] : [b, a]);
/** A V4 venue of tk(n) against USDC, initialized in `block`. */
const v4Of = (n: number, block: number) => v4Log(PM, poolId(0x4000 + n), ...sorted(tk(n), USDC), block);
/** n impostors holding $1 of USDC each in a V2 pair (blocks 100+i), lower addresses than the real token. */
const impostors = (n: number): Tok[] => Array.from({ length: n }, (_, i): Tok => ({ n: 100 + i, usdcBalance: 1n * E6, depthUsd: 10n }));
type Shape = 'v4-only' | 'v2+v4' | 'non-bridge';
/** The real token (deep, created at block 50) in one of the venue shapes the pre-filter cannot fully measure. */
function realWorld(shape: Shape, flood: Tok[], extra: Tok[] = []) {
  const real: Tok = shape === 'v4-only' ? { n: REAL, noPair: true, depthUsd: 1_000_000n }
    : shape === 'v2+v4' ? { n: REAL, usdcBalance: 500_000n, depthUsd: 1_000_000n, block: 50 }
      : { n: REAL, pairWith: addrX, depthUsd: 1_000_000n, block: 50 };
  const logs = shape === 'non-bridge' ? [] : [v4Of(REAL, 50)];
  return world([...flood, ...extra, real], { v4PoolManager: PM, logs });
}
const omittedWarning = (r: { warnings: string[] }) => r.warnings.filter((x) => x.includes('omittedAddresses'));

// Mutant: floorAndQueue concatenates the lanes (M ++ U) -> the V4-only real token is cut from n = 10.
test('[vector] V4-only real token behind 10 one-dollar impostors is read (it was cut: unmeasured queued last)', async () => {
  const r = await find(realWorld('v4-only', impostors(10)));
  assert.ok(r.candidates.some((c) => c.address === tk(REAL)), 'real token read');
  assert.equal(r.candidates[0].address, tk(REAL), 'ranked first by depth');
  assert.equal(r.omitted, 1);
  assert.equal(r.omittedAddresses.length, 1);
  assert.ok(lc(r.omittedAddresses[0]) !== lc(tk(REAL)));
});

// Mutant: omittedAddresses = [] -> the cut address is not named. Mutant: omittedNotMeasured = []. Mutant: drop the omitted warning.
test('[vector] centralized flood: 10 low-address proposals and the real one, the cut one is named with a warning', async () => {
  const w = world([...impostors(10), { n: REAL, usdcBalance: 1n, depthUsd: 1_000_000n }]);
  const pairs = [...Array.from({ length: 10 }, (_, i) => dexPair(tk(100 + i), 'PEPE')), dexPair(tk(REAL), 'PEPE')];
  const r = await findToken({ sources: 'centralized', query: 'PEPE', chainId: CHAIN, reader: w.reader, sizes: [10, 100], fetch: fakeFetch({ cg: { coins: [], details: {} }, dex: { pairs } }) });
  assert.equal(r.candidates.length, 10);
  assert.equal(r.omitted, 1);
  assert.deepEqual(r.omittedAddresses, [tk(REAL)]);
  assert.deepEqual(r.omittedNotMeasured, [tk(REAL)]);
  assert.deepEqual(omittedWarning(r), [WARNINGS.omitted(1, 1)]);
});

// Matrix: impostors n = 0..15 x real token shape {V4-only, V2+V4, non-bridge only}.
// Mutant: M ++ U -> red from n = 10 (V4-only, non-bridge). Mutant: measureMatches leaves V4 venues
// unmarked -> V2+V4 red from n = 10 (measured lowest, last). Mutant: omittedAddresses = [] -> red at n >= 10.
for (const shape of ['v4-only', 'v2+v4', 'non-bridge'] as const) for (let n = 0; n <= 15; n++) {
  test(`[range] ${shape} real token, ${n} impostors: read, every cut address named and an impostor`, async () => {
    const r = await find(realWorld(shape, impostors(n)));
    assert.ok(r.candidates.some((c) => c.address === tk(REAL)), 'real token read');
    assert.equal(r.omitted, Math.max(0, n + 1 - 10));
    assert.equal(r.omittedAddresses.length, r.omitted);
    assert.equal(new Set(r.omittedAddresses).size, r.omitted, 'no duplicate');
    const imp = new Set(impostors(n).map((t) => tk(t.n)));
    assert.ok(r.omittedAddresses.every((a) => imp.has(a)), 'only impostors are cut');
    assert.deepEqual(r.omittedNotMeasured, []);
    assert.equal(omittedWarning(r).length, r.omitted > 0 ? 1 : 0);
    assert.equal(r.discovery!.belowFloor, 0);
  });
}

// Mutant: measureMatches leaves a V4 venue unmarked, or the floor applies to a partial sum -> the real token falls below the floor.
test('[vector] V2 dust + V4 venue beside a $1M measured token: a partial measure is not floored', async () => {
  const deep: Tok = { n: 1, usdcBalance: 1_000_000n * E6, depthUsd: 10_000n };
  const r = await find(realWorld('v2+v4', [], [deep]));
  const real = r.candidates.find((c) => c.address === tk(REAL));
  assert.ok(real, 'kept: its V4 venue is not measured');
  assert.equal(real!.prefilterUsd, 500_000n, 'the measure is what the V2 pair holds');
  assert.equal(r.discovery!.belowFloor, 0);
  assert.equal(r.candidates[0].address, tk(REAL), 'ranked by depth');
});

// Mutant: the not-measured lane ordered by address (not first-venue block), or firstBlock not set -> newer low-address impostors win.
test('[vector] not-measured lane by age: 15 newer V4-only impostors with lower addresses do not push out the older real token', async () => {
  const flood: Tok[] = Array.from({ length: 15 }, (_, i): Tok => ({ n: 100 + i, noPair: true, depthUsd: 0n }));
  const w = world([...flood, { n: REAL, noPair: true, depthUsd: 1_000_000n }], {
    v4PoolManager: PM, logs: [v4Of(REAL, 50), ...flood.map((t, i) => v4Of(t.n, 100 + i))],
  });
  const r = await find(w);
  assert.ok(r.candidates.some((c) => c.address === tk(REAL)), 'older first venue: read');
  assert.equal(r.omitted, 6);
  assert.deepEqual(r.omittedNotMeasured, r.omittedAddresses);
  assert.deepEqual(r.omittedAddresses, flood.slice(9).map((t) => tk(t.n)), 'the newest are cut');
});

// Mutant: interleave starting with the not-measured lane -> the V4-only token takes the single slot.
// Mutant: drop the omitted warning.
test('[range] maxCandidates 1: the measured token is read, the not-measured one is named in omittedAddresses with a warning', async () => {
  const r = await find(realWorld('v4-only', [{ n: 1, usdcBalance: 1_000n * E6, depthUsd: 10n }]), { maxCandidates: 1 });
  assert.deepEqual(r.candidates.map((c) => c.address), [tk(1)]);
  assert.deepEqual(r.omittedAddresses, [tk(REAL)]);
  assert.deepEqual(r.omittedNotMeasured, [tk(REAL)]);
  assert.deepEqual(omittedWarning(r), [WARNINGS.omitted(1, 1)]);
});

// Mutant: no dedup in the interleave -> the partial token appears twice. Mutant: M ++ U, or the not-measured lane by address -> order differs.
test('[unit] floorAndQueue interleaves measured / not-measured, measured first, each address once', () => {
  const q = (a: number, usd: bigint | null, firstBlock: number | null, partial = false): Queued => ({ address: tk(a), proposedBy: ['x'], prefilterUsd: usd, firstBlock, ...(partial ? { prefilterPartial: true } : {}) });
  const items = [q(1, 3n, 1), q(2, 2n, 2), q(3, 1n, 20, true), q(4, null, 10), q(5, null, 5), q(6, null, null)];
  const { queue, belowFloor } = floorAndQueue(items);
  assert.deepEqual(queue.map((x) => x.address), [tk(1), tk(5), tk(2), tk(4), tk(3), tk(6)]);
  assert.equal(belowFloor, 0);
});

// Mutant: measureMatches `continue`s past a V4 / non-address venue or a pair with no bridge token without marking it -> not partial.
test('[unit] measureMatches: a V4 venue, a pair with no bridge token and a non-address venue make the token partial', async () => {
  const v = (kind: number, venue: Hex, other: Address, t: Address) => ({ source: F2, kind, venue, tokens: sorted(t, other), block: 1 });
  const m = (n: number, venue: ReturnType<typeof v>) => ({ token: tk(n), symbol: 'PEPE', name: 'PEPE', status: 'READ' as const, readAtBlock: 1, venues: [venue] });
  const matches = [m(1, v(4, poolId(1), USDC, tk(1))), m(2, v(0, pair(2), addrX, tk(2))), m(3, v(0, poolId(3), USDC, tk(3)))];
  const rpc = { request: async () => { throw new Error('no read expected'); } };
  const out = await measureMatches(matches, { rpc: rpc as never, asOfBlock: 900, blockHash: poolId(900), bridges: [USDC, WETH], balanceKinds: [0, 1, 5, 6], usdValue: async () => { throw new Error('no price expected'); } });
  assert.deepEqual([...out.partial].sort(), [tk(1), tk(2), tk(3)].map(lc).sort());
  assert.deepEqual([...out.usd.values()], [null, null, null]);
});
