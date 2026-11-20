// XrayReport (DEEP §3.0): pure assembly of what was measured, under which conditions. The verdict is the
// infimum of the lattice (combine/meet in lattice.ts); the text says only what was measured (IC10).
import { combine, type Status, type Verdict } from './lattice.js';
import { measure, instrumentVerdict } from './measure.js';
import { MC3 } from './abi.js';

export type Instrument = { name: string; tier: string | null; status: Status; values: Record<string, unknown>;
  conditions: { sender: string | null; amountIn: bigint; blocksLater: number; gasPrice: bigint | null }; reason: string };
export type XrayReport = { chainId: number; block: { number: string; hash: string; timestamp: string }; target: string; amountIn: bigint;
  legs: { leg: 'buy' | 'sell' | 'transfer'; amountIn: bigint | null }[]; rung: string | null; instruments: Instrument[]; verdict: Verdict; notMeasured: string[];
  uncovered: string[] | null; limits: string[]; text: string };
export type ReportInput = { chainId: number; block: { number: number | bigint; hash: string; timestamp: bigint }; target: string;
  amountIn: bigint; maxTaxBps: number | bigint; scan: any; ctx: { X: string; N: number; fee: { gasPrice: bigint } } | null };

const vOf = (s: Status): Verdict => (s === 'NOT_MEASURED' ? 'WARN' : s);

export function buildReport(p: ReportInput): XrayReport {
  const sc = p.scan ?? {};
  const ran = sc.status === 'RAN' && sc.result;
  const cond = { sender: !ran ? null : sc.tier === 'C' ? MC3 : (p.ctx?.X ?? null), amountIn: p.amountIn,
    blocksLater: ran && sc.tier === 'A' ? Number(p.ctx?.N ?? 0) : 0, gasPrice: p.ctx?.fee.gasPrice ?? null };
  const nm = (name: string, reason: string): Instrument => ({ name, tier: sc.rung ?? null, status: 'NOT_MEASURED', values: {}, conditions: cond, reason });
  const amt = (x: unknown): bigint | null => (ran && x !== undefined && x !== null ? BigInt(x as bigint) : null);
  const legs = [{ leg: 'buy' as const, amountIn: amt(sc.result?.buyIn) }, { leg: 'sell' as const, amountIn: amt(sc.result?.sellIn) },
    { leg: 'transfer' as const, amountIn: amt(sc.result?.transferSent) }];
  let ins: Instrument[];
  if (!ran) ins = [nm('sim', String(sc.why ?? 'not measured')), nm('quoter', 'no scan ran'), nm('transfer', 'no scan ran')];
  else {
    const m = measure(sc.result, { tier: sc.tier });
    const iv = instrumentVerdict(m, { maxTaxBps: p.maxTaxBps });
    const { notes, ...vals } = m;
    const r = sc.result;
    const routed = BigInt(r.buyHops ?? 0) > 0n && BigInt(r.sellHops ?? 0) > 0n;
    ins = [{ name: 'sim', tier: sc.rung, status: iv.status, values: { ...vals, notes }, conditions: cond, reason: iv.why },
      routed ? { name: 'quoter', tier: sc.rung, status: 'MEASURED', values: { buyQuotedNet: r.buyQuotedNet, sellQuotedNet: r.sellQuotedNet }, conditions: cond, reason: 'buy and sell routes quoted' }
        : nm('quoter', 'no route quoted')];
    // Wallet-to-wallet transfer (V-X1-2 (ii)): only an executed transfer is MEASURED; not run (null) is NOT_MEASURED.
    const tc = { ...cond, amountIn: legs[2].amountIn ?? 0n };
    const tax = m.transferTaxBps;
    ins.push(m.transferOk === true
      ? tax === null
        ? { ...nm('transfer', 'wallet transfer executed, receiver delta not measured'), conditions: tc }
        : tax >= BigInt(p.maxTaxBps)
        ? { name: 'transfer', tier: sc.rung, status: 'CONDEMN', values: { transferTaxBps: tax }, conditions: tc, reason: `transferTaxBps ${tax} >= ${p.maxTaxBps}` }
        : { name: 'transfer', tier: sc.rung, status: 'MEASURED', values: { transferTaxBps: tax }, conditions: tc, reason: 'wallet transfer executed' }
      : m.transferOk === false
        ? { name: 'transfer', tier: sc.rung, status: 'WARN', values: {}, conditions: tc, reason: 'wallet transfer reverted' }
        : { ...nm('transfer', 'wallet transfer not measured'), conditions: tc });
  }
  const verdict = combine(Object.fromEntries(ins.map((i) => [i.name, vOf(i.status)])));
  const notMeasured = ins.filter((i) => i.status === 'NOT_MEASURED').map((i) => i.name);
  const parts = ins.map((i) => `${i.name} ${i.status} (${i.reason})`);
  // What the tier cannot cover and its limits travel with the verdict, in the fields and in the text (V5).
  const uncovered: string[] | null = ran && Array.isArray(sc.uncovered) ? [...sc.uncovered] : null;
  const limits: string[] = ran && Array.isArray(sc.limits) ? [...sc.limits] : [];
  const unc = uncovered && uncovered.length ? ` Classes not covered at tier ${sc.tier}: ${uncovered.join(', ')}.` : '';
  const lim = limits.length ? ` Limits: ${limits.join('; ')}.` : '';
  const text = `${verdict}: ${p.target} on chain ${p.chainId} at block ${p.block.number}${sc.rung ? `, tier ${sc.rung}` : ''}, measured at ${p.amountIn} wei in, maxTaxBps ${p.maxTaxBps}. ${parts.join('; ')}.${unc}${lim}`;
  return { chainId: p.chainId, block: { number: String(p.block.number), hash: p.block.hash, timestamp: String(p.block.timestamp) }, target: p.target,
    amountIn: p.amountIn, legs, rung: sc.rung ?? null, instruments: ins, verdict, notMeasured, uncovered, limits, text };
}
