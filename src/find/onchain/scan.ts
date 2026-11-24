// The scanner: walks a block range in chunks, newest first (down) or oldest first (up), and keeps the
// covered range contiguous. A chunk that errors (log limit, timeout, 413, transient) is split in two;
// a one-block chunk is tried three times and then the walk stops without moving past it. Each chunk
// is committed (venues, then the cursor that covers them) only AFTER its logs were read.
import type { Address, Hex } from 'viem';
import { blockOf, decodeCreation, eventsOfKind, FACTORY_EVENT, type RawLog } from './kinds.js';
import { Meter, MeterStop, toHex, why, type ChainRpc, type StopReason } from './rpc.js';
import type { CursorOp, IndexOp } from './store.js';

/** First chunk: 5 000 000 blocks passed on a measured node (the limit there was 20 s, not blocks). */
export const INITIAL_SPAN = 5_000_000;
/** A one-block chunk that errors is retried this many times, then the walk stops. */
export const ONE_BLOCK_RETRIES = 2;
/** The Hub is scanned like a source, with this pseudo-kind. */
export const HUB_KIND = -1;

export type WalkStop = StopReason | 'error' | 'caller';
export interface WalkResult { done: boolean; stop?: WalkStop; at?: number; error?: string }

export interface WalkOptions {
  dir: 'down' | 'up';
  /** The inclusive range to cover; `down` starts at `to`, `up` at `from`. */
  from: number;
  to: number;
  span?: number;
  meter: Meter;
  fetch(lo: number, hi: number): Promise<RawLog[]>;
  /** Persist one chunk; answer false to stop the walk there. */
  commit(lo: number, hi: number, logs: RawLog[]): Promise<boolean>;
}

export async function walk(o: WalkOptions): Promise<WalkResult> {
  const max = Math.max(1, o.span ?? INITIAL_SPAN);
  let span = max;
  let edge = o.dir === 'down' ? o.to : o.from;
  const stack: [number, number][] = [];
  let tries = 0;
  for (;;) {
    if (o.dir === 'down' ? edge < o.from : edge > o.to) return { done: true };
    if (stack.length === 0) stack.push(o.dir === 'down' ? [Math.max(o.from, edge - span + 1), edge] : [edge, Math.min(o.to, edge + span - 1)]);
    const [a, b] = stack[stack.length - 1];
    const stop = o.meter.exhausted();
    if (stop) return { done: false, stop };
    let logs: RawLog[];
    try {
      logs = await o.fetch(a, b);
    } catch (e) {
      if (e instanceof MeterStop) return { done: false, stop: e.reason };
      if (a === b) {
        if (++tries > ONE_BLOCK_RETRIES) return { done: false, stop: 'error', at: a, error: why(e) };
        continue;
      }
      tries = 0;
      stack.pop();
      const m = Math.floor((a + b) / 2);
      // The half next to the covered edge goes on top: the range stays contiguous.
      if (o.dir === 'down') stack.push([a, m], [m + 1, b]); else stack.push([m + 1, b], [a, m]);
      continue;
    }
    tries = 0;
    stack.pop();
    span = Math.min(max, (b - a + 1) * 2);
    edge = o.dir === 'down' ? a - 1 : b + 1;
    if (!(await o.commit(a, b, logs))) return { done: o.dir === 'down' ? edge < o.from : edge > o.to, stop: 'caller' };
  }
}

export interface Source { address: Address; kind: number }

export const topicsOf = (kind: number): Hex[] => (kind === HUB_KIND ? [FACTORY_EVENT.topic0] : eventsOfKind(kind).map((e) => e.topic0));

/** eth_getLogs for these sources over [lo, hi]. Anything but an array, or a log outside the asked
 *  range or address set, is an error (split and retried), never an empty answer. */
export async function getLogs(m: Meter, rpc: ChainRpc, sources: readonly Source[], lo: number, hi: number): Promise<RawLog[]> {
  const address = sources.map((s) => s.address);
  const topic0s = [...new Set(sources.flatMap((s) => topicsOf(s.kind)))];
  const r = await m.call<unknown>(rpc, 'eth_getLogs', [{ fromBlock: toHex(lo), toBlock: toHex(hi), address: address.length === 1 ? address[0] : address, topics: [topic0s] }]);
  if (!Array.isArray(r)) throw new Error(`eth_getLogs answered ${r === null ? 'null' : typeof r}, not a list`);
  const want = new Set(address.map((a) => a.toLowerCase()));
  const t0 = new Set(topic0s);
  for (const l of r as RawLog[]) {
    const b = blockOf(l?.blockNumber);
    if (b === null || b < lo || b > hi) throw new Error(`eth_getLogs: a log at block ${String(l?.blockNumber)} outside [${lo}, ${hi}]`);
    if (!want.has(String(l.address).toLowerCase()) || !t0.has(String(l.topics?.[0]).toLowerCase() as Hex)) throw new Error('eth_getLogs: a log of an address or event not asked for');
  }
  return (r as RawLog[]).filter((l) => l.removed !== true);
}

const idx = (l: RawLog) => (typeof l.logIndex === 'number' ? l.logIndex : typeof l.logIndex === 'string' ? parseInt(l.logIndex, 16) : 0);
const WORD = /^0x[0-9a-f]{64}$/;

/** The ops one chunk's logs produce, for the sources it was asked for. */
export function opsOf(sources: readonly Source[], logs: readonly RawLog[]): IndexOp[] {
  const byAddr = new Map(sources.map((s) => [s.address.toLowerCase(), s]));
  const ops: IndexOp[] = [];
  for (const l of logs) {
    const s = byAddr.get(String(l.address).toLowerCase())!;
    const block = blockOf(l.blockNumber)!;
    if (s.kind === HUB_KIND) {
      const f = String(l.topics[1] ?? '').toLowerCase();
      const d = String(l.data).toLowerCase();
      if (WORD.test(f) && /^0x0{24}/.test(f) && /^0x[0-9a-f]{128}$/.test(d)) {
        const kind = Number(BigInt(`0x${d.slice(2, 66)}`)), mode = Number(BigInt(`0x${d.slice(66, 130)}`));
        if (kind < 256 && mode < 256) { ops.push({ o: 'f', source: s.address, factory: `0x${f.slice(26)}` as Address, kind, mode, block, logIndex: idx(l) }); continue; }
      }
      ops.push({ o: 'm', source: s.address, block, logIndex: idx(l) });
      continue;
    }
    const v = decodeCreation(s.kind, l);
    ops.push(v
      ? { o: 'v', source: s.address, kind: s.kind, venue: v.venue, t0: v.tokens[0], t1: v.tokens[1], block }
      : { o: 'm', source: s.address, block, logIndex: idx(l) });
  }
  return ops;
}

export const cursorOp = (s: Source, from: number, to: number, hash: Hex | null, large: boolean): CursorOp => ({ o: 'c', source: s.address, kind: s.kind, from, to, hash, large });
