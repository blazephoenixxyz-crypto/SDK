// A chain in memory for the on-chain index: blocks with a hash and a 2 s timestamp, creation logs,
// a Hub, factory counters, tokens (some hostile) and Multicall3, behind one EIP-1193 request(). Knobs
// play the nodes the scanner must survive: a log cap, ranges that fail, null answers, silent cuts,
// logs outside the asked range, no 'finalized' tag, no Multicall3. No network.
import { createHash } from 'node:crypto';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi, type Address, type Hex } from 'viem';
import { MULTICALL3 } from '../../src/find/onchain/symbols.js';
import { CREATION_EVENTS, FACTORY_EVENT, HUB_CALLS } from '../../src/find/onchain/kinds.js';

const MC_ABI = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }', 'function aggregate3(Call3[] calls) payable returns (Result[] returnData)']);
const lc = (s: string) => s.toLowerCase();
export const hex = (n: number | bigint): Hex => `0x${n.toString(16)}`;
export const word = (n: number | bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;
export const pad = (a: string): Hex => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
export const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;

export interface FakeLog { address: Address; topics: Hex[]; data: Hex; block: number; logIndex: number }
/** A token's answer to symbol() or name(). */
export type TextAnswer = { string: string } | { bytes32: string } | { raw: Hex } | 'revert';
export interface FakeToken { symbol?: TextAnswer; name?: TextAnswer }

const row = (kind: number, sig: string) => CREATION_EVENTS.find((e) => e.kind === kind && e.signature.startsWith(sig))!;
/** A Uniswap V2 PairCreated. */
export const v2Log = (factory: Address, t0: Address, t1: Address, pair: Address, block: number, logIndex = 0, n = 1): FakeLog =>
  ({ address: factory, topics: [row(0, 'PairCreated').topic0, pad(t0), pad(t1)], data: `${pad(pair)}${word(n).slice(2)}` as Hex, block, logIndex });
/** A Uniswap V3 PoolCreated (fee indexed, data = tickSpacing, venue). */
export const v3Log = (factory: Address, t0: Address, t1: Address, venue: Address, block: number, logIndex = 0): FakeLog =>
  ({ address: factory, topics: [row(1, 'PoolCreated(address,address,uint24').topic0, pad(t0), pad(t1), word(500)], data: `${word(10)}${pad(venue).slice(2)}` as Hex, block, logIndex });
/** A V4 Initialize: the PoolId is topic 1, the currencies topics 2 and 3. */
export const v4Log = (pm: Address, id: Hex, c0: Address, c1: Address, block: number, logIndex = 0): FakeLog =>
  ({ address: pm, topics: [row(4, 'Initialize').topic0, id, pad(c0), pad(c1)], data: `0x${'00'.repeat(32 * 5)}` as Hex, block, logIndex });
/** The Hub's Factory_(factory, kind, mode). */
export const factoryLog = (hub: Address, factory: Address, kind: number, block: number, logIndex = 0, mode = 0): FakeLog =>
  ({ address: hub, topics: [FACTORY_EVENT.topic0, pad(factory)], data: `${word(kind)}${word(mode).slice(2)}` as Hex, block, logIndex });

export interface FakeChainOptions {
  head: number;
  /** The block 'finalized' answers; null: the node rejects the tag. */
  finalized?: number | null;
  logs?: FakeLog[];
  hub?: Address;
  factoryCount?: number | 'revert';
  v4PoolManager?: Address;
  bridges?: Address[];
  /** factory (any case) → allPairsLength/allPoolsLength */
  counters?: Record<string, number>;
  tokens?: Record<string, FakeToken>;
  /** An answer with more logs than this is an error ("query returned more than N results"). */
  maxLogs?: number;
  /** A getLogs whose range holds one of these blocks fails this many times (Infinity: always). */
  failBlocks?: Map<number, number>;
  /** Rewrite a getLogs answer (null, a cut, a log outside the range...). */
  answer?: (lo: number, hi: number, logs: object[]) => unknown;
  noMulticall?: boolean;
  /** Blocks per second (timestamp = 2 s per block by default). */
  blockTime?: number;
}

export class FakeChain {
  head: number;
  finalized: number | null;
  logs: FakeLog[];
  readonly calls: { method: string; params: unknown[] }[] = [];
  private readonly salt = new Map<number, string>();
  constructor(public o: FakeChainOptions) {
    this.head = o.head;
    this.finalized = o.finalized === undefined ? null : o.finalized;
    this.logs = [...(o.logs ?? [])];
  }
  hashOf(n: number): Hex {
    let s = 'a';
    for (const [from, x] of this.salt) if (n >= from) s = x;
    return `0x${createHash('sha256').update(`${s}:${n}`).digest('hex')}`;
  }
  /** Blocks from `from` up get new hashes, and their logs are replaced by `logs`. */
  reorg(from: number, salt: string, logs: FakeLog[]) {
    this.salt.set(from, salt);
    this.logs = [...this.logs.filter((l) => l.block < from), ...logs];
  }
  count(method: string) { return this.calls.filter((c) => c.method === method).length; }
  getLogsRanges() { return this.calls.filter((c) => c.method === 'eth_getLogs').map((c) => { const f = c.params[0] as { fromBlock: string; toBlock: string }; return [parseInt(f.fromBlock, 16), parseInt(f.toBlock, 16)] as const; }); }

  async request({ method, params = [] }: { method: string; params?: unknown[] }): Promise<unknown> {
    this.calls.push({ method, params });
    const o = this.o;
    switch (method) {
      case 'eth_blockNumber': return hex(this.head);
      case 'eth_getBlockByNumber': {
        const tag = params[0] as string;
        const n = tag === 'finalized' ? this.finalized : tag === 'latest' ? this.head : parseInt(tag, 16);
        if (n === null) throw new Error("invalid block tag 'finalized'");
        if (n > this.head) return null;
        return { number: hex(n), hash: this.hashOf(n), timestamp: hex(1_700_000_000 + n * (o.blockTime ?? 2)) };
      }
      case 'eth_getCode': return lc(params[0] as string) === lc(MULTICALL3) && !o.noMulticall ? '0x6080604052' : '0x';
      case 'eth_getLogs': {
        const f = params[0] as { fromBlock: string; toBlock: string; address: string | string[]; topics: string[][] };
        const lo = parseInt(f.fromBlock, 16), hi = parseInt(f.toBlock, 16);
        for (const [b, n] of o.failBlocks ?? []) if (b >= lo && b <= hi && n > 0) { o.failBlocks!.set(b, n - 1); throw new Error(`timeout at ${b}`); }
        const want = new Set((Array.isArray(f.address) ? f.address : [f.address]).map(lc));
        const t0 = new Set(f.topics[0].map(lc));
        const out = this.logs.filter((l) => l.block >= lo && l.block <= hi && want.has(lc(l.address)) && t0.has(lc(l.topics[0])))
          .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
          .map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: hex(l.block), logIndex: hex(l.logIndex), blockHash: this.hashOf(l.block), removed: false }));
        if (o.maxLogs !== undefined && out.length > o.maxLogs) throw new Error(`query returned more than ${o.maxLogs} results`);
        return o.answer ? o.answer(lo, hi, out) : out;
      }
      case 'eth_call': {
        const c = params[0] as { to: string; data: Hex };
        if (lc(c.to) !== lc(MULTICALL3) || o.noMulticall) return '0x';
        const { args } = decodeFunctionData({ abi: MC_ABI, data: c.data });
        const res = (args[0] as readonly { target: Address; callData: Hex }[]).map((x) => this.sub(x.target, x.callData));
        return encodeFunctionResult({ abi: MC_ABI, functionName: 'aggregate3', result: res });
      }
      default: throw new Error(`method ${method} not faked`);
    }
  }

  private sub(to: Address, data: Hex): { success: boolean; returnData: Hex } {
    const o = this.o, sel = data.slice(0, 10), ok = (d: Hex) => ({ success: true, returnData: d }), revert = { success: false, returnData: '0x' as Hex };
    if (o.hub && lc(to) === lc(o.hub)) {
      if (sel === HUB_CALLS.factoryCount) return o.factoryCount === 'revert' || o.factoryCount === undefined ? revert : ok(word(o.factoryCount));
      if (sel === HUB_CALLS.v4PoolManager) return ok(pad(o.v4PoolManager ?? addr(0)));
      if (sel === HUB_CALLS.bridgeCount) return ok(word(o.bridges?.length ?? 0));
      if (sel === HUB_CALLS.bridge) { const b = o.bridges?.[Number(BigInt(`0x${data.slice(10)}`))]; return b ? ok(pad(b)) : revert; }
      return revert;
    }
    const n = Object.entries(o.counters ?? {}).find(([k]) => lc(k) === lc(to));
    if (n && (sel === '0x574f2ba3' || sel === '0xefde4e64')) return ok(word(n[1]));
    const t = Object.entries(o.tokens ?? {}).find(([k]) => lc(k) === lc(to))?.[1];
    if (t && (sel === '0x95d89b41' || sel === '0x06fdde03')) {
      const a = sel === '0x95d89b41' ? t.symbol : t.name;
      if (a === undefined || a === 'revert') return revert;
      if ('string' in a) return ok(encodeAbiParameters([{ type: 'string' }], [a.string]));
      if ('bytes32' in a) return ok(`0x${Buffer.from(a.bytes32).toString('hex').padEnd(64, '0')}`);
      return ok(a.raw);
    }
    // An address with no code answers success and no data, as on a real node.
    return ok('0x');
  }
}
