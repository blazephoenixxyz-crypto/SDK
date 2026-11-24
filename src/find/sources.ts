// Third-party indexes that PROPOSE candidate addresses for a name or ticker. They are a point of
// trust: they decide which addresses are looked at, never what is said about one (every field of
// a candidate is read on the caller's RPC). A failed source is listed, never hidden.
import { resilientFetch, type RetryOptions } from '../resilience.js';
import { skeleton } from '../text.js';

export interface SourceStatus { name: 'onchain' | 'coingecko' | 'dexscreener'; ok: boolean; error?: string; note?: string }
export interface Proposal { address: string; source: SourceStatus['name'] }

/** CoinGecko platform ids per chain; a chain without one is not searched there. */
export const COINGECKO_PLATFORM: Readonly<Record<number, string>> = { 1: 'ethereum', 8453: 'base', 10: 'optimistic-ethereum', 42161: 'arbitrum-one' };
/** Dexscreener chain ids per chain. */
export const DEXSCREENER_CHAIN: Readonly<Record<number, string>> = { 1: 'ethereum', 8453: 'base', 10: 'optimism', 42161: 'arbitrum' };
/** At most this many CoinGecko coins are looked up for their address (one request each). */
export const COINGECKO_COIN_CAP = 5;

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const RETRY: RetryOptions = { retries: 1, timeoutMs: 10_000 };

async function getJson(fetchFn: typeof fetch, url: string): Promise<any> {
  const res = await resilientFetch(fetchFn, url, { headers: { accept: 'application/json' } }, RETRY);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // resilientFetch stops its timer at the headers: the body gets the same deadline, so an index
  // that stalls its body fails by name instead of holding the whole lookup.
  const ms = RETRY.timeoutMs!;
  const body = res.json();
  body.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`body not read within ${ms} ms`)), ms); });
  try { return await Promise.race([body, late]); } finally { clearTimeout(timer); }
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/** Does a source's symbol or name read as the query (same skeleton)? Lookalikes match on purpose:
 *  an impostor is listed with its warning rather than hidden. */
export function matchesQuery(query: string, ...texts: unknown[]): boolean {
  const q = skeleton(query);
  return q.length > 0 && texts.some((t) => skeleton(t) === q);
}

export async function fromCoinGecko(fetchFn: typeof fetch, query: string, chainId: number): Promise<{ status: SourceStatus; proposals: Proposal[] }> {
  const name = 'coingecko' as const;
  const platform = COINGECKO_PLATFORM[chainId];
  if (platform === undefined) return { status: { name, ok: false, error: `no CoinGecko platform id for chain ${chainId}` }, proposals: [] };
  let coins: any[];
  try {
    const j = await getJson(fetchFn, `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`);
    if (!Array.isArray(j?.coins)) throw new Error('answer without a coins list');
    coins = j.coins.filter((c: any) => typeof c?.id === 'string' && matchesQuery(query, c.symbol, c.name));
  } catch (e) {
    return { status: { name, ok: false, error: why(e) }, proposals: [] };
  }
  const looked = coins.slice(0, COINGECKO_COIN_CAP);
  const proposals: Proposal[] = [];
  let failed = 0;
  await Promise.all(looked.map(async (c) => {
    try {
      const d = await getJson(fetchFn, `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(c.id)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`);
      const a = d?.platforms?.[platform];
      if (typeof a === 'string' && ADDR.test(a)) proposals.push({ address: a, source: name });
    } catch { failed++; }
  }));
  const notes: string[] = [];
  if (coins.length > looked.length) notes.push(`${looked.length} of ${coins.length} matching coins looked up`);
  if (failed > 0) notes.push(`${failed} coin lookups failed`);
  return { status: { name, ok: true, ...(notes.length ? { note: notes.join('; ') } : {}) }, proposals };
}

export async function fromDexscreener(fetchFn: typeof fetch, query: string, chainId: number): Promise<{ status: SourceStatus; proposals: Proposal[] }> {
  const name = 'dexscreener' as const;
  const chain = DEXSCREENER_CHAIN[chainId];
  if (chain === undefined) return { status: { name, ok: false, error: `no Dexscreener chain id for chain ${chainId}` }, proposals: [] };
  try {
    const j = await getJson(fetchFn, `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`);
    if (!Array.isArray(j?.pairs)) throw new Error('answer without a pairs list');
    const proposals: Proposal[] = [];
    for (const p of j.pairs) {
      if (p?.chainId !== chain) continue;
      for (const t of [p.baseToken, p.quoteToken])
        if (typeof t?.address === 'string' && ADDR.test(t.address) && matchesQuery(query, t.symbol, t.name)) proposals.push({ address: t.address, source: name });
    }
    return { status: { name, ok: true }, proposals };
  } catch (e) {
    return { status: { name, ok: false, error: why(e) }, proposals: [] };
  }
}
