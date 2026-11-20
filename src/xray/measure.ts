// Pure decoder of an XRayProbe Result (port of deep-xray@8d6e81c core/measure.mjs): integer ratios in
// basis points, never a float, never a default. A quantity whose inputs were not measured is null
// ("not measured"), never 0. Taxes round UP (cautious); the round-trip loss rounds UP too.
// Divergences from measure.mjs (V-X1): an absent `unmeasured` field is not 0; `sellOut` is reported and a
// sale that delivers 0 wei condemns; the swap-side sell tax counts in the verdict; a wallet transfer that
// was not measured is NOT_MEASURED. roundTripLossBps is not a tax (it includes pool fees and price impact):
// it never condemns, but at or above the threshold it caps the verdict at WARN.
import type { Status, Verdict } from './lattice.js';

export const PROTOCOL_FEE_BPS_V1 = 28n; // Router 1.0.0 PROTOCOL_FEE_BPS (router-BlazePhoenixRouter.sol:90)
export const UM = { BAL_X: 1n, POOL_BUY: 2n, POOL_SELL: 4n, BAL_Y: 8n, SELF: 16n, WETH: 32n, DIRECT: 64n } as const;
const B = (v: unknown): bigint => (typeof v === 'bigint' ? v : BigInt(v as string | number));

type Step = { ok?: boolean; gas?: unknown; revertData?: string; ran?: boolean } | undefined | null;
/**
 * A step that did not run: explicit ran:false, or no `ran` and gas 0 (XRayProbe.sol:439-441 sets
 * gas = g0 - gasleft(), > 0 for any call that ran), or absent. Never read as a revert.
 */
export function notRun(st: Step): boolean {
  if (st === undefined || st === null) return true;
  if (st.ran === false) return true;
  return st.ran === undefined && st.gas !== undefined && st.gas !== null && B(st.gas) === 0n;
}
/** ok -> true, ran and failed -> false, not run -> null (not measured). */
const ran = (st: Step): boolean | null => (st?.ok === true ? true : notRun(st) ? null : false);
// Decoded probe Result (viem object); only the fields read here are typed.
export type ProbeResult = Record<string, any>;

export type Measure = {
  buyOk: boolean | null; sellOk: boolean | null; transferOk: boolean | null; poolTransferOk: boolean | null;
  buyTaxBps: bigint | null; buyTaxGrossBps: bigint | null; sellTaxBps: bigint | null; sellTaxSwapBps: bigint | null;
  transferTaxBps: bigint | null; roundTripLossBps: bigint | null; directSellOk: boolean | null;
  directSellTaxBps: bigint | null; sellOut: bigint | null; sellLaterOk: boolean | null; sellLaterTaxSwapBps: bigint | null;
  sellLaterOut: bigint | null; laterRequired: boolean; notes: string[];
};

/** ceil(n / d) for signed n, d > 0. */
export function ceilDiv(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError('d must be > 0');
  const q = n / d;
  return n % d !== 0n && n > 0n ? q + 1n : q;
}

/** 1 - got/sent in bps, rounded up; null when sent is not positive. */
export function lossBps(got: unknown, sent: unknown): bigint | null {
  const g = B(got), s = B(sent);
  if (s <= 0n) return null;
  return ceilDiv(10_000n * (s - g), s);
}

export function measure(r: ProbeResult, { feeBps = PROTOCOL_FEE_BPS_V1, tier }: { feeBps?: bigint; tier?: string | null } = {}): Measure {
  const out: Measure = { buyOk: null, sellOk: null, transferOk: null, poolTransferOk: null, buyTaxBps: null, buyTaxGrossBps: null,
    sellTaxBps: null, sellTaxSwapBps: null, transferTaxBps: null, roundTripLossBps: null, directSellOk: null, directSellTaxBps: null,
    sellOut: null, sellLaterOk: null, sellLaterTaxSwapBps: null, sellLaterOut: null, laterRequired: false, notes: [] };
  // Absent is not a value (IC3): without the flags no delta can be trusted, so nothing is measured.
  if (r === null || typeof r !== 'object' || !Object.hasOwn(r, 'unmeasured') || r.unmeasured === undefined || r.unmeasured === null) {
    out.notes.push('unmeasured field absent');
    return out;
  }
  // Tier A sells the remainder at B+N (class b2); the scan's tier decides, the Result's field only as fallback.
  out.laterRequired = (tier ?? r.tier) === 'A';
  const um = B(r.unmeasured);
  const has = (bit: bigint) => (um & bit) !== 0n;
  // A token move that credits the receiver MORE than the sender sent is fed by someone else (swapback) in the
  // same move: the delta is not the seller's tax, so it is not measured (X3), never a negative tax.
  const tax = (got: unknown, sent: unknown, what: string): bigint | null => {
    const x = lossBps(got, sent);
    if (x !== null && x < 0n) { out.notes.push(`${what}: receiver credited more than sent (swapback): tax not identifiable`); return null; }
    return x;
  };
  // The pool delta of a sale is the seller's tax only when the token's own balance was read and did not move
  // (V3, X2): a self balance that rose or fell means the token taxed into itself or sold from it (swapback)
  // in the same sale, and the swapback is not separable from the tax. Absent is not 0.
  const selfStill = (d: unknown, what: string): boolean => {
    if (d === undefined || d === null) { out.notes.push(`${what}: token contract balance not measured: swap-side tax not identifiable`); return false; }
    if (B(d) !== 0n) { out.notes.push(`${what}: token contract balance moved (tax to itself or swapback): swap-side tax not identifiable`); return false; }
    return true;
  };
  Object.assign(out, measureDirectSell(r));
  if (!r.quoteBuy?.ok) { out.notes.push('no buy route'); return out; }
  out.buyOk = ran(r.buy);
  if (out.buyOk === null) out.notes.push('buy not run');
  if (!out.buyOk) return out;
  const D = B(r.buyDelivered), P = B(r.buyPoolSent);
  if (!has(UM.POOL_BUY) && !has(UM.BAL_X) && P > 0n) {
    out.buyTaxGrossBps = lossBps(D, P);
    // D = (1 - t) * P * (1 - fee)  =>  t = 1 - D * 10000 / (P * (10000 - fee))
    out.buyTaxBps = ceilDiv(10_000n * (P * (10_000n - feeBps) - D * 10_000n), P * (10_000n - feeBps));
  } else out.notes.push('buy pool delta not measured');
  if (r.quoteSell?.ok && (r.sellHops === undefined || r.sellHops === null || B(r.sellHops) === 0n)) {
    // XRayProbe._sell returns before the sale when the quote has no hop: nothing was sold (X1-tiers-4 (a)).
    out.notes.push('no sell route (0 hops)');
  } else if (r.quoteSell?.ok) {
    out.sellOk = ran(r.sell);
    if (out.sellOk === null) out.notes.push('sell not run');
    if (out.sellOk) {
      const S = B(r.sellIn), Q = B(r.sellPoolReceived);
      // sellOut needs both the WETH and the seller's token balance (V6): unreadable is null, never 0 wei.
      if (!has(UM.WETH) && !has(UM.BAL_X)) out.sellOut = B(r.sellOut);
      // The pool delta is the seller's tax only when the token's own balance was read and did not fall (V3).
      if (selfStill(has(UM.SELF) ? null : r.sellTokenSelfDelta, 'sell') && !has(UM.POOL_SELL) && !has(UM.BAL_X)) out.sellTaxSwapBps = tax(Q, S, 'sell');
      // No round-trip guard (V8): the ETH out vs ETH in mixes the pool fees and price impact with the tax, and
      // the sell tax is read directly (sellTaxBps, sellTaxSwapBps, the later sale), so roundTripLossBps stays null.
    }
  } else out.notes.push('no sell route at this block');
  // A transfer that ran is read whatever its revert data or sent amount (V7); not run is null.
  out.transferOk = ran(r.transfer);
  if (out.transferOk && !has(UM.BAL_Y) && !has(UM.BAL_X)) out.transferTaxBps = tax(r.transferReceived ?? 0n, r.transferSent ?? 0n, 'wallet transfer');
  out.poolTransferOk = ran(r.poolTransfer);
  if (out.poolTransferOk && !has(UM.POOL_SELL) && !has(UM.BAL_X)) out.sellTaxBps = tax(r.poolTransferReceived ?? 0n, r.poolTransferSent ?? 0n, 'transfer to the pair');
  if (out.laterRequired && r.sellLater) {
    out.sellLaterOk = ran(r.sellLater);
    if (out.sellLaterOk) {
      const has3 = (k: string) => r[k] !== undefined && r[k] !== null;
      if (has3('sellLaterOut')) out.sellLaterOut = B(r.sellLaterOut);
      // The later sale takes the same self-balance gate as the sale at B (X1): it must not be weaker.
      if (has3('sellLaterIn') && has3('sellLaterPoolReceived') && selfStill(r.sellLaterTokenSelfDelta, 'later sell')) out.sellLaterTaxSwapBps = tax(r.sellLaterPoolReceived, r.sellLaterIn, 'later sell');
    }
  }
  return out;
}

/**
 * Direct sale to the pair (transfer, then pair.swap from the reserves and balance read AFTER the
 * transfer), measured in the same simulated state as the Router sale. askIn = balance(pair) - reserveIn
 * after the transfer = what the pair credits the seller. Absent = null (not measured), never a value.
 */
const ZERO_ADDR = /^0x0{40}$/i;
export function measureDirectSell(d: any): { directSellOk: boolean | null; directSellTaxBps: bigint | null } {
  const none = { directSellOk: null, directSellTaxBps: null };
  if (d === undefined || d === null) return none;
  if (!('ok' in d) || 'direct' in d || 'directPool' in d) {
    // Probe Result (decision 13). Absent field, UM_DIRECT or no pair = not measured, never a sale.
    if (!d.direct || typeof d.directPool !== 'string' || ZERO_ADDR.test(d.directPool)) return none;
    if (d.unmeasured === undefined || d.unmeasured === null || (B(d.unmeasured) & UM.DIRECT) !== 0n) return none;
    if (d.direct.ok !== true && notRun(d.direct)) return none;
    d = { ok: d.direct.ok, sent: d.directSent, askIn: d.directAskIn, wethOut: d.directOut };
  }
  const ok = d.ok === true && B(d.wethOut ?? 0) > 0n;
  return { directSellOk: ok, directSellTaxBps: ok ? lossBps(d.askIn, d.sent) : null };
}

export type InstrumentVerdict = { v: Verdict; status: Status; why: string; text?: string };
const TAXES = ['buyTaxBps', 'sellTaxBps', 'sellTaxSwapBps', 'transferTaxBps', 'directSellTaxBps', 'sellLaterTaxSwapBps'] as const;
/** maxTaxBps is the owner's number: an integer in [1, 10000] bps, refused otherwise (V4). */
export function validMaxTaxBps(x: unknown): boolean {
  return (typeof x === 'bigint' || (typeof x === 'number' && Number.isSafeInteger(x))) && BigInt(x) >= 1n && BigInt(x) <= 10_000n;
}

/**
 * The own-simulation instrument's output in the verdict lattice: CONDEMN < WARN < MEASURED.
 * Thresholds are the owner's numbers and must be passed in; the predicate is fixed here.
 */
export function instrumentVerdict(m: Measure, { maxTaxBps }: { maxTaxBps: number | bigint }): InstrumentVerdict {
  if (maxTaxBps === undefined) throw new TypeError('maxTaxBps is an owner decision: pass it');
  if (!validMaxTaxBps(maxTaxBps)) throw new RangeError('maxTaxBps must be an integer in [1, 10000]');
  const nm = (why: string): InstrumentVerdict => ({ v: 'WARN', status: 'NOT_MEASURED', why });
  // A Router-sale revert condemns unless a direct sale to the pair executed in the same state: then it
  // is a limit of our route (WARN 'route'), never MEASURED, and every check below still applies.
  const routeOnly = m.sellOk === false && m.directSellOk === true;
  if (m.sellOk === false && !routeOnly) {
    return { v: 'CONDEMN', status: 'CONDEMN', why: 'sell reverted', text: m.directSellOk === false ? 'direct pool sale reverted or delivered nothing' : 'direct pool sale not measured' };
  }
  if (m.sellOk === true && m.sellOut === 0n) return { v: 'CONDEMN', status: 'CONDEMN', why: 'sell delivered 0 wei' };
  if (m.sellLaterOk === false) return { v: 'CONDEMN', status: 'CONDEMN', why: 'later sell reverted' };
  if (m.sellLaterOk === true && m.sellLaterOut === 0n) return { v: 'CONDEMN', status: 'CONDEMN', why: 'later sell delivered 0 wei' };
  if (m.poolTransferOk === false) return { v: 'CONDEMN', status: 'CONDEMN', why: 'transfer to the pool reverted' };
  for (const k of TAXES) {
    const x = m[k];
    if (x !== undefined && x !== null && x >= BigInt(maxTaxBps)) return { v: 'CONDEMN', status: 'CONDEMN', why: `${k} ${x} >= ${maxTaxBps}` };
  }
  // A negative tax on any reading (the receiver credited more than was sent: swapback, reflection) is never
  // clean (X3); measure() already leaves the swap-side readings null, this also covers the buy and the direct sale.
  for (const k of TAXES) {
    const x = m[k];
    if (x !== undefined && x !== null && x < 0n) return nm(`${k} negative`);
  }
  if (routeOnly) return { v: 'WARN', status: 'WARN', why: 'route', text: ROUTE_TEXT };
  if (m.buyOk !== true) return nm('buy not measured');
  if (m.sellOk !== true) return nm('sell not measured');
  if (m.transferOk === false) return { v: 'WARN', status: 'WARN', why: 'wallet transfer reverted' };
  if (m.transferOk !== true) return nm('wallet transfer not measured');
  if (m.sellOut === null) return nm('sell output not measured');
  if (m.buyTaxBps === null || m.sellTaxBps === null || m.sellTaxSwapBps === null || m.transferTaxBps === null) return nm('a tax was not measured');
  if (m.laterRequired && (m.sellLaterOk !== true || m.sellLaterOut === null || m.sellLaterTaxSwapBps === null)) return nm('later sell not measured');
  return { v: 'MEASURED', status: 'MEASURED', why: 'buy, sell and transfers measured' };
}

export const ROUTE_TEXT = 'Selling through the BlazePhoenix Router reverted in this simulation, while a direct sale to the pool executed in the same state. This is a limit of our route, not proof that the token cannot be sold.';
