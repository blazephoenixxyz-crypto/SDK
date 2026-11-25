// findToken with on-chain discovery: the index on the caller's RPC proposes the candidates by default
// (never fetch), the pre-filter keeps the tokens within 0.1% of the deepest bridge balance, and the
// Quoter's depth orders what is kept. The chain is FakeChain (logs, Hub, Multicall3) with ERC-20
// decimals() and balanceOf() added; depth comes from fakeReader. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, encodeFunctionResult, getAddress, parseAbi, type Address, type Hex } from 'viem';
import { findToken, WARNINGS, type FindTokenRequest } from '../../src/find/index.js';
import { MemoryStore, type IndexStore } from '../../src/find/onchain/store.js';
import { MULTICALL3 } from '../../src/find/onchain/symbols.js';
import type { UsdValue } from '../../src/usd.js';
import { FakeChain, factoryLog, v2Log, word, type FakeChainOptions, type FakeLog, type FakeToken as ChainToken } from './fake-rpc.js';
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

interface Tok { n: number; symbol?: string; usdcBalance?: bigint; depthUsd: bigint; pairWith?: Address }
/** A Hub with one V2 factory F2 (counter = its pairs) and one pair per token, finalized at 900. */
function world(toks: Tok[], o: Partial<FakeChainOptions> = {}) {
  const logs: FakeLog[] = [factoryLog(HUB, F2, 0, 5)];
  const chainTokens: Record<string, ChainToken> = {
    [lc(USDC)]: { symbol: { string: 'USDC' }, name: { string: 'USD Coin' } },
    [lc(WETH)]: { symbol: { string: 'WETH' }, name: { string: 'Wrapped Ether' } },
  };
  const usdcBal: Record<string, bigint> = {};
  const readerToks: Record<string, FakeToken> = {};
  toks.forEach((t, i) => {
    const other = t.pairWith ?? USDC;
    const [t0, t1] = lc(tk(t.n)) < lc(other) ? [tk(t.n), other] : [other, tk(t.n)];
    logs.push(v2Log(F2, t0, t1, pair(t.n), 100 + i, 0, i + 1));
    chainTokens[lc(tk(t.n))] = { symbol: { string: t.symbol ?? 'PEPE' }, name: { string: t.symbol ?? 'PEPE' } };
    if (t.pairWith === undefined && t.usdcBalance !== undefined) usdcBal[lc(pair(t.n))] = t.usdcBalance;
    readerToks[lc(tk(t.n))] = { symbol: t.symbol ?? 'PEPE', name: t.symbol ?? 'PEPE', decimals: 18, venue: { pairAddress: pair(t.n), kind: 0, pair: USDC, rt: t.depthUsd * E18, rp: t.depthUsd * E6, balT: t.depthUsd * E18, balP: t.depthUsd * E6 } };
  });
  if (!chainTokens[lc(addrX)]) chainTokens[lc(addrX)] = { symbol: { string: 'X' }, name: { string: 'X' } };
  const chain = new Erc20Chain(
    { head: 1000, finalized: 900, hub: HUB, factoryCount: 1, counters: { [F2]: toks.length }, bridges: [], tokens: chainTokens, ...o, logs: [...logs, ...(o.logs ?? [])] },
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

// Mutant: a null measure counts as below the floor -> the unmeasured token is dropped.
test('[vector] a token with no measure (no bridge venue) is kept, queued last: absent is not zero', async () => {
  const toks: Tok[] = [{ n: 1, usdcBalance: 1_000_000n, depthUsd: 100_000n }, { n: 2, usdcBalance: 900_000n, depthUsd: 90_000n }, { n: 3, pairWith: addrX, depthUsd: 1_000_000n }];
  const all = await find(world(toks));
  const x = all.candidates.find((c) => c.address === tk(3));
  assert.ok(x, 'unmeasured token kept');
  assert.equal(x!.prefilterUsd, null);
  assert.equal(all.discovery!.belowFloor, 0);
  const cut = await find(world(toks), { maxCandidates: 2 });
  assert.deepEqual(cut.candidates.map((c) => c.address).sort(), [tk(1), tk(2)].sort(), 'queued after the measured ones');
  assert.equal(cut.omitted, 1);
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
