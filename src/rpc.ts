// =============================================================================
//  YOUR RPC — the only road to the chain.
//
//  The SDK ships no endpoints and no keys, and it never routes a read through
//  blazephoenix.xyz. Every eth_call goes from your process to your node:
//
//    rpc: 'https://your-base-node.example/KEY'            one node (its own chain)
//    rpc: ['https://node-a.example', 'https://node-b.example']   your nodes, in fallback order
//    rpc: window.ethereum                                 the user's wallet (EIP-1193)
//    rpc: http('https://…', { batch: true })              any viem Transport
//    rpc: { base: '…', 1: ['…', '…'], arbitrum: wallet }  one entry per chain
//
//  A single (non-map) source answers for whatever chain the node reports. The
//  SDK asks each node for eth_chainId once and refuses to quote a chain's
//  contracts on another chain's node — a wrong-chain read returns garbage or a
//  confusing revert, never a quote you can trust.
// =============================================================================

import {
  createPublicClient, custom, fallback, http, webSocket,
  type PublicClient, type Transport,
} from 'viem';
import { BlazeError } from './errors.js';
import { CHAINS, SUPPORTED_CHAIN_IDS, resolveChain, tryResolveChain, type SupportedChainId } from './constants.js';

/** Anything with an EIP-1193 `request` — a wallet provider, a hardware bridge… */
export interface Eip1193Like {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
}

export type RpcSource = string | readonly string[] | Eip1193Like | Transport;
export type RpcConfig = RpcSource | { readonly [chain: string]: RpcSource | undefined };

export interface TransportOptions {
  /** Per-request timeout in ms (default 10000). */
  timeoutMs?: number;
  /** Retries per endpoint on transient failures (default 2). */
  retries?: number;
  /** JSON-RPC batching on http endpoints (default false — not every provider supports it). */
  batch?: boolean;
}

const isTransport = (v: unknown): v is Transport => typeof v === 'function';
const isEip1193 = (v: unknown): v is Eip1193Like =>
  !!v && typeof v === 'object' && typeof (v as Eip1193Like).request === 'function';
const isSource = (v: unknown): v is RpcSource =>
  typeof v === 'string' || Array.isArray(v) || isTransport(v) || isEip1193(v);

/** A URL we are willing to talk to: https/wss anywhere, http/ws only on a
 *  local node (your own anvil / geth on localhost). Never javascript:, data:… */
export function isAllowedRpcUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return false; }
  if (u.protocol === 'https:' || u.protocol === 'wss:') return true;
  if (u.protocol === 'http:' || u.protocol === 'ws:') {
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  }
  return false;
}

function urlTransport(url: string, o: Required<TransportOptions>): Transport {
  if (!isAllowedRpcUrl(url)) {
    throw new BlazeError('bad_request', `refusing RPC URL "${redact(url)}": use https:// or wss:// (http/ws only for localhost)`);
  }
  const u = url.trim();
  return u.startsWith('ws')
    ? webSocket(u, { timeout: o.timeoutMs, retryCount: o.retries })
    : http(u, { timeout: o.timeoutMs, retryCount: o.retries, batch: o.batch });
}

/** Keys live in RPC URLs (…/v2/KEY). Never print them. */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 1 ? '/…' : '';
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return '<invalid url>';
  }
}

export function transportFrom(src: RpcSource, opts: TransportOptions = {}): Transport {
  const o: Required<TransportOptions> = {
    timeoutMs: opts.timeoutMs ?? 10_000,
    retries: opts.retries ?? 2,
    batch: opts.batch ?? false,
  };
  if (isTransport(src)) return src;
  if (isEip1193(src)) return custom(src, { retryCount: o.retries });
  if (typeof src === 'string') return urlTransport(src, o);
  if (Array.isArray(src)) {
    const list = (src as readonly string[]).map((u) => u.trim()).filter(Boolean);
    if (list.length === 0) throw new BlazeError('rpc_required', 'empty RPC list');
    if (list.length === 1) return urlTransport(list[0], o);
    // Retries are spent per endpoint; the fallback itself walks YOUR list.
    return fallback(list.map((u) => urlTransport(u, { ...o, retries: 0 })), { retryCount: o.retries });
  }
  throw new BlazeError('bad_request', 'unrecognised rpc value');
}

const RPC_HELP =
  'BlazePhoenix SDK 1.x runs 100% on YOUR RPC — it ships no endpoints and never reads through our servers. '
  + 'Pass `rpc` (a URL, a list of URLs, a wallet provider or a viem transport), e.g. '
  + "new BlazePhoenix({ rpc: { base: process.env.BASE_RPC_URL } }). Any provider's free tier is enough.";

interface Slot {
  source: RpcSource;
  /** undefined → a single source that serves whatever chain it reports. */
  chainId?: SupportedChainId;
  client?: PublicClient;
  verified?: Promise<number>;
}

/** Resolves chain → PublicClient over the user's configured RPC, verifying the
 *  node's chain id once per source. */
export class RpcRouter {
  private readonly perChain = new Map<SupportedChainId, Slot>();
  private readonly single?: Slot;
  private readonly opts: TransportOptions;

  constructor(config: RpcConfig | undefined, opts: TransportOptions = {}) {
    this.opts = opts;
    if (config === undefined || config === null || config === '') return;
    if (isSource(config)) {
      this.single = { source: config };
      return;
    }
    if (typeof config !== 'object') throw new BlazeError('bad_request', 'rpc must be a URL, a list, a provider, a transport or a per-chain map');
    for (const [k, v] of Object.entries(config)) {
      if (v === undefined || v === null || v === '') continue;
      const id = tryResolveChain(k);
      if (!id) throw new BlazeError('bad_request', `rpc map: unknown chain "${k}"`);
      if (!isSource(v)) throw new BlazeError('bad_request', `rpc map: bad value for chain "${k}"`);
      this.perChain.set(id, { source: v, chainId: id });
    }
  }

  /** Chains with an explicitly configured RPC (a single source reports none). */
  configuredChains(): SupportedChainId[] {
    return SUPPORTED_CHAIN_IDS.filter((id) => this.perChain.has(id));
  }

  hasAny(): boolean {
    return !!this.single || this.perChain.size > 0;
  }

  /** The chain to use when a request names none: the only configured one. */
  async defaultChain(): Promise<SupportedChainId> {
    if (this.perChain.size === 1) return [...this.perChain.keys()][0];
    if (this.single && this.perChain.size === 0) {
      const id = await this.verify(this.single);
      const c = tryResolveChain(id);
      if (!c) throw new BlazeError('rpc_chain_mismatch', `your RPC serves chain ${id}, which BlazePhoenix is not deployed on`);
      return c;
    }
    throw new BlazeError('bad_request', 'this request needs `chain` (several RPCs are configured)');
  }

  private slotFor(chainId: SupportedChainId): Slot {
    const s = this.perChain.get(chainId) ?? this.single;
    if (!s) {
      throw new BlazeError('rpc_required',
        `no RPC configured for ${CHAINS[chainId].name} (${chainId}). ${RPC_HELP}`,
        { details: { chainId } });
    }
    return s;
  }

  private clientOf(s: Slot): PublicClient {
    if (!s.client) {
      s.client = createPublicClient({ transport: transportFrom(s.source, this.opts) }) as PublicClient;
    }
    return s.client;
  }

  private verify(s: Slot): Promise<number> {
    if (!s.verified) {
      const c = this.clientOf(s);
      s.verified = c.getChainId().catch((e: unknown) => {
        s.verified = undefined; // a transient failure must not poison the slot forever
        throw new BlazeError('rpc_error', `your RPC did not answer eth_chainId: ${(e as Error)?.message ?? e}`, { cause: e });
      });
    }
    return s.verified;
  }

  /** A PublicClient for `chain`, over YOUR node, after checking it really is that chain. */
  async client(chain: SupportedChainId | number | string): Promise<PublicClient> {
    const chainId = resolveChain(chain);
    const s = this.slotFor(chainId);
    const actual = await this.verify(s);
    if (actual !== chainId) {
      throw new BlazeError('rpc_chain_mismatch',
        `your RPC serves chain ${actual}, not ${CHAINS[chainId].name} (${chainId}) — `
        + 'configure one per chain: rpc: { base: "…", eth: "…" }',
        { details: { expected: chainId, actual } });
    }
    return this.clientOf(s);
  }
}

/**
 * Read RPC configuration from environment variables (Node, Workers, CI):
 *
 *   BLAZEPHOENIX_RPC_BASE / _ETHEREUM / _OPTIMISM / _ARBITRUM / _ROBINHOOD
 *   BLAZEPHOENIX_RPC_8453 (by id works too)
 *   BLAZEPHOENIX_RPC_URL  — a single node (answers for the chain it reports)
 *
 * Each value may hold several URLs separated by commas (your fallback order).
 */
export function rpcFromEnv(env: Record<string, string | undefined> = globalEnv()): RpcConfig | undefined {
  const split = (v: string) => {
    const list = v.split(',').map((s) => s.trim()).filter(Boolean);
    return list.length === 1 ? list[0] : list;
  };
  const map: Record<string, RpcSource> = {};
  for (const id of SUPPORTED_CHAIN_IDS) {
    const v = env[`BLAZEPHOENIX_RPC_${CHAINS[id].key}`] ?? env[`BLAZEPHOENIX_RPC_${id}`];
    if (v && v.trim()) map[String(id)] = split(v);
  }
  const single = env.BLAZEPHOENIX_RPC_URL;
  if (Object.keys(map).length > 0) {
    if (single && single.trim()) {
      throw new BlazeError('bad_request',
        'set either BLAZEPHOENIX_RPC_URL (one node) or the per-chain BLAZEPHOENIX_RPC_<CHAIN> variables, not both');
    }
    return map;
  }
  return single && single.trim() ? split(single) : undefined;
}

function globalEnv(): Record<string, string | undefined> {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p?.env ?? {};
}
