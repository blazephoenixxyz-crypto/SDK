// Pre-filter for on-chain discovery: anyone can create a token with any ticker and a venue for it, so
// a name can match thousands of tokens. Before the Quoter measures depth, each matched token is given
// a cheap measure: the bridge-token balances its venues hold, valued at the bridge's usdValue, all
// read in the index's block. A token far below the deepest one is left out (counted, never hidden);
// a token with no measure is kept and queued last, one with an unread venue is not left out (absent is
// not zero). The final order is still the Quoter's depth: this only decides which tokens are read.
import { getAddress, type Address, type Hex } from 'viem';
import { CHAINS } from '../../constants.js';
import type { UsdValue } from '../../usd.js';
import type { ChainRpc } from './rpc.js';
import { Meter } from './rpc.js';
import { callMany, wordNumber, type Call, type CallResult } from './symbols.js';
import type { IndexMatch } from './index.js';

/** A token stays when its measure × PREFILTER_FLOOR_DIVISOR ≥ the deepest measure (0.1 %). */
export const PREFILTER_FLOOR_DIVISOR = 1_000n;

const DECIMALS = '0x313ce567';
const BALANCE_OF = '0x70a08231';
const lc = (s: string) => s.toLowerCase();

/** The bridge tokens: the chain's WETH and dollar token, and the Hub's bridges stored by the index. */
export function bridgesOf(chainId: number, hubBridges: readonly Address[] | null | undefined): Address[] {
  const c = (CHAINS as Record<number, { weth: Address; usdc: Address } | undefined>)[chainId];
  const out = new Map<string, Address>();
  for (const a of [c?.weth, c?.usdc, ...(hubBridges ?? [])]) if (a && /^0x[0-9a-fA-F]{40}$/.test(a)) out.set(lc(a), getAddress(a));
  return [...out.values()];
}

export interface PrefilterReads {
  rpc: ChainRpc;
  /** The index's block: every balance and decimals() is read there. */
  asOfBlock: number | null;
  /** Its hash: every bridge price is read in that block (EIP-1898). */
  blockHash: Hex | null;
  bridges: readonly Address[];
  balanceKinds: readonly number[];
  usdValue(token: Address, amountIn: bigint, blockHash?: Hex): Promise<UsdValue>;
}

/** Per matched token (lower case): Σ over its venues paired with a bridge of balance·price/10^dec, in
 *  dollar-token base units; a venue whose balance, decimals or price was not read does not count;
 *  null when none counted. `partial`: the tokens with an unread venue (their sum is a lower bound). */
export async function measureMatches(matches: readonly IndexMatch[], r: PrefilterReads): Promise<{ usd: Map<string, bigint | null>; partial: Set<string> }> {
  const out = new Map<string, bigint | null>(matches.map((m) => [lc(m.token), null]));
  const unread = new Set<string>();
  const done = () => ({ usd: out, partial: unread });
  const bridge = new Map(r.bridges.map((b) => [lc(b), b]));
  const pairs: { token: string; bridge: string; venue: Address }[] = [];
  for (const m of matches) for (const v of m.venues) {
    if (!r.balanceKinds.includes(v.kind) || !/^0x[0-9a-fA-F]{40}$/.test(v.venue)) continue;
    const other = v.tokens.find((t) => lc(t) !== lc(m.token));
    if (other === undefined || !bridge.has(lc(other))) continue;
    pairs.push({ token: lc(m.token), bridge: lc(other), venue: v.venue as Address });
  }
  if (pairs.length === 0 || r.asOfBlock === null || r.blockHash === null) return done();
  const used = [...new Set(pairs.map((p) => p.bridge))];
  const calls: Call[] = [
    ...used.map((b) => ({ to: bridge.get(b)!, data: DECIMALS as Hex })),
    ...pairs.map((p) => ({ to: bridge.get(p.bridge)!, data: `${BALANCE_OF}${p.venue.slice(2).toLowerCase().padStart(64, '0')}` as Hex })),
  ];
  let res: CallResult[];
  try { res = await callMany(new Meter(), r.rpc, calls, r.asOfBlock); } catch { return done(); }
  const dec = new Map<string, number>();
  used.forEach((b, i) => { const d = wordNumber(res[i]); if (d !== null && d <= 255) dec.set(b, d); });
  const price = new Map<string, bigint | null>();
  await Promise.all([...dec].map(async ([b, d]) => {
    const u = await r.usdValue(bridge.get(b)!, 10n ** BigInt(d), r.blockHash!).catch(() => null);
    price.set(b, u && u.usdValue !== null && u.usdValue > 0n ? u.usdValue : null);
  }));
  pairs.forEach((p, i) => {
    const x = res[used.length + i];
    const d = dec.get(p.bridge), px = price.get(p.bridge);
    if (!x?.ok || !/^0x[0-9a-fA-F]{64}$/.test(x.data) || d === undefined || px === null || px === undefined) { unread.add(p.token); return; }
    const usd = (BigInt(x.data) * px) / 10n ** BigInt(d);
    out.set(p.token, (out.get(p.token) ?? 0n) + usd);
  });
  return done();
}

/** prefilterPartial: the measure is a lower bound (a venue was not read), so the floor does not apply. */
export interface Queued { address: Address; proposedBy: string[]; prefilterUsd?: bigint | null; prefilterPartial?: boolean }

/** Drops what sits below 0.1 % of the deepest measure (unless includeDust), keeps the unmeasured and the
 *  partly measured, and
 *  queues by measure (unmeasured last), then number of proposers, then address. */
export function floorAndQueue<T extends Queued>(items: readonly T[], includeDust = false): { queue: T[]; belowFloor: number } {
  let deepest: bigint | null = null;
  for (const x of items) if (typeof x.prefilterUsd === 'bigint' && (deepest === null || x.prefilterUsd > deepest)) deepest = x.prefilterUsd;
  const below = (x: T) => deepest !== null && typeof x.prefilterUsd === 'bigint' && x.prefilterPartial !== true && !(x.prefilterUsd * PREFILTER_FLOOR_DIVISOR >= deepest);
  const belowFloor = items.filter(below).length;
  const kept = includeDust ? [...items] : items.filter((x) => !below(x));
  kept.sort((x, y) => {
    const a = typeof x.prefilterUsd === 'bigint' ? x.prefilterUsd : null, b = typeof y.prefilterUsd === 'bigint' ? y.prefilterUsd : null;
    if (a !== b) { if (a === null) return 1; if (b === null) return -1; return b > a ? 1 : -1; }
    return y.proposedBy.length - x.proposedBy.length || (lc(x.address) < lc(y.address) ? -1 : lc(x.address) > lc(y.address) ? 1 : 0);
  });
  return { queue: kept, belowFloor };
}
