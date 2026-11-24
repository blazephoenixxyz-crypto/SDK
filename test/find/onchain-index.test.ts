// The on-chain index end to end: updateIndex, buildIndex, searchIndex and indexStatus over a chain in
// memory (test/find/fake-rpc.ts). The pieces below it (kinds, rpc, scan, store, symbols) are tested
// directly in onchain-scan.test.ts; here the subject is src/find/onchain/index.ts: the tip check and
// rollback, the grouped walks up, the walks down to the floor, small vs large and the recent window,
// Multicall3, the Hub's reads, the symbol lots, the coverage and the per-store lock.
// Oracles are the logs and answers put in the fake, never materialize's own output: an expected
// window floor is computed here from the fake's block time, an expected count from the fake's logs.
// Fresh MemoryStore per test, explicit hub, no network. Each test names the mutant that turns it red.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { buildIndex, indexStatus, searchIndex, updateIndex, type Discovery, type IndexOptions } from '../../src/find/onchain/index.js';
import { HUB_KIND } from '../../src/find/onchain/scan.js';
import { materialize, MemoryStore, type CursorOp, type IndexOp, type IndexStore } from '../../src/find/onchain/store.js';
import { MULTICALL3 } from '../../src/find/onchain/symbols.js';
import { addr, FakeChain, factoryLog, v2Log, v3Log, word, type FakeChainOptions, type FakeLog } from './fake-rpc.js';

const CHAIN = 8453;
const HUB = addr(0x11), F2 = addr(0xf2), F3 = addr(0xf3), F4 = addr(0xf4), F5 = addr(0xf5);
const ZERO = addr(0);
const tk = (n: number) => addr(0xa00 + n);
const pair = (n: number) => addr(0x100000 + n);
const lc = (s: string) => s.toLowerCase();
const MC_ABI = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'function aggregate3(Call3[] calls) payable returns (bytes)']);

/** Hub with two factories: F2 (Uniswap V2, kind 0, has a counter) and F3 (Uniswap V3, kind 1, none). */
function chain(o: Partial<FakeChainOptions> = {}): FakeChain {
  return new FakeChain({ head: 1000, finalized: 900, hub: HUB, factoryCount: 2, counters: { [F2]: 0 }, ...o, logs: [factoryLog(HUB, F2, 0, 5), factoryLog(HUB, F3, 1, 6), ...(o.logs ?? [])] });
}
const up = (c: FakeChain, store: IndexStore, o: Partial<IndexOptions> = {}) => updateIndex({ chainId: CHAIN, rpc: c, store, hub: HUB, ...o });
const build = (c: FakeChain, store: IndexStore, o: Partial<IndexOptions> = {}) => buildIndex({ chainId: CHAIN, rpc: c, store, hub: HUB, ...o });
const cov = (d: Discovery, source: Address) => d.coverage.find((x) => lc(x.source) === lc(source));
/** Logs of `source` the fake holds inside [from, to]: the oracle for a cursor's count. */
const inFake = (c: FakeChain, source: string, from: number, to: number) => c.logs.filter((l) => lc(l.address) === lc(source) && l.block >= from && l.block <= to).length;
/** The last cursor op of each source in a store. */
async function lastCursors(store: IndexStore): Promise<Map<string, CursorOp>> {
  const m = new Map<string, CursorOp>();
  for (const op of await store.load(CHAIN)) if (op.o === 'c') m.set(lc(op.source), op);
  return m;
}
/** The recent-window floor, computed from the fake's own timestamps (2 s per block unless blockTime). */
const floorFor = (target: number, secondsPerBlock: number, days = 7) => {
  const n = Math.min(100_000, target);
  return Math.max(0, target - Math.ceil((days * 86_400 * n) / (n * secondsPerBlock)));
};

/** A store whose N-th append and every one after it fail (a full disk, a crash). */
class BreakAt implements IndexStore {
  n = 0;
  readonly inner = new MemoryStore();
  constructor(readonly at: number) {}
  load(c: number) { return this.inner.load(c); }
  async append(c: number, ops: readonly IndexOp[]) {
    if (++this.n >= this.at) throw new Error('disk full');
    return this.inner.append(c, ops);
  }
}

// Mutant: index.ts `const p = (m.get(chainId) ?? Promise.resolve()).then(f, f);` -> `const p = f();` -> both runs
// load the empty store at once and the second scans everything again (3 getLogs, not 0).
test('[unit] two concurrent updateIndex on one store run one after the other: the second makes no getLogs', async () => {
  const logs = [v2Log(F2, tk(1), tk(2), pair(1), 300)];
  const a = chain({ logs, counters: { [F2]: 1 } }), b = chain({ logs, counters: { [F2]: 1 } });
  const store = new MemoryStore();
  const [da, db] = await Promise.all([up(a, store), up(b, store)]);
  assert.equal(a.count('eth_getLogs'), 3);
  assert.equal(b.count('eth_getLogs'), 0);
  assert.equal(da.complete, true);
  assert.equal(db.complete, true);
});

// Mutant: index.ts `k!.from === 0 && k!.to >= target` kept, but walk down `k.from - 1 : t.target;` -> `k.from - 1 : t.target - 1;`
// -> the target block is never scanned (toBlock 899, the venue at 900 is missing).
// Mutant: index.ts `dir: 'down', from: floor, to: top` -> `dir: 'down', from: floor + 1, to: top` -> block 0 is skipped.
// Mutant: index.ts `dir: 'up', from: to + 1,` -> `dir: 'up', from: to + 2,` -> the block after the old tip is skipped.
test('[range] the cursor reaches block 0 and the target: logs at 0 and at the target enter, target + 1 waits for the next run', async () => {
  const logs = [v2Log(F2, tk(1), tk(2), pair(1), 0), v2Log(F2, tk(3), tk(4), pair(2), 900), v2Log(F2, tk(5), tk(6), pair(3), 901)];
  const c = new FakeChain({ head: 1000, finalized: 900, hub: HUB, factoryCount: 2, counters: { [F2]: 2 }, logs: [factoryLog(HUB, F2, 0, 0), factoryLog(HUB, F3, 1, 900), ...logs] });
  const store = new MemoryStore();
  const d1 = await up(c, store);
  assert.deepEqual([cov(d1, HUB)?.fromBlock, cov(d1, HUB)?.toBlock, cov(d1, HUB)?.logs], [0, 900, 2]);
  assert.deepEqual([cov(d1, F2)?.fromBlock, cov(d1, F2)?.toBlock, cov(d1, F2)?.logs], [0, 900, 2]);
  assert.equal((await searchIndex({ chainId: CHAIN, store }, tk(1))).length, 1);
  assert.equal((await searchIndex({ chainId: CHAIN, store }, tk(3))).length, 1);
  assert.equal((await searchIndex({ chainId: CHAIN, store }, tk(5))).length, 0);
  assert.equal(d1.complete, true);
  c.finalized = 950;
  c.o.counters = { [F2]: 3 };
  const d2 = await up(c, store);
  assert.equal((await searchIndex({ chainId: CHAIN, store }, tk(5))).length, 1);
  assert.deepEqual([cov(d2, F2)?.toBlock, cov(d2, F2)?.logs], [950, 3]);
  assert.equal(d2.complete, true);
});

// Mutant: index.ts `[...(groups.get(k.to) ?? []), s]` -> `[s]` -> only the last source of a shared tip walks up (F2 stays at 900).
// Mutant: index.ts `for (const [to, group] of groups) {` -> one group per source -> 3 getLogs instead of 2.
test('[unit] warm run: sources sharing a tip walk up in one getLogs (Hub apart), and a run with nothing new makes none', async () => {
  const c = chain({ logs: [v2Log(F2, tk(1), tk(2), pair(1), 300)], counters: { [F2]: 1 } });
  const store = new MemoryStore();
  assert.equal((await up(c, store)).complete, true);
  c.finalized = 950;
  c.head = 1050;
  c.logs.push(v3Log(F3, tk(3), tk(4), pair(2), 920));
  const before = c.getLogsRanges().length;
  const d = await up(c, store);
  const calls = c.calls.filter((x) => x.method === 'eth_getLogs').slice(before).map((x) => x.params[0] as { fromBlock: string; toBlock: string; address: string | string[] });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((x) => [parseInt(x.fromBlock, 16), parseInt(x.toBlock, 16)]), [[901, 950], [901, 950]]);
  assert.equal(lc(calls[0].address as string), lc(HUB));
  assert.deepEqual((calls[1].address as string[]).map(lc).sort(), [lc(F2), lc(F3)].sort());
  assert.equal(d.complete, true);
  assert.equal(cov(d, F3)?.toBlock, 950);
  assert.equal((await searchIndex({ chainId: CHAIN, store }, tk(3))).length, 1);
  const n = c.count('eth_getLogs');
  await up(c, store);
  assert.equal(c.count('eth_getLogs'), n);
});

// Mutant: index.ts `if (cur.hash !== null && tips.get(cur.to) === lc(cur.hash)) continue;` -> `if (cur.hash !== null) continue;`
// -> the orphaned venue stays and the cursors are not rolled back (to stays 900, the new venue at 880 is never read).
// Mutant: index.ts `kept.get(keep)!, cur.large` -> `null, cur.large` -> the rolled-back cursor has no hash and the
// next stopped run rolls it back 64 blocks again (836 -> 772).
test('[vector] reorg under the tip: cursors roll back to tip - 64 with that block\'s hash, once; the orphaned venue goes, the new one enters', async () => {
  const c = chain({ logs: [v2Log(F2, tk(1), tk(2), pair(1), 800), v2Log(F2, tk(3), tk(4), pair(2), 870)], counters: { [F2]: 2 } });
  const store = new MemoryStore();
  assert.equal((await up(c, store)).complete, true);
  c.reorg(850, 'b', [v2Log(F2, tk(5), tk(6), pair(3), 880)]);
  c.finalized = 950;
  c.head = 1050;
  // Stopped right after the rollback: blockNumber, finalized, the tip, block 836.
  const d2 = await up(c, store, { maxRequests: 4 });
  assert.equal(d2.run?.stopped, 'requests');
  const k2 = await lastCursors(store);
  for (const s of [HUB, F2, F3]) assert.deepEqual([k2.get(lc(s))?.from, k2.get(lc(s))?.to, k2.get(lc(s))?.hash], [0, 836, c.hashOf(836)], s);
  const drops = (await store.load(CHAIN)).filter((x) => x.o === 'd');
  assert.deepEqual(drops.map((x) => (x as { after: number }).after), [836, 836, 836]);
  // A second stopped run does not roll back again.
  await up(c, store, { maxRequests: 4 });
  const k3 = await lastCursors(store);
  for (const s of [HUB, F2, F3]) assert.equal(k3.get(lc(s))?.to, 836, s);
  const d4 = await up(c, store);
  assert.equal(d4.complete, true);
  assert.deepEqual((await searchIndex({ chainId: CHAIN, store }, tk(3))), []);
  assert.equal((await searchIndex({ chainId: CHAIN, store }, tk(5)))[0]?.venues[0]?.block, 880);
  assert.equal((await searchIndex({ chainId: CHAIN, store }, tk(1)))[0]?.venues[0]?.block, 800);
  assert.equal(cov(d4, F2)?.logs, 2);
});

// Mutant: index.ts `if (keep < cur.from) {` -> `if (false) {` -> the cursor becomes [870, 836] with block 836's hash
// (and one more getBlock) instead of the empty cursor anchored at the target.
test('[range] a cursor shorter than the rollback depth with an unconfirmed tip becomes an empty cursor anchored at the target', async () => {
  const c = chain();
  const store = new MemoryStore();
  await store.append(CHAIN, [{ o: 'c', source: HUB, kind: HUB_KIND, from: 870, to: 900, hash: `0x${'0'.repeat(64)}`, large: false }]);
  // blockNumber, finalized, the tip, then getCode: the run stops before the Hub's walk.
  const d = await up(c, store, { maxRequests: 4 });
  assert.equal(d.run?.stopped, 'requests');
  const ops = await store.load(CHAIN);
  assert.deepEqual(ops.slice(1), [{ o: 'd', source: HUB, after: 836 }, { o: 'c', source: HUB, kind: HUB_KIND, from: 901, to: 900, hash: c.hashOf(900), large: false }]);
  assert.equal(c.count('eth_getBlockByNumber'), 2);
  const full = await up(c, store);
  assert.equal(full.complete, true);
  assert.deepEqual([cov(full, HUB)?.fromBlock, cov(full, HUB)?.logs], [0, 2]);
});

// Mutant: index.ts `const st2 = materialize(c.all);` -> `const st2 = st;` -> the walk down writes the old tip (999000) back
// over the cursor the walk up just moved to 1000000.
test('[unit] buildIndex after a new target: the walk down keeps the tip the walk up just reached', async () => {
  const c = new FakeChain({ head: 1_000_000, finalized: 999_000, hub: HUB, factoryCount: 2, counters: { [F2]: 3 }, logs: [
    factoryLog(HUB, F2, 0, 5), factoryLog(HUB, F3, 1, 6),
    v2Log(F2, tk(1), tk(2), pair(1), 100), v2Log(F2, tk(3), tk(4), pair(2), 800_000), v2Log(F2, tk(5), tk(6), pair(3), 998_000),
  ] });
  const store = new MemoryStore();
  const d1 = await up(c, store, { smallMax: 2 });
  assert.equal(cov(d1, F2)?.fromBlock, floorFor(999_000, 2));
  c.logs.push(v2Log(F2, tk(7), tk(8), pair(4), 999_500));
  c.o.counters = { [F2]: 4 };
  c.finalized = 1_000_000;
  c.head = 1_001_000;
  const d2 = await build(c, store, { smallMax: 2 });
  assert.deepEqual([cov(d2, F2)?.fromBlock, cov(d2, F2)?.toBlock, cov(d2, F2)?.logs, cov(d2, F2)?.complete], [0, 1_000_000, 4, true]);
  assert.equal(d2.complete, true);
  assert.deepEqual(d2.layer2, { pending: 0, done: 1 });
});

// Mutant: index.ts `const multicall = typeof code === 'string' && code !== '0x' && code.length > 2;` -> `const multicall = true;`
// -> no error is recorded and eth_call is sent to an address with no code.
// Mutant: index.ts `if (!multicall) return;` -> `if (false) return;` -> the symbols are tried through the missing Multicall3.
test('[vector] no Multicall3 at the target: an error in run.errors, no eth_call, tokens unread, never complete', async () => {
  const c = chain({ noMulticall: true, logs: [v2Log(F2, tk(1), tk(2), pair(1), 300)], counters: { [F2]: 1 }, tokens: { [tk(1)]: { symbol: { string: 'AAA' } } } });
  const store = new MemoryStore();
  const d = await up(c, store);
  assert.equal(c.count('eth_call'), 0);
  assert.ok(d.run?.errors.some((e) => e.includes(`Multicall3 ${MULTICALL3} has no code at block 900`)), String(d.run?.errors));
  assert.equal(d.complete, false);
  assert.deepEqual(d.tokens, { known: 2, symbolRead: 0, symbolFailed: 0, unread: 2 });
  assert.deepEqual([cov(d, F2)?.toBlock, cov(d, F2)?.logs, cov(d, F2)?.counter], [900, 1, null]);
  assert.deepEqual(d.factories, { admitted: null, seen: 2, match: false });
});

// Mutant: index.ts `const match = admitted !== null && seenF === admitted;` -> `seenF <= admitted` -> a Hub admitting 3
// factories with 2 Factory_ logs seen matches.
// Mutant: same line -> `seenF >= admitted` -> a Hub admitting 1 with 2 seen matches.
test('[range] factories match only when the Factory_ logs seen equal factoryCount(); a reverting count is absent, not zero', async () => {
  const want: [number | 'revert', number | null, boolean][] = [[1, 1, false], [2, 2, true], [3, 3, false], ['revert', null, false]];
  for (const [n, admitted, match] of want) {
    const d = await up(chain({ factoryCount: n }), new MemoryStore());
    assert.deepEqual(d.factories, { admitted, seen: 2, match }, String(n));
    assert.equal(d.complete, match, String(n));
  }
});

// Mutant: index.ts `const seenF = st.factories.size;` -> `const seenF = coverage[0]?.logs ?? 0;` -> the refreshed factory
// counts twice (2 Factory_ logs) and match is false.
// Mutant: store.ts `if (c && f.block >= c.from && f.block <= c.to) out.factories.set(` -> `if (c && f.block >= c.from && f.block <= c.to && !out.factories.has(lc(f.factory))) out.factories.set(`
// -> the first kind wins: F2 is scanned as V2 and the V3 venue is never found.
test('[vector] a factory refreshed by the Hub counts once and is scanned with the kind of its last Factory_ log', async () => {
  const c = new FakeChain({ head: 1000, finalized: 900, hub: HUB, factoryCount: 1, logs: [
    factoryLog(HUB, F2, 0, 5), factoryLog(HUB, F2, 1, 7), v3Log(F2, tk(1), tk(2), pair(1), 300), v2Log(F2, tk(3), tk(4), pair(2), 310),
  ] });
  const store = new MemoryStore();
  const d = await up(c, store);
  assert.deepEqual(d.factories, { admitted: 1, seen: 1, match: true });
  assert.equal(cov(d, HUB)?.logs, 2);
  assert.deepEqual(d.coverage.map((x) => [lc(x.source), x.kind, x.logs]), [[lc(HUB), HUB_KIND, 2], [lc(F2), 1, 1]]);
  assert.equal((await searchIndex({ chainId: CHAIN, store }, tk(1)))[0]?.venues[0]?.kind, 1);
  assert.deepEqual(await searchIndex({ chainId: CHAIN, store }, tk(3)), []);
  assert.equal(d.complete, true);
});

// Mutant: index.ts `k!.malformed === 0 && ` -> `` -> a source with a malformed log (and no counter) is complete.
test('[vector] a malformed creation log and a malformed Factory_ log are counted, the valid ones kept, and the index is not complete', async () => {
  const bad: FakeLog = { ...v3Log(F3, tk(1), tk(2), pair(1), 300, 1), topics: [v3Log(F3, tk(1), tk(2), pair(1), 300).topics[0], `0x${'f'.repeat(24)}${tk(1).slice(2)}`, v3Log(F3, tk(1), tk(2), pair(1), 300).topics[2], word(500)] };
  const badHub: FakeLog = { ...factoryLog(HUB, F4, 0, 7), data: `${word(300)}${word(0).slice(2)}` as Hex };
  const c = chain({ logs: [v3Log(F3, tk(3), tk(4), pair(2), 200), bad, badHub] });
  const store = new MemoryStore();
  const d = await up(c, store);
  assert.deepEqual([cov(d, F3)?.logs, cov(d, F3)?.malformed, cov(d, F3)?.counter, cov(d, F3)?.complete], [2, 1, null, false]);
  assert.deepEqual([cov(d, HUB)?.logs, cov(d, HUB)?.malformed, cov(d, HUB)?.complete], [3, 1, false]);
  assert.deepEqual(d.factories, { admitted: 2, seen: 2, match: true });
  assert.equal((await searchIndex({ chainId: CHAIN, store }, tk(3))).length, 1);
  assert.deepEqual(await searchIndex({ chainId: CHAIN, store }, tk(1)), []);
  assert.equal(d.complete, false);
});

// Mutant: index.ts `&& (counter === null || k!.logs === counter)` -> `` -> a node that silently drops a log gives a complete index.
test('[vector] a node that silently cuts a log: logs differ from the counter and the source is not complete', async () => {
  const logs = [v2Log(F2, tk(1), tk(2), pair(1), 100), v2Log(F2, tk(3), tk(4), pair(2), 500), v2Log(F2, tk(5), tk(6), pair(3), 800)];
  const honest = await up(chain({ logs, counters: { [F2]: 3 } }), new MemoryStore());
  assert.deepEqual([cov(honest, F2)?.logs, cov(honest, F2)?.counter, cov(honest, F2)?.complete, honest.complete], [3, 3, true, true]);
  const cut = (_lo: number, _hi: number, out: object[]) => out.filter((l) => (l as { blockNumber: string }).blockNumber !== '0x1f4');
  const d = await up(chain({ logs, counters: { [F2]: 3 }, answer: cut }), new MemoryStore());
  assert.deepEqual([cov(d, F2)?.logs, cov(d, F2)?.counter, cov(d, F2)?.complete, d.complete], [2, 3, false, false]);
});

// Mutant: index.ts `else if (x.status === 'READ') symbolRead++; else symbolFailed++;` -> `else symbolRead++;` -> failed reads count as read.
// Mutant: index.ts discovery `if (k === ZERO) continue;` -> `if (false) continue;` -> the zero address counts as an unread token.
test('[range] 0, 1 and N creation events: per-source counts, distinct tokens, read and failed symbols match the fake', async () => {
  const N = 5;
  const many = Array.from({ length: N }, (_, i) => v2Log(F2, tk(2 * i), tk(2 * i + 1), pair(i), 100 + i));
  const one = v2Log(F5, ZERO, tk(0), pair(99), 400);
  const tokens = Object.fromEntries(Array.from({ length: 2 * N }, (_, i) => [tk(i), i % 3 === 0 ? { symbol: 'revert' as const, name: 'revert' as const } : { symbol: { string: `T${i}` } }]));
  const c = new FakeChain({ head: 1000, finalized: 900, hub: HUB, factoryCount: 3, counters: { [F2]: N, [F4]: 0, [F5]: 1 }, tokens, logs: [
    factoryLog(HUB, F2, 0, 5), factoryLog(HUB, F4, 0, 6), factoryLog(HUB, F5, 0, 7), ...many, one,
  ] });
  const store = new MemoryStore();
  const d = await up(c, store);
  assert.deepEqual(d.coverage.map((x) => [lc(x.source), x.logs, x.counter, x.complete]), [[lc(HUB), 3, null, true], [lc(F2), N, N, true], [lc(F4), 0, 0, true], [lc(F5), 1, 1, true]]);
  const failed = Array.from({ length: 2 * N }, (_, i) => i).filter((i) => i % 3 === 0).length;
  assert.deepEqual(d.tokens, { known: 2 * N, symbolRead: 2 * N - failed, symbolFailed: failed, unread: 0 });
  assert.equal(d.complete, true);
  const hit = await searchIndex({ chainId: CHAIN, store }, 'T4');
  assert.deepEqual(hit.map((x) => [lc(x.token), x.symbol, x.status, x.readAtBlock]), [[lc(tk(4)), 'T4', 'READ', 900]]);
  assert.equal((await searchIndex({ chainId: CHAIN, store }, tk(0)))[0]?.venues.length, 2);
});

// Mutant: index.ts `if (n !== null && n !== undefined) return n > smallMax;` -> `return n >= smallMax;` -> a source at exactly
// 250000 is large and starts at the recent floor.
// Mutant: index.ts `export const SMALL_SOURCE_MAX = 250_000;` -> `= 2_500_000;` -> 250001 is small and scanned from block 0.
test('[range] the counter decides: 250000 is small (from block 0), 250001 is large (layer 1 is the recent window)', async () => {
  const target = 999_000, floor = floorFor(target, 2);
  const logs = [v2Log(F2, tk(1), tk(2), pair(1), floor - 1), v2Log(F2, tk(3), tk(4), pair(2), floor)];
  const opts = (n: number) => ({ head: 1_000_000, finalized: target, counters: { [F2]: n }, logs });
  const small = await up(chain(opts(250_000)), new MemoryStore());
  assert.deepEqual([cov(small, F2)?.fromBlock, cov(small, F2)?.large, cov(small, F2)?.logs], [0, false, 2]);
  assert.deepEqual(small.layer2, { pending: 0, done: 0 });
  const store = new MemoryStore();
  const large = await up(chain(opts(250_001)), store);
  assert.deepEqual([cov(large, F2)?.fromBlock, cov(large, F2)?.large, cov(large, F2)?.logs, cov(large, F2)?.complete], [floor, true, 1, false]);
  assert.deepEqual(large.layer2, { pending: 1, done: 0 });
  assert.deepEqual(await searchIndex({ chainId: CHAIN, store }, tk(1)), []);
  assert.equal((await searchIndex({ chainId: CHAIN, store }, tk(3))).length, 1);
});

// Mutant: index.ts discovery `counter > smallMax` -> `counter > SMALL_SOURCE_MAX` -> a source the run scanned from block 0
// as small (counter under the caller's smallMax, above the default) is reported large and pending in layer 2.
// Mutant: index.ts indexStatus `discovery(st, null, null, o.smallMax ?? SMALL_SOURCE_MAX)` -> `discovery(st, null, null, SMALL_SOURCE_MAX)`
// -> indexStatus with the run's smallMax disagrees with the run.
// Mutant: index.ts run `errors: c.errors }, o.smallMax ?? SMALL_SOURCE_MAX)` -> `errors: c.errors }, SMALL_SOURCE_MAX)` -> the run
// reports with the default, not the smallMax it scanned with.
test('[unit] the reported large flag uses the caller\'s smallMax: a counter above the default but under smallMax is small', async () => {
  const target = 999_000, floor = floorFor(target, 2);
  const logs = [v2Log(F2, tk(1), tk(2), pair(1), floor - 1), v2Log(F2, tk(3), tk(4), pair(2), floor)];
  const store = new MemoryStore();
  const d = await up(chain({ head: 1_000_000, finalized: target, counters: { [F2]: 300_000 }, logs }), store, { smallMax: 1_000_000 });
  assert.deepEqual([cov(d, F2)?.fromBlock, cov(d, F2)?.large, cov(d, F2)?.logs, cov(d, F2)?.counter], [0, false, 2, 300_000]);
  assert.deepEqual(d.layer2, { pending: 0, done: 0 });
  const s = await indexStatus({ chainId: CHAIN, store, smallMax: 1_000_000 });
  assert.deepEqual([cov(s, F2)?.large, s.layer2], [false, { pending: 0, done: 0 }]);
});

// Mutant: index.ts discovery `counter > smallMax` -> `counter >= smallMax` -> a counter exactly at smallMax is reported large.
test('[range] the reported large flag at a caller\'s smallMax: a counter equal to it is small, one more is large', async () => {
  const target = 999_000, floor = floorFor(target, 2);
  const logs = [v2Log(F2, tk(1), tk(2), pair(1), floor - 1), v2Log(F2, tk(3), tk(4), pair(2), floor)];
  const run = (n: number) => up(chain({ head: 1_000_000, finalized: target, counters: { [F2]: n }, logs }), new MemoryStore(), { smallMax: 1_000_000 });
  const at = await run(1_000_000);
  assert.deepEqual([cov(at, F2)?.fromBlock, cov(at, F2)?.large, at.layer2], [0, false, { pending: 0, done: 0 }]);
  const over = await run(1_000_001);
  assert.deepEqual([cov(over, F2)?.fromBlock, cov(over, F2)?.large, over.layer2], [floor, true, { pending: 1, done: 0 }]);
});

// Mutant: index.ts `const large = new Set(sources.filter(isLarge).map((s) => lc(s.address)));` -> `new Set<string>();`
// -> the large source is scanned to block 0 by updateIndex.
// Mutant: index.ts `const floorOf = (s: Source) => (layer2 ||` -> `(false ||` -> buildIndex stops at the recent floor too.
test('[unit] smallMax: layer 1 leaves a large source pending at the recent floor, buildIndex takes it to block 0 and completes', async () => {
  const target = 999_000, floor = floorFor(target, 2);
  const c = chain({ head: 1_000_000, finalized: target, counters: { [F2]: 3 }, logs: [v2Log(F2, tk(1), tk(2), pair(1), 100), v2Log(F2, tk(3), tk(4), pair(2), 800_000), v2Log(F2, tk(5), tk(6), pair(3), 900_000)] });
  const store = new MemoryStore();
  const d1 = await up(c, store, { smallMax: 2 });
  assert.deepEqual([cov(d1, F2)?.fromBlock, cov(d1, F2)?.large, cov(d1, F2)?.logs], [floor, true, 2]);
  assert.deepEqual([d1.layer2, d1.complete], [{ pending: 1, done: 0 }, false]);
  assert.ok(c.getLogsRanges().every(([lo]) => lo >= floor || lo === 0), 'only the Hub and F3 go below the floor');
  const d2 = await build(c, store, { smallMax: 2 });
  assert.deepEqual([cov(d2, F2)?.fromBlock, cov(d2, F2)?.logs, cov(d2, F2)?.complete], [0, 3, true]);
  assert.deepEqual([d2.layer2, d2.complete], [{ pending: 0, done: 1 }, true]);
  assert.deepEqual(await indexStatus({ chainId: CHAIN, store }), (({ run: _r, ...x }) => ({ ...x, target: { ...x.target!, confirmations: 0, unindexedTail: 1000 } }))(d2));
});

// Mutant: index.ts `if (!isL && logs > smallMax) { isL = true; grew = true; }` -> `if (false) { isL = true; grew = true; }`
// -> a source with no counter whose walk down finds more than smallMax logs goes on to block 0.
test('[range] no counter: a source found large during its walk down stops at the recent floor in layer 1', async () => {
  const target = 999_000, floor = floorFor(target, 2);
  const logs = [950_000, 960_000, 970_000, 750_000, 500_000].map((b, i) => v3Log(F3, tk(2 * i), tk(2 * i + 1), pair(i), b));
  const c = chain({ head: 1_000_000, finalized: target, logs });
  const store = new MemoryStore();
  const d = await up(c, store, { smallMax: 2, span: 100_000 });
  assert.deepEqual([cov(d, F3)?.fromBlock, cov(d, F3)?.large, cov(d, F3)?.logs, cov(d, F3)?.counter], [floor, true, 4, null]);
  assert.deepEqual(await searchIndex({ chainId: CHAIN, store }, tk(8)), []);
  assert.equal((await searchIndex({ chainId: CHAIN, store }, tk(6))).length, 1);
  const f3 = c.calls.filter((x) => x.method === 'eth_getLogs' && lc(String((x.params[0] as { address: unknown }).address)) === lc(F3));
  assert.equal(Math.min(...f3.map((x) => parseInt((x.params[0] as { fromBlock: string }).fromBlock, 16))), floor);
  assert.equal(d.layer2.pending, 1);
});

// Mutant: index.ts `Math.ceil(((o.recentDays` -> `Math.floor(((o.recentDays` -> at 11 s per block the floor moves up one block.
// Mutant: index.ts `export const RECENT_DAYS = 7;` -> `= 6;` -> the window is shorter at both block times.
// Mutant: index.ts `const dt = b ? t.timestamp - b.timestamp : NaN;` -> `const dt = b ? 2 * n : NaN;` -> the block time is assumed, not measured.
test('[range] the recent window is 7 days at the measured block time: the floor block is in, the one below is out', async () => {
  const target = 999_000;
  for (const bt of [2, 11]) {
    const floor = floorFor(target, bt);
    const c = chain({ head: 1_000_000, finalized: target, blockTime: bt, counters: { [F2]: 250_001 }, logs: [v2Log(F2, tk(1), tk(2), pair(1), floor - 1), v2Log(F2, tk(3), tk(4), pair(2), floor)] });
    const store = new MemoryStore();
    const d = await up(c, store);
    assert.equal(cov(d, F2)?.fromBlock, floor, `blockTime ${bt}`);
    assert.equal((await searchIndex({ chainId: CHAIN, store }, tk(3))).length, 1, `blockTime ${bt}`);
    assert.deepEqual(await searchIndex({ chainId: CHAIN, store }, tk(1)), [], `blockTime ${bt}`);
  }
  assert.deepEqual([floorFor(target, 2), floorFor(target, 11)], [696_600, 944_018]);
});

// Mutant: index.ts `unread.slice(i, i + SYMBOL_LOT)` -> `unread.slice(i)` -> all symbols are one read; a stop in its
// second eth_call loses the first lot.
// Mutant: index.ts `!st.tokens.has(k) && k !== ZERO` -> `!st.tokens.has(k)` -> symbol() is asked of the zero address.
test('[range] symbols in lots of 1500, each stored as read: a stop in the second lot keeps the first; the zero address is never read', async () => {
  const P = 751;
  const logs = [...Array.from({ length: P }, (_, i) => v2Log(F2, tk(2 * i), tk(2 * i + 1), pair(i), 10 + i)), v2Log(F2, ZERO, tk(0), pair(P), 800)];
  const mk = () => chain({ logs, counters: { [F2]: P + 1 } });
  const ref = mk();
  const full = await up(ref, new MemoryStore());
  assert.deepEqual(full.tokens, { known: 2 * P, symbolRead: 0, symbolFailed: 2 * P, unread: 0 });
  const targets = ref.calls.filter((x) => x.method === 'eth_call').flatMap((x) => (decodeFunctionData({ abi: MC_ABI, data: (x.params[0] as { data: Hex }).data }).args[0] as readonly { target: Address }[]).map((s) => lc(s.target)));
  assert.equal(targets.filter((t) => t === lc(ZERO)).length, 0);
  assert.equal(targets.length, 3 + 2 + 2 * 2 * P);
  const c = mk();
  const store = new MemoryStore();
  const cut = await up(c, store, { maxRequests: full.run!.requests - 1 });
  assert.equal(cut.run?.stopped, 'requests');
  assert.deepEqual(cut.tokens, { known: 2 * P, symbolRead: 0, symbolFailed: 1500, unread: 2 * P - 1500 });
  const rest = await up(c, store);
  assert.deepEqual([rest.tokens.unread, rest.complete], [0, true]);
});

// Mutant: index.ts `await append(c, [...ops, cursorOp(s, lo, hiEdge, hash, isL)]);` -> `await append(c, [cursorOp(s, lo, hiEdge, hash, isL)]); await append(c, ops);`
// -> a failure between the two appends leaves a cursor claiming a range whose venues were never stored.
test('[fuzz] a store failing at every possible append: every stored cursor holds every log of its range', async () => {
  const logs = [v2Log(F2, tk(1), tk(2), pair(1), 50), v2Log(F2, tk(3), tk(4), pair(2), 450), v2Log(F2, tk(5), tk(6), pair(3), 700), v3Log(F3, tk(7), tk(8), pair(4), 250), v3Log(F3, tk(9), tk(10), pair(5), 850)];
  const ref = new BreakAt(Infinity);
  await up(chain({ logs, counters: { [F2]: 3 } }), ref, { span: 300 });
  assert.ok(ref.n > 6);
  for (let at = 1; at <= ref.n; at++) {
    const c = chain({ logs, counters: { [F2]: 3 } });
    const store = new BreakAt(at);
    const d = await up(c, store, { span: 300 });
    assert.ok(d.run!.errors.some((e) => e.includes('disk full')), `append ${at}`);
    assert.equal(d.complete, false, `append ${at}`);
    for (const [s, k] of materialize(await store.inner.load(CHAIN)).cursors) {
      if (k.from > k.to) continue;
      assert.equal(k.logs, inFake(c, s, k.from, k.to), `append ${at}: ${s} [${k.from}, ${k.to}]`);
    }
  }
});

// Mutant: index.ts `if (e instanceof MeterStop) c.stopped = e.reason; else c.errors.push(why(e));` -> `c.errors.push(why(e));`
// -> a run stopped by the request cap reports an error and no stop.
// Mutant: index.ts `if (r.stop === 'budget' || r.stop === 'requests') c.stopped = r.stop;` -> `if (false) c.stopped = r.stop;`
// -> a walk cut by the cap, with nothing left to read after it, ends as neither stopped nor complete.
test('[fuzz] runs cut at any request cap resume to the same index as one uncapped run, and every cut run says it stopped', async () => {
  const logs = [v2Log(F2, tk(1), tk(2), pair(1), 50), v2Log(F2, tk(3), tk(4), pair(2), 450), v2Log(F2, tk(5), tk(6), pair(3), 700), v3Log(F3, tk(7), tk(8), pair(4), 250), v3Log(F3, tk(9), tk(10), pair(5), 850)];
  const tokens = { [tk(1)]: { symbol: { string: 'AAA' } }, [tk(7)]: { name: { bytes32: 'Seven' } }, [tk(9)]: { symbol: 'revert' as const } };
  const fixtures: [string, () => FakeChain][] = [
    ['two factories', () => chain({ logs, tokens, counters: { [F2]: 3 } })],
    ['one empty factory', () => new FakeChain({ head: 1000, finalized: 900, hub: HUB, factoryCount: 1, logs: [factoryLog(HUB, F3, 1, 6)] })],
  ];
  for (const [name, mk] of fixtures) {
    const ref = new MemoryStore();
    const whole = await up(mk(), ref, { span: 200 });
    assert.equal(whole.complete, true, name);
    const want = await indexStatus({ chainId: CHAIN, store: ref });
    for (let k = 6; k <= 12; k++) {
      const c = mk();
      const store = new MemoryStore();
      let runs = 0;
      for (;;) {
        const d = await up(c, store, { span: 200, maxRequests: k });
        runs++;
        if (d.complete) break;
        assert.deepEqual([d.run?.stopped, d.run?.errors], ['requests', []], `${name}, cap ${k}, run ${runs}`);
        assert.ok(runs < 60, `${name}, cap ${k}: no progress`);
      }
      assert.deepEqual(await indexStatus({ chainId: CHAIN, store }), want, `${name}, cap ${k}`);
      assert.deepEqual(await searchIndex({ chainId: CHAIN, store }, 'aaa'), await searchIndex({ chainId: CHAIN, store: ref }, 'aaa'), `${name}, cap ${k}`);
    }
  }
  assert.equal((await searchIndex({ chainId: CHAIN, store: (await (async () => { const s = new MemoryStore(); await up(fixtures[0][1](), s); return s; })()) }, 'seven'))[0]?.status, 'READ');
});
