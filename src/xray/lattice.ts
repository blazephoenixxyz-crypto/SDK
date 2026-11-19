// Verdict lattice: CONDEMN < WARN < MEASURED. One producer: every verdict in src/xray/ is a meet() here.
// Unknown values (including prototype keys such as 'toString') are WARN, never MEASURED (IC3).

export type Verdict = 'CONDEMN' | 'WARN' | 'MEASURED';
export type Status = Verdict | 'NOT_MEASURED';

const RANK: ReadonlyMap<string, number> = new Map([['CONDEMN', 0], ['WARN', 1], ['MEASURED', 2]]);

/** Mandatory instruments R: own simulation, the Quoter and the wallet transfer (V-X1-2 (ii)). Fixed here, not by the caller (IC4). */
export const REQUIRED = ['sim', 'quoter', 'transfer'] as const;

/** Any value outside the lattice reads WARN. */
export function normalize(x: unknown): Verdict {
  return typeof x === 'string' && RANK.has(x) ? (x as Verdict) : 'WARN';
}

/** Infimum of two values; order independent. */
export function meet(a: unknown, b: unknown): Verdict {
  const x = normalize(a), y = normalize(b);
  return RANK.get(x)! <= RANK.get(y)! ? x : y;
}

/**
 * v = min(inf over R and any other own mandatory key, inf over optional of min(o, MEASURED)).
 * A missing member of R gives at most WARN; optional (third-party) inputs can only lower v (IC5).
 */
export function combine(mandatory: Record<string, unknown>, optional: readonly unknown[] = []): Verdict {
  let v: Verdict = 'MEASURED';
  const own = mandatory !== null && typeof mandatory === 'object';
  for (const k of REQUIRED) v = meet(v, own && Object.hasOwn(mandatory, k) ? mandatory[k] : 'WARN');
  if (own) for (const k of Object.keys(mandatory)) v = meet(v, mandatory[k]);
  for (const o of optional) v = meet(v, meet(o, 'MEASURED'));
  return v;
}
