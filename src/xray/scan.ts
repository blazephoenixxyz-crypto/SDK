// Port of deep-xray-tiers@1998a4d core/scan.mjs as generators (sans-IO): every `await send(req)` became
// `yield* ask(req)`, which yields one exact JSON-RPC request (no id) and normalises the reply through
// classifyRpcReply. The rung is chosen by a token-independent probe (decision 12); token-call errors never move it.
import { decodeFunctionResult, encodeFunctionResult, keccak256 } from 'viem';
import { PROBE } from './abi.js';
import { classifyRpcReply } from './rpc.js';
import type { Rpc } from './step.js';
import { prepareA, prepareB, prepareC, prepareProbe, decodeA, decodeC, advance, consistent, toResult,
  classifyToken, classifyProbe, selectTier, aRetry, TIER_UNCOVERED, TIER_LIMITS } from './tiers.js';

export type Gen<R> = Generator<Rpc[], R, unknown[]>;
const J = (o: any) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));

/** One request out, one reply in; a JSON-RPC result or error becomes its envelope, anything else stays as it came. */
export function* ask(req: { method: string; params: unknown[] }): Gen<any> {
  const [reply] = yield [{ method: req.method, params: req.params }];
  const k = classifyRpcReply(reply as any);
  if (k.cls === 'result') return { result: k.result };
  if (k.cls === 'error') return { error: { code: k.code, message: k.message, ...(k.data !== undefined ? { data: k.data } : {}) } };
  return reply ?? null;
}

/** Rounds of tier A or C until done; returns { status, code?, result?, rounds, why }. */
export function* runTier(tier: 'A' | 'C', ctx: any, log: any[] = []): Gen<any> {
  let known: any = {}, prev: any = null, rounds = 0;
  for (;;) {
    const { steps, req } = tier === 'A' ? prepareA(ctx, known) : prepareC(ctx, known);
    const resp = yield* ask(req);
    rounds++;
    const c: any = classifyToken(resp);
    log.push({ tier, round: rounds, steps: steps.length, cls: c.cls, code: c.code ?? null });
    if (c.cls !== 'ok') return { status: 'NOT_MEASURED', code: c.code, why: c.why, rounds, resp: J(resp ?? null).slice(0, 300) };
    const m = tier === 'A' ? decodeA(steps, resp) : decodeC(steps, resp);
    if (!m) return { status: 'NOT_MEASURED', why: 'undecodable answer', rounds, resp: J(resp).slice(0, 300) };
    if (!consistent(prev, m)) return { status: 'NOT_MEASURED', why: 'round ' + rounds + ' differs from round ' + (rounds - 1), rounds };
    const a = advance(ctx, known, m, tier);
    known = a.known; prev = m;
    if (a.done) return { status: 'RAN', why: a.why, rounds, result: toResult(ctx, known, m, tier), blocks: m._blocks,
      known: { sellAmt: known.sellAmt, left: known.left, tAmt: known.tAmt, pAmt: known.pAmt, rem: known.rem, poolTransferTo: known.poolTransferTo } };
    if (rounds > 10) return { status: 'NOT_MEASURED', why: 'round cap', rounds };
  }
}

/** Tier B: the pinned XRayProbe runtime injected at ctx.X (the probe's sender), same block. */
export function* runB(ctx: any): Gen<any> {
  if (keccak256(PROBE.runtime) !== PROBE.keccak) throw new Error('probe pin');
  const { req } = prepareB(ctx, ctx.X);
  const resp = yield* ask(req);
  const c: any = classifyToken(resp);
  if (c.cls !== 'ok') return { status: 'NOT_MEASURED', code: c.code, why: c.why, resp: J(resp ?? null).slice(0, 300) };
  // Canonical only: viem decodes trailing bytes and dirty address words, so the answer must be the re-encoding.
  try {
    const d = (decodeFunctionResult as any)({ abi: PROBE.abi, functionName: 'probe', data: resp.result });
    if ((encodeFunctionResult as any)({ abi: PROBE.abi, functionName: 'probe', result: d }) !== String(resp.result).toLowerCase()) throw new Error('non-canonical');
    return { status: 'RAN', result: { tier: 'B', ...d }, X: ctx.X };
  } catch { return { status: 'NOT_MEASURED', why: 'undecodable answer' }; }
}

/** Tier A with the code-driven retries (tiers.ts:aRetry), each once, labelled in `retries`. */
export function* runA(mk: (o: any) => any, mode: string, log: any[] = []): Gen<any> {
  const retries: string[] = [];
  let o: any = { mode };
  for (;;) {
    const ctx = mk(o);
    const res = yield* runTier('A', ctx, log);
    const r = aRetry(res, retries);
    if (!r) return { ...res, mode: ctx.mode, clock: ctx.clock, gas: ctx.gas, N: ctx.N, X: ctx.X, dt: ctx.dt, laterTime: ctx.laterTime, fee: ctx.fee, retries };
    retries.push(r);
    o = { ...o, ...(r === 'nodeclock' ? { clock: 'node' } : { gas: 'l1gas' }) };
  }
}

/**
 * mk(opts) -> ctx (same X, Y for every call). Returns the report of the rung that ran, or NOT_MEASURED.
 * `noC` (why): tier C is unavailable (Multicall3 not the pinned code); C is the last rung, so reaching it is NOT_MEASURED.
 */
export function* scan(mk: (o: any) => any, log: any[] = [], opts: { noC?: string } = {}): Gen<any> {
  const answers: Record<string, unknown> = {};
  const probes: any[] = [];
  const ctxs: Record<string, any> = {};
  const ctxOf = (rung: string) => (ctxs[rung] ??= mk(rung[0] === 'A' ? { mode: rung.slice(2) } : {}));
  const report = (rung: string, res: any) => ({ tier: rung[0], rung, uncovered: (TIER_UNCOVERED as any)[rung[0]], limits: (TIER_LIMITS as any)[rung[0]], probes, ...res });
  for (;;) {
    const s: any = selectTier(answers);
    if (opts.noC && s.rung === 'C') return { tier: null, rung: null, status: 'NOT_MEASURED', why: opts.noC, uncovered: null, limits: [], probes };
    if (s.status === 'ask') {
      const req = prepareProbe(s.rung, ctxOf(s.rung)).req;
      const [resp0] = yield [{ method: req.method, params: req.params }];
      const resp: any = resp0 ?? null;
      answers[s.rung] = resp;
      const c: any = classifyProbe(s.rung[0], resp);
      probes.push({ rung: s.rung, cls: c.cls, code: c.code ?? resp?.error?.code ?? resp?.httpStatus ?? null });
      log.push({ probe: s.rung, cls: c.cls });
      continue;
    }
    if (s.status !== 'run') return { tier: null, rung: null, status: 'NOT_MEASURED', why: s.why, uncovered: null, limits: [], probes };
    const rung = s.rung;
    const res = rung[0] === 'A' ? yield* runA(mk, rung.slice(2), log) : rung === 'B' ? yield* runB(ctxOf(rung)) : yield* runTier('C', ctxOf(rung), log);
    return report(rung, res);
  }
}
