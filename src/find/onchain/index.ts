// On-chain discovery: an index of every venue the Hub's factories created, built from eth_getLogs on
// the caller's RPC and kept in an append-only store. updateIndex covers layer 1 (every small source
// from block 0, the recent window of the large ones); buildIndex also covers layer 2 (the large
// sources down to block 0). searchIndex and indexStatus only read the store.
import type { Address, Hex } from 'viem';
import { EMBEDDED_DEPLOYMENTS, isZero } from '../../deployments.js';
import type { RpcSource } from '../../rpc.js';
import { skeleton } from '../../text.js';
import { COUNTER_REQUIRED, COUNTERS, CREATION_EVENTS, HUB_CALLS } from './kinds.js';
import { chainRpc, getBlock, Meter, MeterStop, resolveTarget, toHex, why, type ChainRpc, type StopReason, type Target } from './rpc.js';
import { getLogs, HUB_KIND, cursorOp, opsOf, walk, type Source, type WalkResult } from './scan.js';
import { defaultStore, FileStore, materialize, type Cursor, type IndexOp, type IndexState, type IndexStore, type RunOp } from './store.js';
import { callMany, MULTICALL3, readTexts, transportFailed, wordAddress, wordNumber, type Call } from './symbols.js';

/** A source with more creation events than this is large: layer 1 covers only its recent window. */
export const SMALL_SOURCE_MAX = 250_000;
export const RECENT_DAYS = 7;
/** Blocks below the head taken as final when the node does not answer 'finalized'. */
export const CONFIRMATIONS = 64;
/** A cursor whose tip hash cannot be confirmed is rolled back this many blocks. */
export const REORG_DEPTH = 64;
/** Blocks over which the block time is measured to place the recent window. */
export const RATE_SAMPLE = 100_000;
/** Tokens per symbol()/name() lot; each lot is stored as soon as it is read. */
export const SYMBOL_LOT = 1_500;
export const CONCURRENCY = 4;

export interface IndexOptions {
  chainId: number;
  rpc: RpcSource | ChainRpc;
  store?: IndexStore;
  /** Default: the Hub of the live version in EMBEDDED_DEPLOYMENTS. */
  hub?: Address;
  budgetMs?: number;
  maxRequests?: number;
  smallMax?: number;
  recentDays?: number;
  confirmations?: number;
  concurrency?: number;
  span?: number;
  now?: () => number;
}

export interface Coverage {
  source: Address;
  kind: number;
  role: 'hub' | 'factory' | 'v4';
  fromBlock: number | null;
  toBlock: number | null;
  complete: boolean;
  /** Distinct venues (or Factory_ logs) plus malformed logs inside the scanned range. */
  logs: number;
  malformed: number;
  /** The source's own count at the target block; null where it has none or it did not answer. */
  counter: number | null;
  large: boolean;
}

export interface Discovery {
  mode: 'onchain';
  asOfBlock: number | null;
  complete: boolean;
  target: Omit<Target, 'timestamp'> | null;
  coverage: Coverage[];
  /** admitted: factoryCount() at the target; seen: distinct factories in Factory_ logs. */
  factories: { admitted: number | null; seen: number; match: boolean };
  tokens: { known: number; symbolRead: number; symbolFailed: number; unread: number };
  /** Factories of a kind with no creation-event row: not scanned, never counted as empty. */
  notCovered: { factory: Address; kind: number }[];
  layer2: { pending: number; done: number };
  run?: { requests: number; stopped: StopReason | null; errors: string[] };
}

export interface IndexMatch {
  token: Address;
  symbol: string | null;
  name: string | null;
  status: 'READ' | 'FAILED' | 'UNREAD';
  readAtBlock: number | null;
  venues: { source: Address; kind: number; venue: Hex; tokens: [Address, Address]; block: number }[];
}

const lc = (s: string) => s.toLowerCase();
const ZERO = '0x0000000000000000000000000000000000000000';
const SCANNED_KINDS = new Set(CREATION_EVENTS.map((e) => e.kind));

export function liveHub(chainId: number): Address | null {
  for (const v of EMBEDDED_DEPLOYMENTS.versions) {
    const h = v.status === 'live' ? (v.chains as Record<number, { hub: Address } | undefined>)[chainId]?.hub : undefined;
    if (h && !isZero(h)) return h;
  }
  return null;
}

// One run at a time per (store, chain): two runs appending to one log would interleave cursors. Every
// FileStore on one directory is one store: they write the same file.
const locks = new WeakMap<object, Map<number, Promise<unknown>>>();
const dirs = new Map<string, object>();
const lockKey = (store: IndexStore): object => {
  if (!(store instanceof FileStore)) return store;
  const d = store.dir.replace(/\/+$/, '');
  if (!dirs.has(d)) dirs.set(d, {});
  return dirs.get(d)!;
};
function exclusive<T>(store: IndexStore, chainId: number, f: () => Promise<T>): Promise<T> {
  const key = lockKey(store);
  const m = locks.get(key) ?? new Map<number, Promise<unknown>>();
  locks.set(key, m);
  const p = (m.get(chainId) ?? Promise.resolve()).then(f, f);
  m.set(chainId, p.catch(() => undefined));
  return p;
}

/** Layer 1: the Hub, every small source from block 0, the recent window of the large ones, symbols. */
export const updateIndex = (o: IndexOptions): Promise<Discovery> => run(o, false);
/** Layer 1 and layer 2: every source down to block 0. */
export const buildIndex = (o: IndexOptions): Promise<Discovery> => run(o, true);

/** What the store holds, without a request. The store does not record the smallMax a run used: pass
 *  the same one, or a source's `large` flag and `layer2` use the default (SMALL_SOURCE_MAX). */
export async function indexStatus(o: { chainId: number; store?: IndexStore; smallMax?: number }): Promise<Discovery> {
  const st = materialize(await (o.store ?? defaultStore).load(o.chainId));
  return discovery(st, null, null, o.smallMax ?? SMALL_SOURCE_MAX);
}

/** Tokens whose symbol or name has the query's skeleton, or whose address is the query. */
export async function searchIndex(o: { chainId: number; store?: IndexStore }, query: string): Promise<IndexMatch[]> {
  const st = materialize(await (o.store ?? defaultStore).load(o.chainId));
  const q = query.trim();
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(q);
  const k = skeleton(q);
  if (!isAddr && k.length === 0) return [];
  const out: IndexMatch[] = [];
  for (const [t, venues] of st.byToken) {
    const tx = st.tokens.get(t);
    if (isAddr ? t !== lc(q) : !(tx && (tx.ks === k || tx.kn === k))) continue;
    out.push({
      token: venues[0].tokens.find((a) => lc(a) === t) ?? (t as Address),
      symbol: tx?.symbol ?? null, name: tx?.name ?? null, status: tx?.status ?? 'UNREAD', readAtBlock: tx?.readAtBlock ?? null,
      venues: venues.map((v) => ({ source: v.source, kind: v.kind, venue: v.venue, tokens: [v.tokens[0], v.tokens[1]], block: v.block })),
    });
  }
  return out;
}

interface Ctx {
  o: IndexOptions;
  chainId: number;
  rpc: ChainRpc;
  m: Meter;
  all: IndexOp[];
  q: Promise<void>;
  store: IndexStore;
  errors: string[];
  stopped: StopReason | null;
  /** This run asked eth_getLogs: its logs are anchored by number, checked against the target's hash. */
  logsRead?: boolean;
}

function append(c: Ctx, ops: IndexOp[]): Promise<void> {
  if (ops.length === 0) return c.q;
  c.q = c.q.then(() => c.store.append(c.chainId, ops)).then(() => { c.all.push(...ops); });
  return c.q;
}

/** A walk's ending: a budget stop ends the run, an error is recorded and the rest goes on. */
function note(c: Ctx, what: string, r: WalkResult) {
  if (r.stop === 'budget' || r.stop === 'requests') c.stopped = r.stop;
  else if (r.stop === 'error') c.errors.push(`${what}: block ${r.at}: ${r.error}`);
}

// Every worker settles before the first failure is thrown: a worker still running would append after run released the lock.
async function inParallel<T>(items: readonly T[], n: number, f: (x: T) => Promise<void>) {
  let i = 0;
  const r = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => { while (i < items.length) await f(items[i++]); }));
  const failed = r.find((x): x is PromiseRejectedResult => x.status === 'rejected');
  if (failed) throw failed.reason;
}

async function run(o: IndexOptions, layer2: boolean): Promise<Discovery> {
  const store = o.store ?? defaultStore;
  return exclusive(store, o.chainId, async () => {
    const hub = o.hub ?? liveHub(o.chainId);
    if (!hub) throw new Error(`no live Hub for chain ${o.chainId}: pass opts.hub`);
    const c: Ctx = { o, chainId: o.chainId, rpc: chainRpc(o.rpc), m: new Meter(o.maxRequests, o.budgetMs, o.now), all: await store.load(o.chainId), q: Promise.resolve(), store, errors: [], stopped: null };
    // One Hub per (store, chain): another Hub's Factory_ logs would be taken as this Hub's factories.
    const other = c.all.find((x) => x.o === 'c' && x.kind === HUB_KIND && lc(x.source) !== lc(hub));
    if (other) throw new Error(`the store holds the index of Hub ${lc((other as { source: string }).source)} on chain ${o.chainId}: index Hub ${hub} in another store`);
    let t: Target | null = null;
    try {
      t = await resolveTarget(c.m, c.rpc, o.confirmations ?? CONFIRMATIONS);
      await body(c, hub, t, layer2);
    } catch (e) {
      if (e instanceof MeterStop) c.stopped = e.reason; else c.errors.push(why(e));
    }
    await c.q.catch((e) => { c.errors.push(`store: ${why(e)}`); });
    return discovery(materialize(c.all), t, { requests: c.m.requests, stopped: c.stopped, errors: c.errors }, o.smallMax ?? SMALL_SOURCE_MAX);
  });
}

async function body(c: Ctx, hub: Address, t: Target, layer2: boolean) {
  const { o } = c;
  const smallMax = o.smallMax ?? SMALL_SOURCE_MAX;
  const span = o.span;

  // 1. Tip check: a cursor whose tip block no longer has the stored hash (or never had one) is rolled back.
  const st0 = materialize(c.all);
  const tips = new Map<number, Hex | null>();
  for (const cur of st0.cursors.values()) if (cur.hash !== null && cur.from <= cur.to && !tips.has(cur.to)) tips.set(cur.to, null);
  for (const n of tips.keys()) tips.set(n, (await getBlock(c.m, c.rpc, n))?.hash ?? null);
  // Below the rolled-back tip the chain is taken as final, so its hash is stored and checked next
  // time (without it, a run stopped right after a rollback would roll back again on every retry).
  const fix: IndexOp[] = [];
  const kept = new Map<number, Hex | null>();
  let textsAfter = Infinity;
  for (const cur of st0.cursors.values()) {
    if (cur.from > cur.to) continue;
    if (cur.hash !== null && tips.get(cur.to) === lc(cur.hash)) continue;
    const keep = cur.to - REORG_DEPTH;
    textsAfter = Math.min(textsAfter, keep);
    fix.push({ o: 'd', source: cur.source, after: keep });
    if (keep < cur.from) { fix.push(cursorOp({ address: cur.source, kind: cur.kind }, t.target + 1, t.target, t.hash, cur.large)); continue; }
    if (!kept.has(keep)) kept.set(keep, (await getBlock(c.m, c.rpc, keep))?.hash ?? null);
    fix.push(cursorOp({ address: cur.source, kind: cur.kind }, cur.from, keep, kept.get(keep)!, cur.large));
  }
  // Token text read in the rolled-back range may come from the discarded branch: read again.
  if (textsAfter !== Infinity) fix.push({ o: 't', after: textsAfter });
  await append(c, fix);

  // 2. Multicall3 must be there: without it no counter and no symbol can be read.
  const code = await c.m.call<unknown>(c.rpc, 'eth_getCode', [MULTICALL3, toHex(t.target)]);
  const multicall = typeof code === 'string' && code !== '0x' && code.length > 2;
  if (!multicall) c.errors.push(`Multicall3 ${MULTICALL3} has no code at block ${t.target}: counters and symbols not read`);

  // 3. The Hub, scanned like a source: its Factory_ logs are the set of factories.
  const hubSrc: Source = { address: hub, kind: HUB_KIND };
  await scanSources(c, t, [hubSrc], () => 0, smallMax, span, 1);
  if (c.stopped) return;

  // 4. What the Hub and each factory say at the target.
  let st = materialize(c.all);
  const factories = [...st.factories.values()];
  const runOp: RunOp = { o: 'r', hub, head: t.head, target: t.target, hash: t.hash, by: t.by, factoryCount: null, v4PoolManager: null, bridges: null, counters: {}, failed: [] };
  if (multicall) {
    const counted = factories.filter((f) => COUNTERS[f.kind]?.length);
    const calls: Call[] = [
      { to: hub, data: HUB_CALLS.factoryCount }, { to: hub, data: HUB_CALLS.v4PoolManager }, { to: hub, data: HUB_CALLS.bridgeCount },
      ...counted.map((f) => ({ to: f.factory, data: COUNTERS[f.kind][0] })),
    ];
    const r = await callMany(c.m, c.rpc, calls, t.target);
    runOp.factoryCount = wordNumber(r[0]);
    runOp.v4PoolManager = r[1]?.ok && /^0x0{64}$/i.test(r[1].data) ? ZERO : wordAddress(r[1]);
    const nb = wordNumber(r[2]);
    ['factoryCount', 'v4PoolManager', 'bridgeCount'].forEach((k, i) => { if (!r[i]?.ok || (i !== 1 ? wordNumber(r[i]) : runOp.v4PoolManager) === null) runOp.failed.push(`${k}: ${r[i]?.ok ? 'not one word' : (r[i] as { reason: string }).reason}`); });
    // A count, or null where the factory answered that it has none (a revert, or no data); a read the
    // transport failed or that answered something else is left out: not measured, never "no counter".
    counted.forEach((f, i) => {
      const x = r[3 + i], n = wordNumber(x);
      if (n !== null || (x?.ok ? x.data === '0x' : x?.reason === 'reverted')) runOp.counters[lc(f.factory)] = n;
    });
    if (nb !== null) {
      const br = await callMany(c.m, c.rpc, Array.from({ length: Math.min(nb, 256) }, (_, i) => ({ to: hub, data: `${HUB_CALLS.bridge}${i.toString(16).padStart(64, '0')}` as Hex })), t.target);
      const bridges = br.map(wordAddress);
      runOp.bridges = bridges.every((b) => b !== null) ? (bridges as Address[]) : null;
      if (runOp.bridges === null) runOp.failed.push('bridge(i): a read did not answer an address');
    }
  } else {
    runOp.failed.push('factoryCount: no Multicall3', 'v4PoolManager: no Multicall3', 'bridgeCount: no Multicall3');
  }
  await append(c, [runOp]);

  // 5. The sources: factories of a scanned kind, and the V4 PoolManager.
  const sources: Source[] = [];
  const seen = new Set<string>();
  for (const f of factories) if (SCANNED_KINDS.has(f.kind) && !seen.has(lc(f.factory))) { seen.add(lc(f.factory)); sources.push({ address: f.factory, kind: f.kind }); }
  if (runOp.v4PoolManager && !isZero(runOp.v4PoolManager) && !seen.has(lc(runOp.v4PoolManager))) sources.push({ address: runOp.v4PoolManager, kind: 4 });
  // A source re-listed under another kind: what the old kind's filter found goes, and it is scanned anew from the target.
  const relisted = sources.filter((s) => { const k = st.cursors.get(lc(s.address)); return !!k && k.kind !== s.kind; });
  await append(c, relisted.flatMap((s): IndexOp[] => [{ o: 'd', source: s.address, after: -1 }, cursorOp(s, t.target + 1, t.target, t.hash, false)]));
  // A source the Hub no longer lists at the target (its Factory_ log went with a cut or a rollback): its
  // venues go, and it is scanned anew if listed again. A V4 PoolManager is the Hub's read, not a Factory_ log.
  const v4 = runOp.v4PoolManager;
  const unlisted = [...st.cursors.values()].filter((k) => k.from <= k.to && k.kind !== HUB_KIND && !st.factories.has(lc(k.source)) && !(k.kind === 4 && (v4 === null || lc(k.source) === lc(v4))));
  await append(c, unlisted.flatMap((k): IndexOp[] => [{ o: 'd', source: k.source, after: -1 }, cursorOp({ address: k.source, kind: k.kind }, t.target + 1, t.target, t.hash, false)]));

  // 6. Large or small: the counter decides; without one, the logs seen so far (and found during the walk).
  st = materialize(c.all);
  const isLarge = (s: Source) => {
    const n = runOp.counters[lc(s.address)];
    if (n !== null && n !== undefined) return n > smallMax;
    const cur = st.cursors.get(lc(s.address));
    return !!cur && (cur.large || cur.logs > smallMax);
  };
  let recent: number | null = null;
  const recentFloor = async (): Promise<number> => {
    if (recent !== null) return recent;
    const n = Math.min(RATE_SAMPLE, t.target);
    const b = n > 0 ? await getBlock(c.m, c.rpc, t.target - n) : null;
    const dt = b ? t.timestamp - b.timestamp : NaN;
    recent = dt > 0 ? Math.max(0, t.target - Math.ceil(((o.recentDays ?? RECENT_DAYS) * 86_400 * n) / dt)) : 0;
    if (!(dt > 0)) c.errors.push('block time not measurable: the recent window starts at block 0');
    return recent;
  };
  const large = new Set(sources.filter(isLarge).map((s) => lc(s.address)));
  if (large.size > 0 && !layer2) await recentFloor();
  const floorOf = (s: Source) => (layer2 || !large.has(lc(s.address)) ? 0 : recent ?? 0);
  // Layer 2 order: fewest estimated remaining logs first, so the most sources complete within a budget.
  const remaining = (s: Source) => { const n = runOp.counters[lc(s.address)]; const cur = st.cursors.get(lc(s.address)); return (n ?? Number.MAX_SAFE_INTEGER) - (cur?.logs ?? 0); };
  const ordered = layer2 ? [...sources].sort((a, b) => remaining(a) - remaining(b)) : sources;
  await scanSources(c, t, ordered, floorOf, smallMax, span, o.concurrency ?? CONCURRENCY, large, layer2 ? null : recentFloor);
  if (c.stopped) return;
  // getLogs asks by number: if the target's hash moved during the scan, the logs may come from another
  // branch. The tips anchored to it lose their hash, so the next run rolls them back and scans again.
  const now = c.logsRead ? (await getBlock(c.m, c.rpc, t.target))?.hash ?? null : t.hash;
  if (now === null || lc(now) !== lc(t.hash)) {
    c.errors.push(`block ${t.target}: hash ${now ?? 'not answered'} after the scan, ${t.hash} before: rescanned from block ${t.target - REORG_DEPTH} next run`);
    await append(c, [...materialize(c.all).cursors.values()].filter((k) => k.from <= k.to && k.to === t.target && k.hash !== null && lc(k.hash) === lc(t.hash)).map((k) => cursorOp({ address: k.source, kind: k.kind }, k.from, k.to, null, k.large)));
    return;
  }

  // 7. symbol() and name() of every token with no reading yet, in lots stored one by one.
  if (!multicall) return;
  st = materialize(c.all);
  // A reading the transport failed is absent, not a value: it is read again; a revert or a non-string stays.
  const unread = [...st.byToken.keys()].filter((k) => { const x = st.tokens.get(k); return k !== ZERO && (!x || transportFailed(x)); }) as Address[];
  for (let i = 0; i < unread.length; i += SYMBOL_LOT) {
    const texts = await readTexts(c.m, c.rpc, unread.slice(i, i + SYMBOL_LOT), t.target);
    await append(c, texts.map((x) => ({ o: 'k' as const, ...x })));
  }
}

/** Bring each source's cursor to [floor, target]: one grouped walk up per shared tip, then a walk down
 *  per source. A source found large during its walk down stops at the recent floor (layer 1). */
async function scanSources(
  c: Ctx, t: Target, sources: readonly Source[], floorOf: (s: Source) => number, smallMax: number, span: number | undefined, conc: number,
  large: Set<string> = new Set(), recentFloor: (() => Promise<number>) | null = null,
) {
  // A cursor above the target (the node's finalized block went back below a stored tip) is cut to the
  // target, so nothing above asOfBlock stays searchable. Every cursor, not only these sources: a factory
  // whose Factory_ log goes with the Hub's cut would otherwise keep its venues in the store.
  const cut: IndexOp[] = [];
  for (const k of materialize(c.all).cursors.values()) {
    if (k.from > k.to || k.to <= t.target) continue;
    cut.push({ o: 'd', source: k.source, after: t.target }, cursorOp({ address: k.source, kind: k.kind }, Math.min(k.from, t.target + 1), t.target, t.hash, k.large));
  }
  await append(c, cut);
  const st = materialize(c.all);
  const cur = (s: Source): Cursor | undefined => st.cursors.get(lc(s.address));
  // Up: sources sharing a tip below the target share every getLogs.
  const groups = new Map<number, Source[]>();
  for (const s of sources) { const k = cur(s); if (k && k.from <= k.to && k.to < t.target) groups.set(k.to, [...(groups.get(k.to) ?? []), s]); }
  for (const [to, group] of groups) {
    const from = new Map(group.map((s) => [lc(s.address), cur(s)!.from]));
    const r = await walk({
      dir: 'up', from: to + 1, to: t.target, span, meter: c.m,
      fetch: (lo, hi) => { c.logsRead = true; return getLogs(c.m, c.rpc, group, lo, hi); },
      commit: async (_lo, hi, logs) => {
        await append(c, [...opsOf(group, logs), ...group.map((s) => cursorOp(s, from.get(lc(s.address))!, hi, hi === t.target ? t.hash : null, large.has(lc(s.address)) || !!cur(s)?.large))]);
        return true;
      },
    });
    note(c, `walk up ${group.map((s) => s.address).join(',')}`, r);
    if (c.stopped) return;
  }
  // Down: from the cursor's low edge (or the target) to the floor, on the state the walks up left.
  const st2 = materialize(c.all);
  await inParallel(sources, conc, async (s) => {
    if (c.stopped) return;
    const k = st2.cursors.get(lc(s.address));
    let top = k && k.from <= k.to ? k.from - 1 : t.target;
    let hiEdge = k && k.from <= k.to ? k.to : null;
    let hash = k && k.from <= k.to ? k.hash : t.hash;
    let logs = k && k.from <= k.to ? k.logs : 0;
    let isL = large.has(lc(s.address)) || !!k?.large;
    let floor = floorOf(s);
    for (;;) {
      if (top < floor) return;
      let grew = false;
      const r = await walk({
        dir: 'down', from: floor, to: top, span, meter: c.m,
        fetch: (lo, hi) => { c.logsRead = true; return getLogs(c.m, c.rpc, [s], lo, hi); },
        commit: async (lo, hi, raw) => {
          const ops = opsOf([s], raw);
          logs += ops.length;
          if (hiEdge === null) hiEdge = hi;
          if (!isL && logs > smallMax) { isL = true; grew = true; }
          await append(c, [...ops, cursorOp(s, lo, hiEdge, hash, isL)]);
          top = lo - 1;
          return !grew;
        },
      });
      if (r.stop !== 'caller') { note(c, `walk down ${s.address}`, r); return; }
      // Found large while walking down: layer 1 stops at the recent window, layer 2 goes on.
      if (recentFloor) floor = Math.max(floor, await recentFloor());
    }
  });
}

function discovery(st: IndexState, t: Target | null, run: Discovery['run'] | null, smallMax: number): Discovery {
  const r = st.run;
  const target = r ? r.target : null;
  const coverage: Coverage[] = [];
  const cov = (source: Address, kind: number, role: Coverage['role']) => {
    const k = st.cursors.get(lc(source));
    const counter = r?.counters[lc(source)] ?? null;
    // A kind that may have a counter (Slipstream's kind 1) is complete without one only where the
    // factory answered that it has none: a counter that was not measured is not "none".
    const noCounter = !COUNTER_REQUIRED.has(kind) && (!COUNTERS[kind]?.length || (!!r && Object.hasOwn(r.counters, lc(source))));
    const valid = !!k && k.from <= k.to;
    const complete = valid && target !== null && k!.from === 0 && k!.to >= target && k!.malformed === 0 && (counter === null ? noCounter : k!.logs === counter);
    coverage.push({ source, kind, role, fromBlock: valid ? k!.from : null, toBlock: valid ? k!.to : null, complete, logs: k?.logs ?? 0, malformed: k?.malformed ?? 0, counter, large: !!k?.large || (counter !== null && counter > smallMax) });
  };
  if (r) cov(r.hub, HUB_KIND, 'hub');
  const notCovered: Discovery['notCovered'] = [];
  const seenSrc = new Set<string>();
  for (const f of st.factories.values()) {
    if (seenSrc.has(lc(f.factory))) continue;
    seenSrc.add(lc(f.factory));
    if (SCANNED_KINDS.has(f.kind)) cov(f.factory, f.kind, 'factory'); else notCovered.push({ factory: f.factory, kind: f.kind });
  }
  if (r?.v4PoolManager && !isZero(r.v4PoolManager) && !seenSrc.has(lc(r.v4PoolManager))) cov(r.v4PoolManager, 4, 'v4');
  let symbolRead = 0, symbolFailed = 0, unread = 0;
  for (const k of st.byToken.keys()) {
    if (k === ZERO) continue;
    const x = st.tokens.get(k);
    // A reading the transport failed measured nothing: it is unread (read again next run), not failed.
    if (!x || transportFailed(x)) unread++; else if (x.status === 'READ') symbolRead++; else symbolFailed++;
  }
  const seenF = st.factories.size;
  const admitted = r?.factoryCount ?? null;
  const match = admitted !== null && seenF === admitted;
  const large = coverage.filter((x) => x.large);
  // The target is the stored snapshot's (the one asOfBlock and complete speak of): a target this run
  // resolved but never stored a RunOp for is not reported.
  const sameRun = !!t && !!r && t.target === r.target && lc(t.hash) === lc(r.hash);
  const out: Discovery = {
    mode: 'onchain',
    asOfBlock: target,
    complete: !!r && match && coverage.length > 0 && coverage.every((x) => x.complete) && notCovered.length === 0 && unread === 0 && r.failed.length === 0,
    target: sameRun ? { head: t.head, target: t.target, hash: t.hash, by: t.by, confirmations: t.confirmations, unindexedTail: t.unindexedTail } : r ? { head: r.head, target: r.target, hash: r.hash, by: r.by, confirmations: 0, unindexedTail: r.head - r.target } : null,
    coverage,
    factories: { admitted, seen: seenF, match },
    tokens: { known: symbolRead + symbolFailed + unread, symbolRead, symbolFailed, unread },
    notCovered,
    layer2: { pending: large.filter((x) => !x.complete).length, done: large.filter((x) => x.complete).length },
  };
  if (run) out.run = run;
  return out;
}
