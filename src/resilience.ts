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
// =============================================================================

const INFLIGHT = new Map<string, Promise<unknown>>();
const MEM = new Map<string, { at: number; data: unknown }>();

/** Coalesce concurrent identical work — leader runs, followers share. */
export async function singleflight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = INFLIGHT.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const flight = fn();
  INFLIGHT.set(key, flight as Promise<unknown>);
  try {
    return await flight;
  } finally {
    INFLIGHT.delete(key);
  }
}

export function memGet(key: string, ttlMs: number, now = Date.now()): unknown | undefined {
  if (ttlMs <= 0) return undefined;
  const hit = MEM.get(key);
  return hit && now - hit.at < ttlMs ? hit.data : undefined;
}

export function memPut(key: string, data: unknown, now = Date.now()): void {
  MEM.set(key, { at: now, data });
  // Bound the cache — a long-running bot must never leak memory here.
  if (MEM.size > 500) {
    const oldest = MEM.keys().next().value;
    if (oldest !== undefined) MEM.delete(oldest);
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
    try {
      res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (!isTransient(res)) return res;
      if (attempt === retries) return res;
    } catch (e) {
      lastErr = e;
      if (attempt === retries) throw e;
    }
    await sleep(retryDelayMs(res, attempt, backoffMs));
  }
  /* istanbul ignore next -- loop always returns or throws */
  throw lastErr instanceof Error ? lastErr : new Error('request failed');
}

/** Test hook. */
export function __resetResilience(): void {
  INFLIGHT.clear();
  MEM.clear();
}
