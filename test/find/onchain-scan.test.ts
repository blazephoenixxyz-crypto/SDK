// The on-chain index below updateIndex: creation-event table and decoder (kinds.ts), request meter and
// target block (rpc.ts), the chunked walk and eth_getLogs guard (scan.ts), Multicall3 lots and token
// text (symbols.ts), the append-only store and its derived state (store.ts). Tested directly, no
// network: test/find/fake-rpc.ts plays the node, wrappers in this file add the knobs it lacks.
// Oracles are independent of src: topic0 and selectors are keccak256 of signatures written here,
// venues and tokens are Base logs recorded live (24/11) and checked against token0()/token1().
// Each test names the mutant of src/find/onchain that turns it red.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, keccak256, parseAbi, toBytes, type Address, type Hex } from 'viem';
import { blockOf, COUNTERS, CREATION_EVENTS, decodeCreation, FACTORY_EVENT, HUB_CALLS, type RawLog } from '../../src/find/onchain/kinds.js';
import { getBlock, Meter, MeterStop, resolveTarget, type ChainRpc } from '../../src/find/onchain/rpc.js';
import { getLogs, HUB_KIND, ONE_BLOCK_RETRIES, opsOf, walk, type Source } from '../../src/find/onchain/scan.js';
import { callMany, decodeText, MAX_SUBCALLS, MULTICALL3, readTexts, textOf, wordAddress, wordNumber, type Call } from '../../src/find/onchain/symbols.js';
import { FileStore, materialize, MemoryStore, type IndexOp } from '../../src/find/onchain/store.js';
import { addr, FakeChain, factoryLog, hex, pad, v2Log, word, type FakeLog } from './fake-rpc.js';

const topicOf = (sig: string): Hex => keccak256(toBytes(sig));
const selectorOf = (sig: string): Hex => topicOf(sig).slice(0, 10) as Hex;
const SIG = {
  v2: 'PairCreated(address,address,address,uint256)',
  v3: 'PoolCreated(address,address,uint24,int24,address)',
  slipstream: 'PoolCreated(address,address,int24,address)',
  solidly: 'PoolCreated(address,address,bool,address,uint256)',
  v4: 'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)',
};
const MC_ABI = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }', 'function aggregate3(Call3[] calls) payable returns (Result[] returnData)']);
/** Seeded PRNG (mulberry32): the fuzz cases are the same on every run. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const F = addr(0xf0);
const HUB = addr(0x4b);
const rawOf = (l: FakeLog): RawLog => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: hex(l.block), logIndex: hex(l.logIndex) });

// ---------------------------------------------------------------- kinds.ts

// Mutant: one hex digit of the PairCreated topic0 in CREATION_EVENTS -> its row differs from keccak256(signature).
// Mutant: allPairsLength selector 0x574f2ba3 -> 0x574f2ba4 -> COUNTERS[0] differs from the selector of the signature.
// Mutant: bridge(uint8) selector 0xd80b21d7 -> 0xd80b21d8 -> HUB_CALLS.bridge differs.
test('[vector] every topic0 and selector is keccak256 of its signature, and the table rows are the expected kinds', () => {
  assert.deepEqual(CREATION_EVENTS.map((e) => [e.kind, e.topic0, e.tokenTopics, e.venue]), [
    [0, topicOf(SIG.v2), [1, 2], { word: 0 }],
    [1, topicOf(SIG.v3), [1, 2], { word: 1 }],
    [1, topicOf(SIG.slipstream), [1, 2], { word: 0 }],
    [5, topicOf(SIG.solidly), [1, 2], { word: 0 }],
    [4, topicOf(SIG.v4), [2, 3], { topic: 1 }],
  ]);
  for (const e of CREATION_EVENTS) assert.equal(e.topic0, topicOf(e.signature), e.signature);
  assert.equal(FACTORY_EVENT.topic0, topicOf('Factory_(address,uint8,uint8)'));
  assert.deepEqual(COUNTERS, { 0: [selectorOf('allPairsLength()')], 1: [selectorOf('allPoolsLength()')], 5: [selectorOf('allPoolsLength()')] });
  assert.deepEqual(HUB_CALLS, { factoryCount: selectorOf('factoryCount()'), v4PoolManager: selectorOf('v4PoolManager()'), bridgeCount: selectorOf('bridgeCount()'), bridge: selectorOf('bridge(uint8)') });
});

/** First data row of sample-<name>.tsv (Base, recorded 24/11); venue checked live by token0()/token1().
 *  Topic 3 (fee, tickSpacing or stable) was not recorded and the decoder does not read it: a placeholder. */
const BASE: { name: string; kind: number; sig: string; factory: Address; block: number; t0: Address; t1: Address; data: Hex; venue: Hex }[] = [
  { name: 'Uniswap V2', kind: 0, sig: SIG.v2, factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6', block: 11297861, t0: '0x4200000000000000000000000000000000000006', t1: '0x95d06f753ec7ca0288429c0470e36b1da510182a',
    data: '0x0000000000000000000000009a65fbec5231f03120f38d501fa562a7f70143e30000000000000000000000000000000000000000000000000000000000000036', venue: '0x9a65fbec5231f03120f38d501fa562a7f70143e3' },
  { name: 'Uniswap V3', kind: 1, sig: SIG.v3, factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', block: 2318353, t0: '0x4200000000000000000000000000000000000006', t1: '0x9e53e88dcff56d3062510a745952dec4cefdff9e',
    data: '0x00000000000000000000000000000000000000000000000000000000000000c80000000000000000000000002f35c5480bf95160b653695d3568a5747633d810', venue: '0x2f35c5480bf95160b653695d3568a5747633d810' },
  { name: 'Aerodrome V2', kind: 5, sig: SIG.solidly, factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da', block: 3204843, t0: '0xa334884bf6b0a066d553d19e507315e839409e62', t1: '0xf7a0dd3317535ec4f4d29adf9d620b3d8d5d5069',
    data: '0x000000000000000000000000218f511431194b2c756d67a137de536bea74e4980000000000000000000000000000000000000000000000000000000000000008', venue: '0x218f511431194b2c756d67a137de536bea74e498' },
  { name: 'Slipstream', kind: 1, sig: SIG.slipstream, factory: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A', block: 14114753, t0: '0x3ff7ab26f2dfd482c40bdadfc0e88d01bff79713', t1: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    data: '0x0000000000000000000000003d797bc54d4ba41cb105a020a56ce55f223ee2a2', venue: '0x3d797bc54d4ba41cb105a020a56ce55f223ee2a2' },
  { name: 'PancakeSwap V3', kind: 1, sig: SIG.v3, factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', block: 5651379, t0: '0x4200000000000000000000000000000000000006', t1: '0x936fa2de8380dc5bf34c80f1bad53a9f3630263b',
    data: '0x000000000000000000000000000000000000000000000000000000000000003200000000000000000000000093c1ad308a6907dad2a81e53f333a40cffc1a1c5', venue: '0x93c1ad308a6907dad2a81e53f333a40cffc1a1c5' },
];
const baseLog = (f: (typeof BASE)[number]): RawLog => ({
  address: f.factory, topics: [topicOf(f.sig), pad(f.t0), pad(f.t1), ...(f.kind === 0 ? [] : [word(0)])], data: f.data, blockNumber: hex(f.block), logIndex: '0x3',
});

// Mutant: Uniswap V3 row `venue: { word: 1 }` -> `{ word: 0 }` -> Uniswap V3 and PancakeSwap V3 decode the tickSpacing word as the venue (zero high bytes) or not at all.
// Mutant: decodeCreation picks the row by topic0 alone (`e.kind === kind && ` dropped) -> a V3 log read under kind 5 decodes.
test('[vector] recorded Base creation logs of five venue shapes decode to the venue and tokens checked live', () => {
  for (const f of BASE) {
    const d = decodeCreation(f.kind, baseLog(f));
    assert.deepEqual(d, { venue: f.venue, tokens: [f.t0, f.t1], block: f.block }, f.name);
    const ops = opsOf([{ address: f.factory, kind: f.kind }], [baseLog(f)]);
    assert.deepEqual(ops, [{ o: 'v', source: f.factory, kind: f.kind, venue: f.venue, t0: f.t0, t1: f.t1, block: f.block }], f.name);
    // The same log under a kind that has no row with its topic0 is not a venue of that kind.
    for (const other of [0, 1, 4, 5, 6].filter((k) => k !== f.kind)) assert.equal(decodeCreation(other, baseLog(f)), null, `${f.name} as kind ${other}`);
  }
  // Upper-case hex from a node reads the same.
  const up = baseLog(BASE[1]);
  assert.deepEqual(decodeCreation(1, { ...up, topics: up.topics.map((t) => t.toUpperCase().replace('0X', '0x')), data: up.data.toUpperCase().replace('0X', '0x') })?.venue, BASE[1].venue);
});

// Mutant: asAddress without `/^0x0{24}/` -> a token topic with high bytes set decodes as an address.
// Mutant: `(data.length - 2) / 64 < row.dataWords` -> `< row.dataWords - 1` -> data one word short decodes.
// Mutant: data regex `/^0x([0-9a-f]{64})*$/` -> `/^0x[0-9a-f]*$/` -> data with a trailing half word decodes.
// Mutant: zero-venue guard dropped -> a zero venue (or a zero V4 PoolId) is indexed.
// Mutant: V4 `WORD.test(t) ? (t as Hex) : null` -> `t as Hex` -> a short PoolId is indexed.
// Mutant: blockOf without `n >= 0` -> a log at block -1 decodes.
test('[vector] malformed creation logs are null, never guessed', () => {
  const T0 = addr(0xa), T1 = addr(0xb), VENUE = addr(0xc);
  const v2 = (topics: string[], data: string, blockNumber: RawLog['blockNumber'] = '0x10'): RawLog => ({ address: F, topics, data, blockNumber });
  const good = v2([topicOf(SIG.v2), pad(T0), pad(T1)], `${pad(VENUE)}${word(1).slice(2)}`);
  assert.equal(decodeCreation(0, good)?.venue, VENUE);
  const high = `0x01${pad(T0).slice(4)}`;
  const cases: [string, number, RawLog][] = [
    ['token topic with high bytes', 0, { ...good, topics: [topicOf(SIG.v2), high, pad(T1)] }],
    ['second token topic with high bytes', 0, { ...good, topics: [topicOf(SIG.v2), pad(T0), high] }],
    ['token topic missing', 0, { ...good, topics: [topicOf(SIG.v2), pad(T0)] }],
    ['token topic 31 bytes', 0, { ...good, topics: [topicOf(SIG.v2), pad(T0).slice(0, 64), pad(T1)] }],
    ['data one word short', 0, { ...good, data: pad(VENUE) }],
    ['data empty', 0, { ...good, data: '0x' }],
    ['data with a trailing half word', 0, { ...good, data: `${good.data}${'00'.repeat(16)}` }],
    ['data not hex', 0, { ...good, data: `${pad(VENUE)}${'zz'.repeat(32)}` }],
    ['venue word with high bytes', 0, { ...good, data: `0x01${pad(VENUE).slice(4)}${word(1).slice(2)}` }],
    ['zero venue', 0, { ...good, data: `${word(0)}${word(1).slice(2)}` }],
    ['unknown topic0', 0, { ...good, topics: [topicOf('Swap(address,uint256)'), pad(T0), pad(T1)] }],
    ['no topics', 0, { ...good, topics: [] }],
    ['block null', 0, { ...good, blockNumber: null }],
    ['block -1', 0, { ...good, blockNumber: -1 }],
    ['block not hex', 0, { ...good, blockNumber: '0xzz' }],
    ['block above 2^53', 0, { ...good, blockNumber: 2n ** 53n }],
    ['V4 PoolId 31 bytes', 4, { address: F, topics: [topicOf(SIG.v4), `0x${'ab'.repeat(31)}`, pad(T0), pad(T1)], data: `0x${'00'.repeat(160)}`, blockNumber: '0x10' }],
    ['V4 PoolId zero', 4, { address: F, topics: [topicOf(SIG.v4), word(0), pad(T0), pad(T1)], data: `0x${'00'.repeat(160)}`, blockNumber: '0x10' }],
    ['V4 data four words', 4, { address: F, topics: [topicOf(SIG.v4), word(7), pad(T0), pad(T1)], data: `0x${'00'.repeat(128)}`, blockNumber: '0x10' }],
  ];
  for (const [name, kind, log] of cases) assert.equal(decodeCreation(kind, log), null, name);
  // V4: currency 0 may be native ETH (address 0); the PoolId is the venue.
  assert.deepEqual(decodeCreation(4, { address: F, topics: [topicOf(SIG.v4), word(7), pad(addr(0)), pad(T1)], data: `0x${'00'.repeat(160)}`, blockNumber: 16 }),
    { venue: word(7), tokens: [addr(0), T1], block: 16 });
  // blockOf: the range of a block number.
  assert.deepEqual([0, '0x0', Number.MAX_SAFE_INTEGER, 5n, '0xA'].map(blockOf), [0, 0, Number.MAX_SAFE_INTEGER, 5, 10]);
  assert.deepEqual([-1, 1.5, '12', '', null, undefined, 2n ** 53n].map((v) => blockOf(v as RawLog['blockNumber'])), [null, null, null, null, null, null, null]);
});

// ---------------------------------------------------------------- rpc.ts

// Mutant: `if (this.requests >= this.maxRequests)` -> `>` -> request N+1 reaches the node.
// Mutant: `if (this.now() >= this.deadline)` -> `>` -> a request starts at the deadline.
test('[range] the meter lets exactly N requests through and none at or after the deadline', async () => {
  for (const n of [0, 1, 3]) {
    const chain = new FakeChain({ head: 10 });
    const m = new Meter(n);
    for (let i = 0; i < n; i++) await m.call(chain, 'eth_blockNumber', []);
    await assert.rejects(m.call(chain, 'eth_blockNumber', []), (e) => e instanceof MeterStop && e.reason === 'requests');
    assert.equal(chain.calls.length, n);
    assert.equal(m.exhausted(), 'requests');
  }
  let t = 1000;
  const chain = new FakeChain({ head: 10 });
  const m = new Meter(Infinity, 100, () => t);
  t = 1099;
  await m.call(chain, 'eth_blockNumber', []);
  t = 1100;
  await assert.rejects(m.call(chain, 'eth_blockNumber', []), (e) => e instanceof MeterStop && e.reason === 'budget');
  assert.equal(chain.calls.length, 1);
});

/** A node whose 'finalized' block is the one given (even past the head), over a FakeChain. */
const finalizedAt = (chain: FakeChain, n: number): ChainRpc => ({
  request: async (a) => (a.method === 'eth_getBlockByNumber' && a.params?.[0] === 'finalized'
    ? { number: hex(n), hash: chain.hashOf(n), timestamp: hex(1_700_000_000 + 2 * n) }
    : chain.request(a)),
});

// Mutant: `if (fin && fin.number <= head)` -> `if (fin && false)` -> the finalized block is ignored, the target is head - 64.
// Mutant: `fin.number <= head` -> `fin.number < head` -> a finalized block equal to the head is refused.
// Mutant: `fin.number <= head` dropped (`if (fin)`) -> a finalized block past the head becomes the target.
test('[unit] resolveTarget runs to the finalized block when the node answers it, up to the head and not past it', async () => {
  const chain = new FakeChain({ head: 1000, finalized: 900 });
  const t = await resolveTarget(new Meter(), chain, 64);
  assert.deepEqual(t, { head: 1000, target: 900, hash: chain.hashOf(900), timestamp: 1_700_000_000 + 1800, by: 'finalized', confirmations: 64, unindexedTail: 100 });
  const atHead = await resolveTarget(new Meter(), finalizedAt(chain, 1000), 64);
  assert.equal(atHead.by, 'finalized');
  assert.equal(atHead.target, 1000);
  assert.equal(atHead.unindexedTail, 0);
  const past = await resolveTarget(new Meter(), finalizedAt(chain, 1001), 64);
  assert.equal(past.by, 'head-confirmations');
  assert.equal(past.target, 936);
});

// Mutant: `Math.max(0, head - confirmations)` -> `Math.max(0, head)` -> the target is the unconfirmed head.
// Mutant: `Math.max(0, head - confirmations)` -> `head - confirmations` -> a chain shorter than 64 blocks has no target.
// Mutant: getBlock hash check dropped -> a block with a 31-byte hash becomes the target's anchor.
test('[range] without a finalized tag the target is head - confirmations, floored at block 0', async () => {
  const chain = new FakeChain({ head: 1000, finalized: null });
  assert.deepEqual(await resolveTarget(new Meter(), chain, 64), { head: 1000, target: 936, hash: chain.hashOf(936), timestamp: 1_700_000_000 + 1872, by: 'head-confirmations', confirmations: 64, unindexedTail: 64 });
  for (const [head, target] of [[0, 0], [10, 0], [63, 0], [64, 0], [65, 1]] as const) {
    const c = new FakeChain({ head, finalized: null });
    const t = await resolveTarget(new Meter(), c, 64);
    assert.deepEqual([t.target, t.hash, t.unindexedTail], [target, c.hashOf(target), head - target], `head ${head}`);
  }
  // A garbage head or a block without a full hash is an error, not a target.
  await assert.rejects(resolveTarget(new Meter(), { request: async () => 'latest' }, 64), /not a block number/);
  const shortHash: ChainRpc = { request: async (a) => (a.method === 'eth_getBlockByNumber' ? (a.params?.[0] === 'finalized' ? null : { number: '0x5', hash: `0x${'ab'.repeat(31)}`, timestamp: '0x1' }) : chain.request(a)) };
  assert.equal(await getBlock(new Meter(), shortHash, 5), null);
  await assert.rejects(resolveTarget(new Meter(), shortHash, 64), /returned no block/);
  // A stop of the meter while asking 'finalized' is a stop, not "no finalized tag".
  await assert.rejects(resolveTarget(new Meter(1), chain, 64), (e) => e instanceof MeterStop);
});

// ---------------------------------------------------------------- scan.ts: walk

/** A node for walk(): a range longer than `cap` fails, a range holding a block of `fails` fails while its count lasts. */
function rangeNode(cap: number, fails: Map<number, number>) {
  const seen: [number, number][] = [];
  const rpc: ChainRpc = {
    request: async ({ params }) => {
      const [a, b] = params as [number, number];
      seen.push([a, b]);
      if (b - a + 1 > cap) throw new Error('query returned more than 10000 results');
      for (const [x, n] of fails) if (x >= a && x <= b && n > 0) { fails.set(x, n - 1); throw new Error(`timeout at ${x}`); }
      return [];
    },
  };
  return { rpc, seen };
}

// Mutant: down split `stack.push([a, m], [m + 1, b])` -> `[a, m], [m, b]` -> block m committed twice.
// Mutant: up split `stack.push([m + 1, b], [a, m])` -> `[m, b], [a, m]` -> block m committed twice.
// Mutant: halves pushed far edge on top (`[m + 1, b], [a, m]` for down) -> a gap above the lower half.
// Mutant: `edge = ... a - 1 : b + 1` -> `a : b + 1` -> the next chunk overlaps the last one.
// Mutant: `Math.max(o.from, edge - span + 1)` -> `edge - span + 1` (and `Math.min(o.to, ...)` dropped) -> blocks outside [from, to] fetched.
// Mutant: `edge < o.from` -> `edge <= o.from` (and `edge > o.to` -> `>=`) -> the last block of the range is never scanned.
test('[fuzz] walk commits [from, to] contiguously, in order, without overlap, under log caps and transient errors', async () => {
  const r = prng(0x5ca11);
  for (let i = 0; i < 400; i++) {
    const dir = r() < 0.5 ? 'down' : 'up';
    const from = r() < 0.2 ? 0 : int(r, 0, 60);
    const len = r() < 0.05 ? 0 : int(r, 1, 300);
    const to = from + len - 1;
    const span = int(r, 1, 80);
    const fails = new Map<number, number>();
    for (let k = int(r, 0, 4); k > 0 && len > 0; k--) fails.set(int(r, from, to), int(r, 1, 2));
    const dead = len > 0 && r() < 0.25 ? int(r, from, to) : null;
    if (dead !== null) fails.set(dead, Infinity);
    const { rpc, seen } = rangeNode(int(r, 1, 100), fails);
    const meter = new Meter(50_000);
    const commits: [number, number][] = [];
    const res = await walk({
      dir, from, to, span, meter,
      fetch: (a, b) => meter.call(rpc, 'eth_getLogs', [a, b]),
      commit: async (a, b) => { assert.deepEqual(seen[seen.length - 1], [a, b], 'commit after the fetch of that chunk'); commits.push([a, b]); return true; },
    });
    const ctx = `case ${i}: ${dir} [${from}, ${to}] span ${span} dead ${dead}`;
    for (const [a, b] of seen) assert.ok(a >= from && b <= to && a <= b && b - a + 1 <= span, `${ctx}: fetched [${a}, ${b}]`);
    // The covered range: up from `from`, or down from `to`, to the dead block (excluded) or the end.
    const lo = dir === 'up' ? from : dead === null ? from : dead + 1;
    const hi = dir === 'down' ? to : dead === null ? to : dead - 1;
    const ordered = dir === 'up' ? commits : [...commits].reverse();
    let next = lo;
    for (const [a, b] of ordered) { assert.equal(a, next, `${ctx}: contiguous`); next = b + 1; }
    assert.equal(next, hi + 1, `${ctx}: covers [${lo}, ${hi}]`);
    if (dead === null) assert.deepEqual(res, { done: true }, ctx);
    else {
      assert.deepEqual({ ...res, error: '' }, { done: false, stop: 'error', at: dead, error: '' }, ctx);
      assert.equal(seen.filter(([a, b]) => a === dead && b === dead).length, ONE_BLOCK_RETRIES + 1, ctx);
    }
    if (len === 0) assert.equal(seen.length, 0, ctx);
  }
});

// Mutant: `export const ONE_BLOCK_RETRIES = 2` -> `= 1` -> a block that fails twice and then answers stops the walk.
// Mutant: `export const ONE_BLOCK_RETRIES = 2` -> `= 3` -> a dead block is tried four times.
// Mutant: `if (a === b)` retry branch dropped (one block split as a range) -> no stop, or a wrong cursor.
test('[range] a one-block chunk is tried three times, then the walk stops before it and commits nothing past it', async () => {
  for (const dir of ['up', 'down'] as const) {
    for (const [failures, ok] of [[2, true], [3, false]] as const) {
      let oneBlock = 0;
      const commits: [number, number][] = [];
      const res = await walk({
        dir, from: 0, to: 15, span: 16, meter: new Meter(),
        fetch: async (a, b) => {
          if (a <= 7 && 7 <= b) {
            if (a !== b) throw new Error('range holds block 7');
            if (++oneBlock <= failures) throw new Error('timeout at 7');
          }
          return [];
        },
        commit: async (a, b) => { commits.push([a, b]); return true; },
      });
      const ctx = `${dir}, block 7 fails ${failures} times`;
      assert.equal(oneBlock, ok ? failures + 1 : 3, ctx);
      const covered = commits.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, k) => a + k)).sort((x, y) => x - y);
      if (ok) {
        assert.deepEqual(res, { done: true }, ctx);
        assert.deepEqual(covered, Array.from({ length: 16 }, (_, k) => k), ctx);
      } else {
        assert.deepEqual({ ...res, error: undefined }, { done: false, stop: 'error', at: 7, error: undefined }, ctx);
        assert.match(res.error!, /timeout at 7/);
        assert.deepEqual(covered, dir === 'up' ? [0, 1, 2, 3, 4, 5, 6] : [8, 9, 10, 11, 12, 13, 14, 15], ctx);
      }
    }
  }
});

// Mutant: `span = Math.min(max, (b - a + 1) * 2)` -> `Math.min(max, (b - a + 1))` -> after one split the chunks stay small (21 requests, not 12).
// Mutant: `span = Math.min(max, (b - a + 1) * 2)` -> `(b - a + 1) * 2` -> chunks grow past the span asked for.
// Mutant: `Math.max(1, o.span ?? INITIAL_SPAN)` -> `o.span ?? INITIAL_SPAN` -> span 0 never moves.
test('[range] the chunk doubles back to the span after a split and never exceeds it; span 0 is one block', async () => {
  const fails = new Map([[0, 1]]);
  const { rpc, seen } = rangeNode(Infinity, fails);
  const res = await walk({ dir: 'up', from: 0, to: 9999, span: 1024, meter: new Meter(), fetch: (a, b) => rpc.request({ method: 'x', params: [a, b] }) as Promise<RawLog[]>, commit: async () => true });
  assert.deepEqual(res, { done: true });
  // [0,1023] fails once; [0,511] and [512,1023] pass; then 9 chunks of up to 1024 to 9999.
  assert.equal(seen.length, 12);
  assert.ok(seen.every(([a, b]) => b - a + 1 <= 1024));
  assert.deepEqual(seen.slice(0, 4), [[0, 1023], [0, 511], [512, 1023], [1024, 2047]]);
  const one = rangeNode(Infinity, new Map());
  const meter = new Meter(100);
  assert.deepEqual(await walk({ dir: 'down', from: 0, to: 2, span: 0, meter, fetch: (a, b) => meter.call(one.rpc, 'x', [a, b]), commit: async () => true }), { done: true });
  assert.deepEqual(one.seen, [[2, 2], [1, 1], [0, 0]]);
});

// Mutant: walk without `if (e instanceof MeterStop) return ...` -> a stop inside fetch is retried and split like a node error.
// Mutant: `if (stop) return { done: false, stop };` -> `if (false) ...` -> fetch runs with the meter spent.
// Mutant: `if (!(await o.commit(a, b, logs)))` ignored -> the walk goes on after the caller said stop.
// Mutant: caller stop `done: <edge test>` -> `done: false` -> a stop on the last chunk is reported as not done.
test('[unit] walk stops on the meter before a fetch, on a MeterStop inside it, and where the caller says', async () => {
  let fetched = 0;
  assert.deepEqual(await walk({ dir: 'up', from: 0, to: 9, meter: new Meter(0), fetch: async () => { fetched++; return []; }, commit: async () => true }), { done: false, stop: 'requests' });
  assert.equal(fetched, 0);
  for (const to of [0, 9]) {
    fetched = 0;
    const res = await walk({ dir: 'down', from: 0, to, meter: new Meter(), fetch: async () => { fetched++; throw new MeterStop('budget'); }, commit: async () => true });
    assert.deepEqual(res, { done: false, stop: 'budget' });
    assert.equal(fetched, 1);
  }
  const commits: number[] = [];
  const res = await walk({ dir: 'up', from: 0, to: 9, span: 2, meter: new Meter(), fetch: async () => [], commit: async (a) => { commits.push(a); return commits.length < 2; } });
  assert.deepEqual([res, commits], [{ done: false, stop: 'caller' }, [0, 2]]);
  const last = await walk({ dir: 'down', from: 0, to: 9, span: 10, meter: new Meter(), fetch: async () => [], commit: async () => false });
  assert.deepEqual(last, { done: true, stop: 'caller' });
  // An empty range asks nothing.
  assert.deepEqual(await walk({ dir: 'up', from: 5, to: 4, meter: new Meter(), fetch: async () => { throw new Error('asked'); }, commit: async () => true }), { done: true });
});

// ---------------------------------------------------------------- scan.ts: getLogs, opsOf

// Mutant: getLogs `return (r as RawLog[]).filter(...)` reached for a non-list (`if (!Array.isArray(r)) return [];`) -> a null answer is an empty chunk, its logs are lost.
test('[vector] a getLogs answer that is not a list is an error, and walk splits until every log is read', async () => {
  for (const bad of [null, {}, 'error', 0, undefined]) {
    const chain = new FakeChain({ head: 100, answer: () => bad });
    await assert.rejects(getLogs(new Meter(), chain, [{ address: F, kind: 0 }], 0, 10), /not a list/, String(bad));
  }
  // A node that answers null to any range wider than 4 blocks.
  const logs = [2, 9, 14].map((b, i) => v2Log(F, addr(0xa), addr(0xb), addr(0x100 + i), b));
  const chain = new FakeChain({ head: 100, logs, answer: (lo, hi, out) => (hi - lo > 3 ? null : out) });
  const meter = new Meter();
  const got: RawLog[] = [];
  const res = await walk({ dir: 'up', from: 0, to: 15, span: 16, meter, fetch: (a, b) => getLogs(meter, chain, [{ address: F, kind: 0 }], a, b), commit: async (_a, _b, l) => { got.push(...l); return true; } });
  assert.deepEqual(res, { done: true });
  assert.deepEqual(got.map((l) => blockOf(l.blockNumber)), [2, 9, 14]);
});

// Mutant: `b < lo || b > hi` -> `false` -> logs outside the asked range are accepted.
// Mutant: `b < lo || b > hi` -> `b <= lo || b > hi` -> a log at the first block of the range is refused.
// Mutant: address check dropped -> a log of an address not asked for is accepted.
// Mutant: `.filter((l) => l.removed !== true)` -> `.filter((l) => true)` -> a removed (reorged) log is kept.
// Mutant: topic0 set not deduplicated -> two V2 sources ask the same topic twice.
// Mutant: eventsOfKind keeps one row per kind -> a kind 1 source does not ask the Slipstream topic0.
test('[vector] getLogs refuses logs outside [lo, hi], of another address or event, and drops removed ones', async () => {
  const at = (b: number) => v2Log(F, addr(0xa), addr(0xb), addr(0xc), b);
  const inRange = new FakeChain({ head: 100, logs: [at(10), at(20)] });
  assert.deepEqual((await getLogs(new Meter(), inRange, [{ address: F, kind: 0 }], 10, 20)).map((l) => l.blockNumber), ['0xa', '0x14']);
  const extra = (l: object) => new FakeChain({ head: 100, logs: [at(15)], answer: (_lo, _hi, out) => [...out, l] });
  const base = { ...rawOf(at(15)), removed: false };
  for (const [name, l, re] of [
    ['below lo', { ...base, blockNumber: hex(9) }, /outside \[10, 20\]/],
    ['above hi', { ...base, blockNumber: hex(21) }, /outside \[10, 20\]/],
    ['no block', { ...base, blockNumber: null }, /outside/],
    ['another address', { ...base, address: addr(0xee) }, /not asked for/],
    ['another event', { ...base, topics: [topicOf('Transfer(address,address,uint256)'), ...base.topics.slice(1)] }, /not asked for/],
    ['not an object', null, /outside/],
  ] as const) await assert.rejects(getLogs(new Meter(), extra(l as object), [{ address: F, kind: 0 }], 10, 20), re, name);
  const removed = await getLogs(new Meter(), extra({ ...base, blockNumber: hex(16), removed: true }), [{ address: F, kind: 0 }], 10, 20);
  assert.deepEqual(removed.map((l) => l.blockNumber), ['0xf']);
  // The request: one address as a string, several as a list; topic0s of every kind asked, once each.
  const chain = new FakeChain({ head: 100 });
  await getLogs(new Meter(), chain, [{ address: F, kind: 1 }], 0, 1);
  await getLogs(new Meter(), chain, [{ address: F, kind: 0 }, { address: addr(0xf1), kind: 0 }, { address: HUB, kind: HUB_KIND }], 0, 1);
  const [one, many] = chain.calls.map((c) => c.params[0] as { address: unknown; topics: string[][]; fromBlock: string; toBlock: string });
  assert.deepEqual(one, { fromBlock: '0x0', toBlock: '0x1', address: F, topics: [[topicOf(SIG.v3), topicOf(SIG.slipstream)]] });
  assert.deepEqual(many.address, [F, addr(0xf1), HUB]);
  assert.deepEqual(many.topics, [[topicOf(SIG.v2), topicOf('Factory_(address,uint8,uint8)')]]);
});

// Mutant: `kind < 256 && mode < 256` -> `kind <= 256 && mode < 256` -> a Factory_ with kind 256 is admitted.
// Mutant: Hub factory topic without `/^0x0{24}/` -> a factory topic with high bytes is admitted (truncated).
// Mutant: Factory_ data `/^0x[0-9a-f]{128}$/` -> `/^0x[0-9a-f]{128}/` -> a three-word Factory_ is admitted.
test('[range] opsOf: a Hub Factory_ with kind and mode up to 255 is a factory, anything else is malformed', () => {
  const hub: Source = { address: HUB, kind: HUB_KIND };
  const fl = (kind: number, mode = 0, f = addr(0xf1)) => rawOf(factoryLog(HUB, f, kind, 40, 2, mode));
  assert.deepEqual(opsOf([hub], [fl(255, 255)]), [{ o: 'f', source: HUB, factory: addr(0xf1), kind: 255, mode: 255, block: 40, logIndex: 2 }]);
  assert.deepEqual(opsOf([hub], [fl(0)]), [{ o: 'f', source: HUB, factory: addr(0xf1), kind: 0, mode: 0, block: 40, logIndex: 2 }]);
  const m = { o: 'm', source: HUB, block: 40, logIndex: 2 };
  assert.deepEqual(opsOf([hub], [fl(256)]), [m]);
  assert.deepEqual(opsOf([hub], [fl(1, 256)]), [m]);
  assert.deepEqual(opsOf([hub], [{ ...fl(1), topics: [FACTORY_EVENT.topic0, `0x01${pad(addr(0xf1)).slice(4)}`] }]), [m]);
  assert.deepEqual(opsOf([hub], [{ ...fl(1), data: `${fl(1).data}${word(0).slice(2)}` }]), [m]);
  assert.deepEqual(opsOf([hub], [{ ...fl(1), topics: [FACTORY_EVENT.topic0] }]), [m]);
  // A creation log that does not decode is malformed, with its log index.
  assert.deepEqual(opsOf([{ address: F, kind: 0 }], [{ ...rawOf(v2Log(F, addr(0xa), addr(0xb), addr(0), 7, 9)) }]), [{ o: 'm', source: F, block: 7, logIndex: 9 }]);
});

// ---------------------------------------------------------------- symbols.ts

/** A node that answers eth_call over a FakeChain and records each aggregate3 lot (targets and calldata). */
function recordingNode(chain: FakeChain, fail?: (targets: string[]) => boolean | 'short') {
  const lots: { target: string; callData: Hex }[][] = [];
  const rpc: ChainRpc = {
    request: async (a) => {
      if (a.method !== 'eth_call') return chain.request(a);
      const c = (a.params as [{ to: string; data: Hex }])[0];
      const calls = (decodeFunctionData({ abi: MC_ABI, data: c.data }).args[0] as readonly { target: Address; callData: Hex }[]).map((x) => ({ target: x.target.toLowerCase(), callData: x.callData }));
      lots.push(calls);
      const f = fail?.(calls.map((x) => x.target));
      if (f === true) throw new Error('HTTP 413');
      const out = await chain.request(a);
      if (f === 'short') return encodeFunctionResult({ abi: MC_ABI, functionName: 'aggregate3', result: [] });
      return out;
    },
  };
  return { rpc, lots };
}
const counterCalls = (n: number): Call[] => Array.from({ length: n }, (_, i) => ({ to: addr(0x1000 + i), data: selectorOf('allPairsLength()') }));
const counterChain = (n: number) => new FakeChain({ head: 100, counters: Object.fromEntries(Array.from({ length: n }, (_, i) => [addr(0x1000 + i), i])) });

// Mutant: lot bound `i + maxPerLot` -> `i + maxPerLot - 1` -> a lot at the cap loses its last call.
// Mutant: lot step `i += maxPerLot` -> `i += maxPerLot - 1` -> a lot at the cap takes two eth_calls.
test('[range] callMany: a lot at the cap is one eth_call, cap + 1 is two, results in call order', async () => {
  for (const [n, cap, lots] of [[0, 4, 0], [1, 4, 1], [3, 4, 1], [4, 4, 1], [5, 4, 2], [8, 4, 2], [9, 4, 3], [MAX_SUBCALLS, MAX_SUBCALLS, 1], [MAX_SUBCALLS + 1, MAX_SUBCALLS, 2]] as const) {
    const chain = counterChain(n);
    const res = n === MAX_SUBCALLS || n === MAX_SUBCALLS + 1 ? await callMany(new Meter(), chain, counterCalls(n), 50) : await callMany(new Meter(), chain, counterCalls(n), 50, cap);
    assert.equal(chain.count('eth_call'), lots, `${n} calls, cap ${cap}`);
    assert.equal(res.length, n);
    assert.deepEqual(Array.from(res, wordNumber), Array.from({ length: n }, (_, i) => i), `${n} calls, cap ${cap}: results in order, no holes`);
    if (n > 0) assert.deepEqual(chain.calls.find((c) => c.method === 'eth_call')!.params[1], '0x32', 'at the block asked');
    if (n > 0) assert.equal((chain.calls.find((c) => c.method === 'eth_call')!.params[0] as { to: string }).to, MULTICALL3);
  }
});

// Mutant: `(b - a === 1 ? 3 : 1)` -> `(b - a === 1 ? 1 : 1)` -> a single call that fails twice then answers is reported failed.
// Mutant: callMany without `if (e instanceof MeterStop) throw e;` -> a spent meter becomes failed calls instead of a stop.
// Mutant: `if (res.length !== calls.length) throw` -> `if (false) throw` -> a short Multicall3 answer leaves holes.
test('[unit] callMany bisects a failing lot; one call is tried three times; a meter stop is thrown', async () => {
  const POISON = addr(0x1002).toLowerCase();
  // 4 calls, one poisoned: [0,4) fails, [0,2) ok, [2,4) fails, [2,3) x3 fails, [3,4) ok.
  const chain = counterChain(4);
  const node = recordingNode(chain, (t) => t.includes(POISON));
  const res = await callMany(new Meter(), node.rpc, counterCalls(4), 50, 4);
  assert.deepEqual(node.lots.map((l) => l.length), [4, 2, 2, 1, 1, 1, 1]);
  assert.deepEqual(res.map(wordNumber), [0, 1, null, 3]);
  assert.deepEqual(res[2], { ok: false, reason: 'call failed: HTTP 413' });
  // A single call that fails twice, then answers.
  let left = 2;
  const flaky = recordingNode(counterChain(1), () => left-- > 0);
  assert.deepEqual((await callMany(new Meter(), flaky.rpc, counterCalls(1), 50)).map(wordNumber), [0]);
  assert.equal(flaky.lots.length, 3);
  // A Multicall3 answer with fewer results than calls is an error, bisected down to single calls.
  let shortOnce = true;
  const short = recordingNode(counterChain(2), () => { const s = shortOnce; shortOnce = false; return s ? 'short' : false; });
  assert.deepEqual((await callMany(new Meter(), short.rpc, counterCalls(2), 50)).map(wordNumber), [0, 1]);
  // The meter runs out inside the bisection: a stop, not two failed calls.
  await assert.rejects(callMany(new Meter(2), recordingNode(counterChain(4), (t) => t.includes(POISON)).rpc, counterCalls(4), 50, 4), (e) => e instanceof MeterStop);
  // No Multicall3 at the block: every call fails with that reason, each single call tried three times.
  const none = new FakeChain({ head: 100, noMulticall: true });
  const r2 = await callMany(new Meter(), none, counterCalls(2), 50);
  assert.deepEqual(r2, [{ ok: false, reason: 'call failed: Multicall3 answered nothing (no code at this block?)' }, { ok: false, reason: 'call failed: Multicall3 answered nothing (no code at this block?)' }]);
  assert.equal(none.count('eth_call'), 7);
});

// Mutant: `n <= BigInt(Number.MAX_SAFE_INTEGER)` -> `<` -> 2^53 - 1 is refused.
// Mutant: wordAddress regex `/^0x0{24}[0-9a-fA-F]{40}$/` -> `/^0x[0-9a-fA-F]{64}$/` -> a word with high bytes is an address.
test('[range] wordNumber and wordAddress: one word, up to 2^53 - 1, absent is null not zero', () => {
  const ok = (data: Hex) => ({ ok: true as const, data });
  assert.equal(wordNumber(ok(word(0))), 0);
  assert.equal(wordNumber(ok(word(Number.MAX_SAFE_INTEGER))), Number.MAX_SAFE_INTEGER);
  assert.equal(wordNumber(ok(word(2n ** 53n))), null);
  assert.equal(wordNumber(ok('0x')), null);
  assert.equal(wordNumber(ok(word(1).slice(0, 64) as Hex)), null);
  assert.equal(wordNumber(ok(`${word(1)}00` as Hex)), null);
  assert.equal(wordNumber({ ok: false, reason: 'reverted' }), null);
  assert.equal(wordNumber(undefined), null);
  assert.equal(wordAddress(ok(pad('0x00000000000000000000000000000000000000AB'))), addr(0xab));
  assert.equal(wordAddress(ok(`0x01${pad(addr(0xab)).slice(4)}` as Hex)), null);
  assert.equal(wordAddress(ok('0x')), null);
});

// Mutant: decodeText bytes32 branch `if (/^0x[0-9a-fA-F]{64}$/.test(r.data)) {` -> `if (false) {` -> an old bytes32 symbol (MKR) is FAILED.
// Mutant: trailing-zero trim dropped -> decodeText('MKR' as bytes32) keeps 29 NUL bytes.
// Mutant: `symbol: s === null ? null : tokenText(s)` -> `symbol: s` -> a 1 MB symbol is stored whole.
// Mutant: `ks: s === null ? null : skeleton(s)` -> `ks: s === null ? null : s` -> the Cyrillic impostor is not keyed as USDC.
// Mutant: readTexts `r[2 * i + 1]` -> `r[2 * i]` -> name() answers are read as symbol() answers.
// Mutant: status `s === null && n === null` -> `s === null || n === null` -> a token with only a name is FAILED.
// Mutant: textOf `failed = ... ? sym.reason : null` -> `null` -> a transport failure is reported as two decode reasons.
test('[vector] hostile token text: revert, no code, bytes32, 1 MB, Cyrillic impostor, hidden characters, name only', async () => {
  const BIG = 'A'.repeat(1_000_000);
  const T = (n: number) => addr(0x2000 + n);
  const tokens = {
    [T(1)]: { symbol: 'revert' as const, name: 'revert' as const },
    [T(3)]: { symbol: { bytes32: 'MKR' }, name: { bytes32: 'Maker' } },
    [T(4)]: { symbol: { string: BIG }, name: { string: 'Big' } },
    [T(5)]: { symbol: { string: 'USDС' }, name: { string: 'USD Coin' } },
    [T(6)]: { symbol: 'revert' as const, name: { string: 'Name Only' } },
    [T(7)]: { symbol: { raw: '0x1234' as Hex }, name: { raw: '0x' as Hex } },
    [T(8)]: { symbol: { string: 'US​DC‮' }, name: { string: 'x' } },
  };
  const chain = new FakeChain({ head: 100, tokens });
  const node = recordingNode(chain);
  const list = [1, 2, 3, 4, 5, 6, 7, 8].map(T);
  const got = await readTexts(new Meter(), node.rpc, list, 77, 5);
  // Two subcalls per token, symbol() then name(), selectors from the signatures; an odd cap rounds down to whole tokens.
  assert.deepEqual(node.lots.map((l) => l.length), [4, 4, 4, 4]);
  assert.deepEqual(node.lots.flat().map((c) => c.callData), list.flatMap(() => [selectorOf('symbol()'), selectorOf('name()')]));
  const by = new Map(got.map((g) => [g.token, g]));
  assert.ok(got.every((g, i) => g.token === list[i] && g.readAtBlock === 77));
  assert.deepEqual(by.get(T(1)), { token: T(1), status: 'FAILED', reason: 'symbol: reverted; name: reverted', symbol: null, name: null, ks: null, kn: null, readAtBlock: 77 });
  assert.deepEqual(by.get(T(2)), { token: T(2), status: 'FAILED', reason: 'symbol: not a string; name: not a string', symbol: null, name: null, ks: null, kn: null, readAtBlock: 77 });
  assert.deepEqual(by.get(T(3)), { token: T(3), status: 'READ', symbol: 'MKR', name: 'Maker', ks: 'MKR', kn: 'MAKER', readAtBlock: 77 });
  assert.equal(by.get(T(4))!.symbol, `${'A'.repeat(64)}…`);
  assert.equal(by.get(T(4))!.name, 'Big');
  assert.deepEqual([by.get(T(5))!.symbol, by.get(T(5))!.ks, by.get(T(5))!.kn], ['USDС', 'USDC', 'USDCOIN']);
  assert.deepEqual(by.get(T(6)), { token: T(6), status: 'READ', symbol: null, name: 'Name Only', ks: null, kn: 'NAMEONLY', readAtBlock: 77 });
  assert.equal(by.get(T(7))!.status, 'FAILED');
  assert.equal(by.get(T(8))!.ks, 'USDC');
  assert.ok(!/[​‮]/.test(by.get(T(8))!.symbol!));
  // decodeText directly: bytes32 trimmed of trailing NULs, all-zero bytes32 is the empty string, not a word is null.
  assert.equal(decodeText({ ok: true, data: `0x${Buffer.from('MKR').toString('hex').padEnd(64, '0')}` }), 'MKR');
  assert.equal(decodeText({ ok: true, data: encodeAbiParameters([{ type: 'string' }], ['DAI']) }), 'DAI');
  assert.equal(decodeText({ ok: true, data: '0x1234' }), null);
  assert.equal(decodeText({ ok: false, reason: 'reverted' }), null);
  // A transport failure (not a revert) is reported as such.
  const none = await readTexts(new Meter(), new FakeChain({ head: 100, noMulticall: true }), [T(1)], 77);
  assert.deepEqual([none[0].status, none[0].reason], ['FAILED', 'call failed: Multicall3 answered nothing (no code at this block?)']);
  assert.deepEqual(textOf(T(1), { ok: false, reason: 'call failed: x' }, { ok: false, reason: 'reverted' }, 1).reason, 'call failed: x');
});

// ---------------------------------------------------------------- store.ts

const S = addr(0x5);
const V1 = '0x00000000000000000000000000000000000000aB' as Hex;
const cursor = (source: Address, from: number, to: number): IndexOp => ({ o: 'c', source, kind: 0, from, to, hash: null, large: false });
const venueOp = (venue: Hex, block: number, t0 = addr(0xa), t1 = addr(0xb)): IndexOp => ({ o: 'v', source: S, kind: 0, venue, t0, t1, block });

// Mutant: venues keyed `m.set(lc(op.venue), {` -> `m.set(op.venue, {` -> one venue in two letter cases counts twice.
// Mutant: malformed keyed with a running count -> the same malformed log read twice counts twice.
// Mutant: inRange `b >= c.from && b <= c.to` -> `b <= c.to` -> a venue below the cursor counts.
// Mutant: drop `v.block > op.after` -> `v.block >= op.after` -> the venue at block `after` is dropped too.
// Mutant: byToken over `v.tokens` -> `[v.tokens[0]]` -> a venue is not found by its second token.
test('[unit] materialize derives counts from distinct venues inside the cursor, and a drop removes what lies above', () => {
  const ops: IndexOp[] = [
    cursor(S, 5, 100),
    venueOp(V1, 10), venueOp(V1.toLowerCase() as Hex, 10), venueOp(addr(0xc1), 11), venueOp(addr(0xc2), 150), venueOp(addr(0xc3), 4),
    { o: 'm', source: S, block: 20, logIndex: 1 }, { o: 'm', source: S, block: 20, logIndex: 1 }, { o: 'm', source: S, block: 30, logIndex: 0 },
  ];
  const st = materialize(ops);
  assert.deepEqual(st.cursors.get(S.toLowerCase()), { source: S, kind: 0, from: 5, to: 100, hash: null, large: false, logs: 4, malformed: 2 });
  assert.equal(st.venues.get(S.toLowerCase())!.size, 4);
  assert.deepEqual(st.byToken.get(addr(0xb))!.map((v) => v.venue.toLowerCase()).sort(), [V1.toLowerCase(), addr(0xc1), addr(0xc2), addr(0xc3)].sort());
  const dropped = materialize([...ops, { o: 'd', source: S, after: 10 }]);
  assert.deepEqual(dropped.cursors.get(S.toLowerCase())!.logs, 1);
  assert.deepEqual(dropped.cursors.get(S.toLowerCase())!.malformed, 0);
  assert.deepEqual([...dropped.venues.get(S.toLowerCase())!.keys()].sort(), [V1.toLowerCase(), addr(0xc3)].sort());
  // Another source is untouched by the drop.
  const other = materialize([...ops, cursor(addr(0x6), 0, 100), { o: 'v', source: addr(0x6), kind: 0, venue: addr(0xd1), t0: addr(0xa), t1: addr(0xb), block: 50 }, { o: 'd', source: S, after: 10 }]);
  assert.equal(other.cursors.get(addr(0x6))!.logs, 1);
});

// Mutant: factory order `a.block - b.block || a.logIndex - b.logIndex` -> `a.block - b.block` -> same-block refreshes keep append order.
// Mutant: factory order -> `0` -> the last appended Factory_ wins, not the last emitted.
// Mutant: drop of Factory_ logs above `after` removed -> an orphaned Factory_ still names a kind.
test('[unit] materialize: the last emitted Factory_ of a factory gives its kind, by block then log index, not append order', () => {
  const f = (factory: Address, kind: number, block: number, logIndex: number): IndexOp => ({ o: 'f', source: HUB, factory, kind, mode: 0, block, logIndex });
  const ops: IndexOp[] = [f(addr(0xf1), 0, 50, 0), f(addr(0xf1), 5, 40, 0), f(addr(0xf2), 1, 60, 2), f(addr(0xf2), 5, 60, 1), cursor(HUB, 0, 100)];
  const st = materialize(ops);
  assert.deepEqual([st.factories.get(addr(0xf1))!.kind, st.factories.get(addr(0xf2))!.kind], [0, 1]);
  assert.equal(st.cursors.get(HUB.toLowerCase())!.logs, 4);
  const d = materialize([...ops, { o: 'd', source: HUB, after: 45 }]);
  assert.deepEqual([...d.factories.keys()], [addr(0xf1)]);
  assert.equal(d.factories.get(addr(0xf1))!.kind, 5);
  // A Factory_ outside the Hub cursor is not admitted.
  assert.equal(materialize([...ops.slice(0, 4), cursor(HUB, 0, 49)]).factories.get(addr(0xf1))!.kind, 5);
  assert.equal(materialize([...ops.slice(0, 4), cursor(HUB, 0, 49)]).factories.has(addr(0xf2)), false);
});

// Mutant: MemoryStore.load returns its own array -> a caller's push changes the store.
// Mutant: MemoryStore.append without structuredClone -> a caller's later edit of an op changes the store.
test('[unit] MemoryStore keeps its own copies, per chain', async () => {
  const s = new MemoryStore();
  const op = cursor(S, 0, 10) as Extract<IndexOp, { o: 'c' }>;
  await s.append(8453, [op]);
  op.to = 999;
  const l = await s.load(8453);
  l.push(cursor(S, 0, 1));
  assert.deepEqual(await s.load(8453), [cursor(S, 0, 10)]);
  assert.deepEqual(await s.load(1), []);
});

// Mutant: FileStore `appendFile` -> `writeFile` -> the second run rewrites the file and the first run's ops are lost.
// Mutant: torn-line `try/catch` dropped -> a crash mid-write makes the whole index unreadable.
// Mutant: ENOENT -> [] dropped -> a chain never indexed throws.
// Mutant: `if (ops.length === 0) return;` dropped -> an empty append creates the file.
test('[unit] FileStore is append-only: the first run is a prefix of the file after the second; a torn last line is ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onchain-scan-'));
  try {
    const s = new FileStore(`${dir}/idx/`);
    assert.deepEqual(await s.load(8453), []);
    await s.append(8453, []);
    await assert.rejects(stat(join(dir, 'idx', '8453.jsonl')), /ENOENT/);
    const a: IndexOp[] = [venueOp(V1, 10), cursor(S, 0, 10)];
    const b: IndexOp[] = [venueOp(addr(0xc1), 11), cursor(S, 0, 11)];
    await s.append(8453, a);
    const first = await readFile(join(dir, 'idx', '8453.jsonl'), 'utf8');
    await s.append(8453, b);
    const second = await readFile(join(dir, 'idx', '8453.jsonl'), 'utf8');
    assert.ok(second.startsWith(first) && second.length > first.length);
    assert.deepEqual(await s.load(8453), [...a, ...b]);
    assert.deepEqual(await new FileStore(dir).load(1), []);
    await appendFile(join(dir, 'idx', '8453.jsonl'), '{"o":"v","source":"0x', 'utf8');
    assert.deepEqual(await s.load(8453), [...a, ...b]);
    assert.equal(materialize(await s.load(8453)).cursors.get(S.toLowerCase())!.logs, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Mutant: n/a while red: src bug at 74eb4a9 (FileStore.append writes after a torn line; reported in A3-scan.md (c)).
// After a fix (start the append on a new line): drop that guard -> the first op of the append is glued to the torn line and lost.
// A crash leaves a torn last line; the next run appends after it. Its first op must survive.
test('[vector] FileStore: an append after a torn last line keeps every op of that append', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onchain-scan-'));
  try {
    const s = new FileStore(dir);
    const a: IndexOp[] = [venueOp(V1, 10), cursor(S, 0, 10)];
    await s.append(8453, a);
    await appendFile(join(dir, '8453.jsonl'), '{"o":"v","source":"0x', 'utf8');
    const b: IndexOp[] = [venueOp(addr(0xc1), 11), cursor(S, 0, 11)];
    await s.append(8453, b);
    assert.deepEqual(await s.load(8453), [...a, ...b]);
    assert.equal(materialize(await s.load(8453)).cursors.get(S.toLowerCase())!.logs, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Mutant: walk calls commit before fetch -> covered by the fuzz test above (commit asserts the last fetch was that chunk).
// Mutant: getLogs drops the range check -> covered above. This test: the scan over a node with a log cap.
// Mutant: down split `[a, m], [m + 1, b]` -> `[a, m], [m, b]` -> a log at block m is committed twice.
test('[fuzz] walk over getLogs on a node with a log cap commits every log of the range exactly once', async () => {
  const r = prng(0xb10c);
  for (let i = 0; i < 120; i++) {
    const blocks = new Set<number>();
    for (let k = int(r, 0, 40); k > 0; k--) blocks.add(int(r, 0, 500));
    const logs = [...blocks].map((b, k) => v2Log(F, addr(0xa), addr(0xb), addr(0x3000 + k), b, int(r, 0, 3)));
    const from = int(r, 0, 100), to = int(r, from, 500);
    const chain = new FakeChain({ head: 1000, logs, maxLogs: int(r, 1, 6) });
    const meter = new Meter(20_000);
    const seen = new Map<string, number>();
    const dir = r() < 0.5 ? 'down' : 'up';
    const res = await walk({ dir, from, to, span: int(r, 1, 600), meter, fetch: (a, b) => getLogs(meter, chain, [{ address: F, kind: 0 }], a, b), commit: async (_a, _b, l) => {
      for (const op of opsOf([{ address: F, kind: 0 }], l)) if (op.o === 'v') seen.set(op.venue, (seen.get(op.venue) ?? 0) + 1);
      return true;
    } });
    assert.deepEqual(res, { done: true }, `case ${i}`);
    const want = logs.filter((l) => l.block >= from && l.block <= to).map((l) => `0x${l.data.slice(26, 66)}`);
    assert.deepEqual([...seen.keys()].sort(), want.sort(), `case ${i}`);
    assert.ok([...seen.values()].every((n) => n === 1), `case ${i}: once each`);
  }
});
