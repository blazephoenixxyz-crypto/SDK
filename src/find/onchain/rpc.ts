// The few JSON-RPC calls the index makes, on the caller's RPC, with a request meter (a count cap
// and a time budget) checked before every request. Nothing here ever calls fetch on its own.
import type { Hex } from 'viem';
import { scrubUrls, transportFrom, type RpcSource } from '../../rpc.js';

export interface ChainRpc {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** The caller's RPC as one request function; viem's own retries off (the scanner splits and retries). */
export function chainRpc(src: RpcSource | ChainRpc): ChainRpc {
  if (typeof src === 'object' && src !== null && !Array.isArray(src) && typeof (src as ChainRpc).request === 'function') return src as ChainRpc;
  const t = transportFrom(src as RpcSource, { retries: 0 })({ retryCount: 0 });
  return { request: (a) => t.request(a as never) };
}

export type StopReason = 'budget' | 'requests';

/** Request cap and deadline shared by one call of updateIndex/buildIndex. */
export class Meter {
  requests = 0;
  private readonly deadline: number;
  constructor(readonly maxRequests = Infinity, budgetMs = Infinity, private readonly now: () => number = Date.now) {
    this.deadline = now() + budgetMs;
  }
  /** Why no further request may start, or null. */
  exhausted(): StopReason | null {
    if (this.requests >= this.maxRequests) return 'requests';
    if (this.now() >= this.deadline) return 'budget';
    return null;
  }
  async call<T>(rpc: ChainRpc, method: string, params: unknown[]): Promise<T> {
    const stop = this.exhausted();
    if (stop) throw new MeterStop(stop);
    this.requests++;
    return (await rpc.request({ method, params })) as T;
  }
}

export class MeterStop extends Error {
  constructor(readonly reason: StopReason) { super(`stopped: ${reason}`); }
}

export const toHex = (n: number): Hex => `0x${n.toString(16)}`;
/** An error as text for results and the store: URLs redacted (a transport quotes its URL, key and all), then capped. */
export const why = (e: unknown) => scrubUrls(e instanceof Error ? e.message : String(e)).slice(0, 200);

export interface BlockRef { number: number; hash: Hex; timestamp: number }

export async function getBlock(m: Meter, rpc: ChainRpc, tag: number | 'finalized' | 'latest'): Promise<BlockRef | null> {
  const b = await m.call<{ number?: string; hash?: string; timestamp?: string } | null>(rpc, 'eth_getBlockByNumber', [typeof tag === 'number' ? toHex(tag) : tag, false]);
  if (!b || typeof b.number !== 'string' || typeof b.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(b.hash)) return null;
  const number = parseInt(b.number, 16);
  const timestamp = typeof b.timestamp === 'string' ? parseInt(b.timestamp, 16) : NaN;
  if (!Number.isSafeInteger(number) || (typeof tag === 'number' && number !== tag)) return null;
  return { number, hash: b.hash.toLowerCase() as Hex, timestamp };
}

/** The block the index runs to: 'finalized' when the node answers it, else head − confirmations. */
export interface Target { head: number; target: number; hash: Hex; timestamp: number; by: 'finalized' | 'head-confirmations'; confirmations: number; unindexedTail: number }

export async function resolveTarget(m: Meter, rpc: ChainRpc, confirmations: number): Promise<Target> {
  const headHex = await m.call<string>(rpc, 'eth_blockNumber', []);
  const head = parseInt(String(headHex), 16);
  if (!Number.isSafeInteger(head) || head < 0) throw new Error(`eth_blockNumber: not a block number (${String(headHex).slice(0, 40)})`);
  let fin: BlockRef | null = null;
  try { fin = await getBlock(m, rpc, 'finalized'); } catch (e) { if (e instanceof MeterStop) throw e; fin = null; }
  if (fin && fin.number <= head) return { head, target: fin.number, hash: fin.hash, timestamp: fin.timestamp, by: 'finalized', confirmations, unindexedTail: head - fin.number };
  const n = Math.max(0, head - confirmations);
  const b = await getBlock(m, rpc, n);
  if (!b) throw new Error(`block ${n}: the node returned no block`);
  return { head, target: n, hash: b.hash, timestamp: b.timestamp, by: 'head-confirmations', confirmations, unindexedTail: head - n };
}
