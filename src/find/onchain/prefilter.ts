// Pre-filter for on-chain discovery: anyone can create a token with any ticker and a venue for it, so
// a name can match thousands of tokens. Before the Quoter measures depth, each matched token is given
// a cheap measure: the bridge-token balances its venues hold, valued at the bridge's usdValue, all
// read in the index's block. A token far below the deepest one is left out (counted, never hidden);
// a token with no measure, or with a venue not read or not measurable here (a Uniswap V4 venue, a pair
// with no bridge token), is never left out (absent is not zero): it queues in its own lane, interleaved
// with the measured ones. The final order is still the Quoter's depth: this only decides which tokens are read.
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
 *  null when none counted. `partial`: the tokens with a venue that did not count, because it was not
 *  read or cannot be measured here (a kind with no balance at the venue such as Uniswap V4, a venue
 *  that is not an address, a pair with no bridge token): their sum is a lower bound. */
export async function measureMatches(matches: readonly IndexMatch[], r: PrefilterReads): Promise<{ usd: Map<string, bigint | null>; partial: Set<string> }> {
  const out = new Map<string, bigint | null>(matches.map((m) => [lc(m.token), null]));
  const unread = new Set<string>();
  const done = () => ({ usd: out, partial: unread });
  const bridge = new Map(r.bridges.map((b) => [lc(b), b]));
  const pairs: { token: string; bridge: string; venue: Address }[] = [];
  for (const m of matches) for (const v of m.venues) {
    if (!r.balanceKinds.includes(v.kind) || !/^0x[0-9a-fA-F]{40}$/.test(v.venue)) { unread.add(lc(m.token)); continue; }
    const other = v.tokens.find((t) => lc(t) !== lc(m.token));
    if (other === undefined || !bridge.has(lc(other))) { unread.add(lc(m.token)); continue; }
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

/** prefilterPartial: the measure is a lower bound (a venue did not count), so the floor does not apply.
 *  firstBlock: the block of the token's first venue in the index (null: not known). */
export interface Queued { address: Address; proposedBy: string[]; prefilterUsd?: bigint | null; prefilterPartial?: boolean; firstBlock?: number | null }

const byProposersThenAddress = (x: Queued, y: Queued) =>
  y.proposedBy.length - x.proposedBy.length || (lc(x.address) < lc(y.address) ? -1 : lc(x.address) > lc(y.address) ? 1 : 0);

/** Drops what sits below 0.1 % of the deepest measure (unless includeDust), keeps the unmeasured and the
 *  partly measured, and queues two lanes interleaved, the measured lane first, each address once:
 *  the measured (by measure, then number of proposers, then address) and the not fully measured (no
 *  measure, or a partial one) by the block of their first venue (older first, unknown last), then
 *  proposers, then address. A partly measured token sits in both lanes and is queued at its first turn.
 *  So tokens the pre-filter cannot measure keep about half the slots: a flood of cheap measured
 *  impostors cannot push them all out, and one of them cannot pick a place by its address. */
export function floorAndQueue<T extends Queued>(items: readonly T[], includeDust = false): { queue: T[]; belowFloor: number } {
  let deepest: bigint | null = null;
  for (const x of items) if (typeof x.prefilterUsd === 'bigint' && (deepest === null || x.prefilterUsd > deepest)) deepest = x.prefilterUsd;
  const below = (x: T) => deepest !== null && typeof x.prefilterUsd === 'bigint' && x.prefilterPartial !== true && !(x.prefilterUsd * PREFILTER_FLOOR_DIVISOR >= deepest);
  const belowFloor = items.filter(below).length;
  const kept = includeDust ? [...items] : items.filter((x) => !below(x));
  const measured = kept.filter((x) => typeof x.prefilterUsd === 'bigint').sort((x, y) => {
    const a = x.prefilterUsd as bigint, b = y.prefilterUsd as bigint;
    return a !== b ? (b > a ? 1 : -1) : byProposersThenAddress(x, y);
  });
  const notMeasured = kept.filter((x) => typeof x.prefilterUsd !== 'bigint' || x.prefilterPartial === true).sort((x, y) => {
    const a = x.firstBlock ?? null, b = y.firstBlock ?? null;
    if (a !== b) { if (a === null) return 1; if (b === null) return -1; return a - b; }
    return byProposersThenAddress(x, y);
  });
  const queue: T[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < Math.max(measured.length, notMeasured.length); i++) {
    for (const x of [measured[i], notMeasured[i]]) if (x !== undefined && !seen.has(lc(x.address))) { seen.add(lc(x.address)); queue.push(x); }
  }
  return { queue, belowFloor };
}
