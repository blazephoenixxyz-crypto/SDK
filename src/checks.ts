// =============================================================================
//  Phoenix Check — the deterministic verdicts every quote carries. Everything
//  is derived from the on-chain preview: no oracle, no third-party price, no
//  fabrication. Fails closed — a route that cannot execute is 'blocked'.
// =============================================================================

import type { Address, Preview, QuoteChecks, Route, Verdict } from './types.js';

export const HARD_IMPACT_BPS = 2_000; // 20% — a bad fill
export const CAUTION_IMPACT_BPS = 200; // 2%

const RANK: Record<Verdict, number> = { ok: 0, caution: 1, danger: 2, blocked: 3 };
const worst = (...v: Verdict[]): Verdict => v.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok' as Verdict);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A route whose first hop does not start in tokenIn, whose last hop does not
 *  end in tokenOut, or whose hops do not chain, is not the swap you asked for. */
export function routeIsConsistent(route: Route, tokenIn: Address, tokenOut: Address): boolean {
  const h = route.hops;
  if (h.length === 0) return false;
  if (!same(h[0].tokenIn, tokenIn) || !same(h[h.length - 1].tokenOut, tokenOut)) return false;
  for (let i = 1; i < h.length; i++) if (!same(h[i].tokenIn, h[i - 1].tokenOut)) return false;
  return h.every((hop) => hop.legs.length > 0);
}

export function phoenixCheck(pv: Preview, tokenIn: Address, tokenOut: Address): QuoteChecks {
  const impactBps = Math.min(10_000, Math.max(0, Number(pv.route.expectedImpactBps) || 0));
  const impact: Verdict = impactBps >= HARD_IMPACT_BPS ? 'danger' : impactBps >= CAUTION_IMPACT_BPS ? 'caution' : 'ok';
  const consistent = routeIsConsistent(pv.route, tokenIn, tokenOut);
  const legs = pv.route.hops.reduce((n, h) => n + h.legs.length, 0);
  const verdict: Verdict = !pv.canExecute || !consistent ? 'blocked' : worst(impact);
  return {
    verdict,
    priceImpact: {
      bps: impactBps,
      verdict: pv.canExecute ? impact : 'blocked',
      hardLineBps: HARD_IMPACT_BPS,
      cautionBps: CAUTION_IMPACT_BPS,
      note: 'Governing price impact of the on-chain route. At or above the hard line this is a bad fill.',
    },
    ironFloor: {
      enforcedOnChain: true,
      armed: pv.effectiveMinOut > 0n,
      ironFloor: pv.ironFloor,
      effectiveMinOut: pv.effectiveMinOut,
      note: 'The Router re-derives its own output floors at execution and hard-clamps them; a caller can only tighten, never relax.',
    },
    routeShape: {
      consistent,
      hops: pv.route.hops.length,
      legs,
      note: consistent
        ? 'The route starts in tokenIn, ends in tokenOut and every hop chains into the next.'
        : 'The route does not connect tokenIn to tokenOut — refused client-side.',
    },
    crossCheck: {
      basis: 'Quoter preview via eth_call on YOUR RPC',
      reproducible: true,
      note: 'Computed by the contract that settles the swap, read through your own node. Compare against an independent price source to spot depth on venues this route does not read.',
    },
    disclaimer: 'Deterministic checks derived from on-chain state, not financial advice. "blocked" is a real answer — we fail closed rather than guess.',
  };
}
