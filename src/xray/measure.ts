// Pure decoder of an XRayProbe Result (port of deep-xray@8d6e81c core/measure.mjs): integer ratios in
// basis points, never a float, never a default. A quantity whose inputs were not measured is null
// ("not measured"), never 0. Taxes round UP (cautious).
// Divergences from measure.mjs (V-X1): an absent `unmeasured` field is not 0; `sellOut` is reported and a
// sale that delivers 0 wei condemns; the swap-side sell tax counts in the verdict; a wallet transfer that
// was not measured is NOT_MEASURED. roundTripLossBps stays null (V8): ETH out vs ETH in mixes trading fees and
// price impact with the tax, so the verdict never reads it.
import type { Status, Verdict } from './lattice.js';

export const PROTOCOL_FEE_BPS_V1 = 28n; // Router 1.0.0 PROTOCOL_FEE_BPS (router-BlazePhoenixRouter.sol:90)
/** Quoter 1.0.0 SAFETY_CAP_BPS (quoter-BlazePhoenixQuoter.sol:65): the most a quote's netOut under-states the output. */
export const SAFETY_CAP_BPS_V1 = 10n;
/** Two readings of the same loss, each rounded up to an integer bps, differ by at most 1 bps. */
export const ROUND_BPS = 1n;
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
  sellLaterOut: bigint | null; laterRequired: boolean;
  /** Economic tax: the seller's loss on the anchor side against the same-state quote for the same amount (V5). */
  buyEconBps: bigint | null; sellEconBps: bigint | null; sellLaterEconBps: bigint | null;
  /** The most the quotes can under-state the output: 0 at A/C (safetyBuffer read as 0), the protocol cap at B, null unknown. */
  quoteBufferBps: bigint | null;
  /** An economic tax above its token-side reading plus rounding (hidden tax), or a receiver credited above what was sent. */
  hiddenTax: boolean; overCredit: boolean;
  /** Tier B reads no token-contract balance around the transfer to the pair: its tax is a limit there, not a requirement. */
  pairTransferCovered: boolean;
  /**
   * The largest LOWER bound on a seller tax read where the tax itself is not identifiable (tier B, a token balance or the
   * pair's anchor balance that moved): the pool's delta (a swapback only adds tokens to it) or the token's own rise. Never
   * a MEASURED input; at or above maxTaxBps it condemns, because condemning on a lower bound is sound.
   */
  taxFloorBps: bigint | null; notes: string[];
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
    sellOut: null, sellLaterOk: null, sellLaterTaxSwapBps: null, sellLaterOut: null, laterRequired: false,
    buyEconBps: null, sellEconBps: null, sellLaterEconBps: null, quoteBufferBps: null, hiddenTax: false, overCredit: false,
    pairTransferCovered: true, taxFloorBps: null, notes: [] };
  // Absent is not a value (IC3): without the flags no delta can be trusted, so nothing is measured.
  if (r === null || typeof r !== 'object' || !Object.hasOwn(r, 'unmeasured') || r.unmeasured === undefined || r.unmeasured === null) {
    out.notes.push('unmeasured field absent');
    return out;
  }
  // Tier A sells the remainder at B+N (class b2); the scan's tier decides, the Result's field only as fallback.
  const t = tier ?? r.tier;
  out.laterRequired = t === 'A';
  out.pairTransferCovered = t !== 'B';
  const um = B(r.unmeasured);
  const has = (bit: bigint) => (um & bit) !== 0n;
  // A token move that credits the receiver MORE than the sender sent is fed by someone else (swapback) in the
  // same move: the delta is not the seller's tax, so it is not measured (X3), never a negative tax.
  // Compared in wei before rounding (V5-5): an over-credit below 1 bps rounds to 0 bps, never to a negative tax.
  const tax = (got: unknown, sent: unknown, what: string): bigint | null => {
    const x = lossBps(got, sent);
    if (x !== null && B(got) > B(sent)) { out.overCredit = true; out.notes.push(`${what}: receiver credited more than sent (swapback): tax not identifiable`); return null; }
    return x;
  };
  // A lower bound on a seller tax (owner decision 20/11): kept even where the tax is not identifiable.
  const floor = (x: bigint | null) => { if (x !== null && (out.taxFloorBps === null || x > out.taxFloorBps)) out.taxFloorBps = x; };
  // The token's own balance rising in a move from the seller is at least that much tax (a swapback only lowers it).
  const selfFloor = (d: unknown, sent: unknown) => { if (d !== undefined && d !== null && B(d) > 0n && B(sent ?? 0n) > 0n) floor(ceilDiv(10_000n * B(d), B(sent ?? 0n))); };
  // The pool delta of a sale is the seller's tax only when the token's own balance was read and did not move
  // (V3, X2): a self balance that rose or fell means the token taxed into itself or sold from it (swapback)
  // in the same sale, and the swapback is not separable from the tax. Absent is not 0.
  // Known limit (TIER_LIMITS.A/C): a fee paid to another wallet that DONATES tokens back into the pair in the same
  // transfer moves neither the token's own balance nor the pair's anchor balance; the pair delta then understates it.
  const anchorStill = (d: unknown): boolean => {
    if (d === undefined || d === null) { out.notes.push('transfer to the pair: pair anchor balance not measured: tax not identifiable'); return false; }
    if (B(d) !== 0n) { out.notes.push('transfer to the pair: pair anchor balance moved (swap in the same transfer): tax not identifiable'); return false; }
    return true;
  };
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
    // Router 1.0.0 (BlazePhoenixRouter.sol:410-422) takes fee = floor(P * fee / 10000) on the output, so an honest buyer
    // gets net = P - floor(P * fee / 10000) wei and D = (1 - t) * net  =>  t = 1 - D / net. Compared in wei (V5-5):
    // a buyer credited above net is fed by someone else, so the buy tax is not identifiable, never 0 or negative.
    const net = P - (P * feeBps) / 10_000n;
    if (D > net) { out.overCredit = true; out.notes.push('buy: buyer credited more than the pool sent net of the fee: tax not identifiable'); }
    else {
      out.buyTaxGrossBps = lossBps(D, P);
      out.buyTaxBps = ceilDiv(10_000n * (net - D), net);
    }
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
      // The self-balance floor needs only S and SELF read, never the pool delta (F1: a V4 first hop still condemns).
      if (!has(UM.BAL_X) && !has(UM.SELF)) selfFloor(r.sellTokenSelfDelta, S);
      // The pool delta is the seller's tax only when the token's own balance was read and did not fall (V3).
      if (!has(UM.POOL_SELL) && !has(UM.BAL_X)) {
        const x = tax(Q, S, 'sell');
        floor(x);
        if (selfStill(has(UM.SELF) ? null : r.sellTokenSelfDelta, 'sell')) out.sellTaxSwapBps = x;
      } else selfStill(has(UM.SELF) ? null : r.sellTokenSelfDelta, 'sell');
      // No round-trip guard (V8): the ETH out vs ETH in mixes the pool fees and price impact with the tax, and
      // the sell tax is read directly (sellTaxBps, sellTaxSwapBps, the later sale), so roundTripLossBps stays null.
    }
  } else out.notes.push('no sell route at this block');
  // A transfer that ran is read whatever its revert data or sent amount (V7); not run is null.
  out.transferOk = ran(r.transfer);
  if (out.transferOk && !has(UM.BAL_Y) && !has(UM.BAL_X)) out.transferTaxBps = tax(r.transferReceived ?? 0n, r.transferSent ?? 0n, 'wallet transfer');
  out.poolTransferOk = ran(r.poolTransfer);
  // The transfer to the pair is read on its own (F3): at A/C only with the token's own balance and the pair's anchor
  // balance read and still across it; tier B reads neither, so its tax there is not measured (TIER_LIMITS.B).
  if (out.poolTransferOk && !has(UM.BAL_X)) selfFloor(r.poolTransferTokenSelfDelta, r.poolTransferSent);
  if (out.poolTransferOk && !has(UM.POOL_SELL) && !has(UM.BAL_X)) {
    const x = tax(r.poolTransferReceived ?? 0n, r.poolTransferSent ?? 0n, 'transfer to the pair');
    floor(x);
    if (!out.pairTransferCovered) out.notes.push('transfer to the pair: token contract balance not read at tier B: not measured');
    else if (selfStill(r.poolTransferTokenSelfDelta, 'transfer to the pair') && anchorStill(r.poolTransferPairAnchorDelta)) out.sellTaxBps = x;
  }
  if (out.laterRequired && r.sellLater) {
    out.sellLaterOk = ran(r.sellLater);
    if (out.sellLaterOk) {
      const has3 = (k: string) => r[k] !== undefined && r[k] !== null;
      if (has3('sellLaterOut')) out.sellLaterOut = B(r.sellLaterOut);
      selfFloor(r.sellLaterTokenSelfDelta, r.sellLaterIn);
      // The later sale takes the same self-balance gate as the sale at B (X1): it must not be weaker.
      if (has3('sellLaterIn') && has3('sellLaterPoolReceived')) {
        const x = tax(r.sellLaterPoolReceived, r.sellLaterIn, 'later sell');
        floor(x);
        if (selfStill(r.sellLaterTokenSelfDelta, 'later sell')) out.sellLaterTaxSwapBps = x;
      }
    }
  }
  economics(r, out, t);
  return out;
}

/**
 * The anchor-side check (V5, owner decisions F1/F2 20/11). Each economic tax is the loss of what the actor received
 * against the quote for the same amount in the same state. It only checks one way: the token-side reading may exceed
 * it (an honest tax on a concave pair costs less than t at the anchor), it may not fall below it by more than rounding
 * (that gap is a tax hidden from the token-side reading). The reported tax is the larger of the two.
 */
function economics(r: ProbeResult, out: Measure, t: unknown): void {
  const has = (k: string) => r[k] !== undefined && r[k] !== null;
  // Compared in wei before rounding (V5-5): received above the quote for the same amount is another party's value in
  // the move, so the economic tax is not identifiable (null), never 0 or negative.
  const econ = (got: bigint | null, k: string): bigint | null => {
    if (got === null || !has(k) || B(r[k]) <= 0n) return null;
    if (got > B(r[k])) { out.overCredit = true; out.notes.push(`${k}: received more than quoted: economic tax not identifiable`); return null; }
    return lossBps(got, r[k]);
  };
  if (out.buyOk === true && out.buyTaxBps !== null && has('buyDelivered')) out.buyEconBps = econ(B(r.buyDelivered), 'buyQuotedNet');
  if (out.sellOk === true) out.sellEconBps = econ(out.sellOut, 'sellQuotedNet');
  if (out.sellLaterOk === true) out.sellLaterEconBps = econ(out.sellLaterOut, 'sellLaterQuotedNet');
  for (const [tk, ek] of [['buyTaxBps', 'buyEconBps'], ['sellTaxSwapBps', 'sellEconBps'], ['sellLaterTaxSwapBps', 'sellLaterEconBps']] as const) {
    const x = out[tk], e = out[ek];
    if (x === null || e === null) continue;
    if (e > x + ROUND_BPS) { out.hiddenTax = true; out.notes.push(`${ek} ${e} > ${tk} ${x} + ${ROUND_BPS}: tax hidden from the token-side reading`); }
    if (e > x) out[tk] = e;
  }
  // F1: at A/C every quote used must carry no safety buffer; B cannot read it and takes the protocol cap.
  if (t === 'B') out.quoteBufferBps = SAFETY_CAP_BPS_V1;
  else {
    const ks = ['buySafetyBuffer', 'sellSafetyBuffer', ...(out.laterRequired ? ['sellLaterSafetyBuffer'] : [])];
    if (ks.every((k) => has(k) && B(r[k]) === 0n)) out.quoteBufferBps = 0n;
    else out.notes.push('a quote safety buffer is not 0 or not read: the economic tax is not identifiable');
  }
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
const TAXES = ['buyTaxBps', 'sellTaxBps', 'sellTaxSwapBps', 'transferTaxBps', 'directSellTaxBps', 'sellLaterTaxSwapBps',
  'buyEconBps', 'sellEconBps', 'sellLaterEconBps', 'taxFloorBps'] as const;
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
  if (m.overCredit) return nm('receiver credited more than sent');
  if (m.hiddenTax) return nm('economic tax above the token-side reading');
  if (routeOnly) return { v: 'WARN', status: 'WARN', why: 'route', text: ROUTE_TEXT };
  if (m.buyOk !== true) return nm('buy not measured');
  if (m.sellOk !== true) return nm('sell not measured');
  if (m.transferOk === false) return { v: 'WARN', status: 'WARN', why: 'wallet transfer reverted' };
  if (m.transferOk !== true) return nm('wallet transfer not measured');
  if (m.sellOut === null) return nm('sell output not measured');
  if (m.buyTaxBps === null || (m.pairTransferCovered && m.sellTaxBps === null) || m.sellTaxSwapBps === null || m.transferTaxBps === null) return nm('a tax was not measured');
  if (m.laterRequired && (m.sellLaterOk !== true || m.sellLaterOut === null || m.sellLaterTaxSwapBps === null)) return nm('later sell not measured');
  if (m.buyEconBps === null || m.sellEconBps === null || (m.laterRequired && m.sellLaterEconBps === null)) return nm('economic tax not measured');
  if (m.quoteBufferBps === null) return nm('quote safety buffer not 0');
  // The buffer can hide up to quoteBufferBps of tax from the economic reading: the reported tax plus it stays below the cap.
  for (const k of ['buyTaxBps', 'sellTaxSwapBps', 'sellLaterTaxSwapBps'] as const) {
    const x = m[k];
    if (x !== null && x + m.quoteBufferBps >= BigInt(maxTaxBps)) return nm(`${k} ${x} + quote buffer ${m.quoteBufferBps} >= ${maxTaxBps}`);
  }
  return { v: 'MEASURED', status: 'MEASURED', why: 'buy, sell and transfers measured' };
}

export const ROUTE_TEXT = 'Selling through the BlazePhoenix Router reverted in this simulation, while a direct sale to the pool executed in the same state. This is a limit of our route, not proof that the token cannot be sold.';
