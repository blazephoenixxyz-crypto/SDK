// =============================================================================
//  Resilience core — the SDK ships the same meta-patterns the BlazePhoenix
//  edge runs, so every integration is polite and outage-proof by default:
//
//    • singleflight — identical concurrent calls share ONE request
//    • micro-TTL    — a tiny preview cache (default 1s ≈ intra-block) absorbs
//                     hot loops without ever serving stale execution data
//    • retry        — transient failures (network, 429, 502/503) retry with
//                     backoff and RESPECT the server's retry-after header
//
//  Execution-grade requests (recipient / exact=1) are never TTL-cached here,
//  mirroring the server's own red line.
//
//  The state lives in a SCOPE (any object: a client, a fetch function). Work
//  and answers are shared only inside one scope, so two clients on two nodes
//  never answer each other. Without a scope, the shared DEFAULT one is used.
// =============================================================================

interface Bucket { inflight: Map<string, Promise<unknown>>; mem: Map<string, { at: number; data: unknown }> }
let SCOPES = new WeakMap<object, Bucket>();
const DEFAULT = {};

function bucket(scope: object = DEFAULT): Bucket {
  let b = SCOPES.get(scope);
  if (!b) SCOPES.set(scope, (b = { inflight: new Map(), mem: new Map() }));
  return b;
}

/** Coalesce concurrent identical work — leader runs, followers share. */
export async function singleflight<T>(key: string, fn: () => Promise<T>, scope?: object): Promise<T> {
  const { inflight } = bucket(scope);
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const flight = fn();
  inflight.set(key, flight as Promise<unknown>);
  try {
    return await flight;
  } finally {
    inflight.delete(key);
  }
}

export function memGet(key: string, ttlMs: number, now = Date.now(), scope?: object): unknown | undefined {
  if (ttlMs <= 0) return undefined;
  const hit = bucket(scope).mem.get(key);
  return hit && now - hit.at < ttlMs ? hit.data : undefined;
}

export function memPut(key: string, data: unknown, now = Date.now(), scope?: object): void {
  const { mem } = bucket(scope);
  mem.set(key, { at: now, data });
  // Bound the cache — a long-running bot must never leak memory here.
  if (mem.size > 500) {
    const oldest = mem.keys().next().value;
    if (oldest !== undefined) mem.delete(oldest);
  }
}

export interface RetryOptions {
  /** Extra attempts after the first (default 2). */
  retries?: number;
  /** Base backoff in ms; grows ×3 per attempt with jitter (default 250). */
  backoffMs?: number;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryDelayMs(res: Response | undefined, attempt: number, base: number): number {
  const ra = Number(res?.headers.get('retry-after'));
  if (Number.isFinite(ra) && ra > 0) return Math.min(10_000, ra * 1000);
  return base * 3 ** attempt + Math.floor(Math.random() * base);
}

/** Quote reads are idempotent — transient failures deserve another shot. */
function isTransient(res: Response | undefined): boolean {
  return !res || res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
}

/** fetch with timeout + polite retries. Returns the final Response (which may
 *  still be an error status — non-transient statuses are never retried). */
export async function resilientFetch(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit | undefined,
  opts: RetryOptions = {},
): Promise<Response> {
  const { retries = 2, backoffMs = 250, timeoutMs = 15_000 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response | undefined;
    // An explicit controller + ref'd timer rather than AbortSignal.timeout():
    // the latter's timer is unref'd in Node (a hung request with nothing else
    // pending would never time out) and is missing from older browsers.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      res = await fetchFn(url, { ...init, signal: ctrl.signal });
      if (!isTransient(res)) return res;
      if (attempt === retries) return res;
    } catch (e) {
      lastErr = e;
      if (attempt === retries) throw e;
    } finally {
      clearTimeout(timer);
    }
    await sleep(retryDelayMs(res, attempt, backoffMs));
  }
  /* istanbul ignore next -- loop always returns or throws */
  throw lastErr instanceof Error ? lastErr : new Error('request failed');
}

/** Test hook. */
export function __resetResilience(): void {
  SCOPES = new WeakMap();
}
