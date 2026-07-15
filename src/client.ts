// =============================================================================
//  HTTP client — zero dependencies (native fetch). Every quote is computed
//  on-chain by the BlazePhoenix Quoter; the API is a thin mirror of the chain.
//  No API key. Open CORS. https://blazephoenix.xyz/?tab=api
// =============================================================================

import { API_BASE, resolveChain } from './constants.js';
import { memGet, memPut, resilientFetch, singleflight } from './resilience.js';
import type {
  BatchResponse, HealthResponse, ManifestResponse, QuoteRequest, QuoteResponse, QuoteTx,
} from './types.js';

export class BlazeApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BlazeApiError';
    this.code = code;
    this.status = status;
  }
}

export interface ClientOptions {
  /** Override the API origin (e.g. a mirror). Default: https://blazephoenix.xyz */
  baseUrl?: string;
  /** Custom fetch (tests, proxies). Default: globalThis.fetch. */
  fetchFn?: typeof fetch;
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
  /** Extra attempts on transient failures (network, 429, 502-504), honouring
   *  the server's retry-after. Default 2. Set 0 to disable. */
  retries?: number;
  /** Micro-cache for PREVIEW quotes (no recipient, no exact) — absorbs hot
   *  loops without serving stale execution data. Default 1000ms; 0 disables. */
  cacheTtlMs?: number;
}

function toSearch(req: QuoteRequest): URLSearchParams {
  const sp = new URLSearchParams();
  sp.set('chain', String(resolveChain(req.chain)));
  sp.set('in', req.tokenIn.trim());
  sp.set('out', req.tokenOut.trim());
  sp.set('amountIn', typeof req.amountIn === 'bigint' ? req.amountIn.toString() : String(req.amountIn).trim());
  if (req.recipient) sp.set('recipient', req.recipient);
  if (req.slippageBps !== undefined) sp.set('slippageBps', String(req.slippageBps));
  if (req.deadlineSec !== undefined) sp.set('deadlineSec', String(req.deadlineSec));
  if (req.exact) sp.set('exact', '1');
  return sp;
}

export class BlazePhoenix {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly cacheTtlMs: number;

  constructor(opts: ClientOptions = {}) {
    this.base = (opts.baseUrl ?? API_BASE).replace(/\/+$/, '');
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.retries = opts.retries ?? 2;
    this.cacheTtlMs = opts.cacheTtlMs ?? 1_000;
    if (!this.fetchFn) throw new Error('No fetch available — Node >= 18 required (or pass fetchFn)');
  }

  /** Build the GET /api/quote URL for a request (useful for logging/debugging). */
  quoteUrl(req: QuoteRequest): string {
    return `${this.base}/api/quote?${toSearch(req).toString()}`;
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await resilientFetch(this.fetchFn, `${this.base}${path}`, init, {
      retries: this.retries,
      timeoutMs: this.timeoutMs,
    });
    const body = (await res.json().catch(() => null)) as
      | (T & { ok: true })
      | { ok: false; code?: string; error?: string }
      | null;
    if (!body || typeof body !== 'object') {
      throw new BlazeApiError('bad_response', `non-JSON response (HTTP ${res.status})`, res.status);
    }
    if ('ok' in body && body.ok === false) {
      throw new BlazeApiError(body.code ?? 'error', body.error ?? 'request failed', res.status);
    }
    return body as T;
  }

  /** One quote — previewPlan computed on-chain. Throws BlazeApiError on failure.
   *  Identical concurrent calls share one request; preview quotes ride a tiny
   *  micro-cache (cacheTtlMs) so hot loops never hammer the wire. */
  async quote(req: QuoteRequest): Promise<QuoteResponse> {
    const qs = toSearch(req).toString();
    const key = `Q ${this.base}?${qs}`;
    const cacheable = !req.recipient && !req.exact && this.cacheTtlMs > 0;
    if (cacheable) {
      const hit = memGet(key, this.cacheTtlMs);
      if (hit) return hit as QuoteResponse;
    }
    const q = await singleflight(key, () => this.call<QuoteResponse>(`/api/quote?${qs}`));
    if (cacheable) memPut(key, q);
    return q;
  }

  /** Up to 10 quotes in one round-trip (screeners / arb loops).
   *  Per-item failures come back inline — the batch itself only throws on
   *  transport/validation errors. Identical concurrent batches coalesce. */
  quoteBatch(reqs: QuoteRequest[]): Promise<BatchResponse> {
    const body = JSON.stringify({
      requests: reqs.map((r) => Object.fromEntries(toSearch(r).entries())),
    });
    return singleflight(`B ${this.base} ${body}`, () =>
      this.call<BatchResponse>('/api/quote/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }));
  }

  /** Service health + per-chain live flags. Zero upstream cost server-side —
   *  poll it from your monitor as often as you like. */
  health(): Promise<HealthResponse> {
    return this.call<HealthResponse>('/api/health');
  }

  /** Machine-readable protocol manifest — near-static, cached for 1h. */
  async manifest(): Promise<ManifestResponse> {
    const key = `M ${this.base}`;
    const hit = memGet(key, 3_600_000);
    if (hit) return hit as ManifestResponse;
    const m = await singleflight(key, () => this.call<ManifestResponse>('/api/manifest'));
    memPut(key, m);
    return m;
  }
}

export interface PollOptions {
  /** Tick interval in ms (min 500, default 4000). */
  intervalMs?: number;
  onError?: (e: unknown) => void;
}

/** Poll a pair and get called back with each fresh quote — the heartbeat of a
 *  price bot in one line. Overlap-safe (a slow tick is skipped, not stacked).
 *  Returns a stop function. */
export function pollQuote(
  client: BlazePhoenix,
  req: QuoteRequest,
  onQuote: (q: QuoteResponse) => void,
  opts: PollOptions = {},
): () => void {
  const interval = Math.max(500, opts.intervalMs ?? 4_000);
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const q = await client.quote(req);
      if (!stopped) onQuote(q);
    } catch (e) {
      if (!stopped) opts.onError?.(e);
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, interval);
  return () => { stopped = true; clearInterval(timer); };
}

/** The ready-to-broadcast transaction from a quote (requires `recipient` in the
 *  request and an ERC-20 input). Throws with a precise reason otherwise. */
export function buildSwapTx(q: QuoteResponse): QuoteTx {
  if (q.tx) return q.tx;
  if (q.wrapRequired) {
    throw new Error('native ETH input: wrap to WETH first (WETH.deposit), then re-quote with in=WETH');
  }
  throw new Error('no tx in quote — pass `recipient` in the request (and check quote.canExecute)');
}

export interface DeepLinkOptions {
  chain?: number | string;
  tokenIn?: string;
  tokenOut?: string;
  /** Human units for the pay field (e.g. "0.5"). */
  amount?: string;
  tab?: 'home' | 'swap' | 'staking' | 'airdrop' | 'api';
  baseUrl?: string;
}

/** A shareable link that opens the site pre-filled — bot buttons, referral posts. */
export function deepLink(opts: DeepLinkOptions = {}): string {
  const base = (opts.baseUrl ?? API_BASE).replace(/\/+$/, '');
  const sp = new URLSearchParams();
  sp.set('tab', opts.tab ?? 'swap');
  if (opts.chain !== undefined) sp.set('chain', String(resolveChain(opts.chain)));
  if (opts.tokenIn) sp.set('in', opts.tokenIn);
  if (opts.tokenOut) sp.set('out', opts.tokenOut);
  if (opts.amount) sp.set('amt', opts.amount);
  return `${base}/?${sp.toString()}`;
}
