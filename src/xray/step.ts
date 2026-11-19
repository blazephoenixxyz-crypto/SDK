// Sans-IO stepping (DEEP §3.0): a Program is a generator that yields batches of exact JSON-RPC requests
// (no id) and receives the answers. The state is serialisable and carries the canonical input, its
// keccak and the pinned block; every step replays the recorded answers, so no server keeps state.
// A tampered or foreign state fails closed with state_mismatch. runProgram is the only loop with I/O.
import { keccak256, toHex } from 'viem';

export type Rpc = { method: string; params: unknown[] };
export type Pin = { number: bigint; hash: string };
export type Io = { pin(b: Pin): void };
export type Program<I, R> = (input: I, io: Io) => Generator<Rpc[], R, unknown[]>;
export type State = { v: 1; inputHash: string; input: unknown; block: { number: string; hash: string } | null; answers: unknown[][] };
export type Step<R> = { need: Rpc[]; state: State } | { done: R };

export class XrayError extends Error {
  constructor(readonly code: 'state_mismatch' | 'bad_responses' | 'bad_input', detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'XrayError';
  }
}

const BIG = '$bigint';
function toCanon(x: unknown): unknown {
  if (typeof x === 'bigint') return { [BIG]: x.toString() };
  if (x === null || typeof x === 'string' || typeof x === 'boolean') return x;
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) throw new XrayError('bad_input', 'non-finite number');
    return x;
  }
  if (Array.isArray(x)) return x.map(toCanon);
  if (typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(x as object).sort()) {
      if (k === BIG || k === '__proto__') throw new XrayError('bad_input', `reserved key ${k}`);
      o[k] = toCanon((x as Record<string, unknown>)[k]);
    }
    return o;
  }
  throw new XrayError('bad_input', `not canonical: ${typeof x}`);
}
function fromCanon(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(fromCanon);
  if (x !== null && typeof x === 'object') {
    const ks = Object.keys(x);
    const b = (x as Record<string, unknown>)[BIG];
    if (ks.length === 1 && ks[0] === BIG && typeof b === 'string' && /^-?(0|[1-9][0-9]*)$/.test(b)) return BigInt(b);
    const o: Record<string, unknown> = {};
    for (const k of ks) o[k] = fromCanon((x as Record<string, unknown>)[k]);
    return o;
  }
  return x;
}

/** Canonical JSON: sorted keys, bigint as {"$bigint": "<decimal>"}; anything else not JSON throws. */
export function canonical(x: unknown): string {
  return JSON.stringify(toCanon(x));
}
export function inputHash(x: unknown): `0x${string}` {
  return keccak256(toHex(canonical(x)));
}

type Run<R> = { res: IteratorResult<Rpc[], R>; gen: Generator<Rpc[], R, unknown[]>; pinned: Pin | null };
function replay<I, R>(program: Program<I, R>, input: I, answers: unknown[][]): Run<R> {
  const run = { pinned: null as Pin | null } as Run<R>;
  run.gen = program(input, { pin: (b) => {
    const p = { number: BigInt(b.number), hash: String(b.hash) };
    if (run.pinned && (run.pinned.number !== p.number || run.pinned.hash !== p.hash)) throw new XrayError('state_mismatch', 'block pinned twice');
    run.pinned = p;
  } });
  run.res = run.gen.next(undefined as unknown as unknown[]);
  for (const a of answers) {
    if (run.res.done) throw new XrayError('state_mismatch', 'more answers than requests');
    if (!Array.isArray(a) || a.length !== run.res.value.length) throw new XrayError('state_mismatch', 'recorded answers do not match the requests');
    run.res = run.gen.next(a);
  }
  return run;
}
const blockOf = (p: Pin | null) => (p === null ? null : { number: p.number.toString(), hash: p.hash });
function emit<R>(run: Run<R>, base: Omit<State, 'block' | 'answers'>, answers: unknown[][]): Step<R> {
  if (run.res.done) return { done: run.res.value };
  return { need: run.res.value.map((r) => ({ method: r.method, params: r.params })), state: { ...base, block: blockOf(run.pinned), answers } };
}

export function startProgram<I, R>(program: Program<I, R>, input: I): Step<R> {
  const base = { v: 1 as const, inputHash: inputHash(input), input: JSON.parse(canonical(input)) };
  return emit(replay(program, input, []), base, []);
}

export function stepProgram<I, R>(program: Program<I, R>, state: State, responses: unknown[]): Step<R> {
  if (state === null || typeof state !== 'object' || state.v !== 1 || !Array.isArray(state.answers)) throw new XrayError('state_mismatch', 'foreign state');
  let input: I;
  try { input = fromCanon(state.input) as I; } catch { throw new XrayError('state_mismatch', 'input not canonical'); }
  let h: string;
  try { h = inputHash(input); } catch { throw new XrayError('state_mismatch', 'input not canonical'); }
  if (h !== state.inputHash) throw new XrayError('state_mismatch', 'inputHash');
  const run = replay(program, input, state.answers);
  const pb = blockOf(run.pinned), sb = state.block ?? null;
  if ((pb === null) !== (sb === null) || (pb && sb && (pb.number !== sb.number || pb.hash !== sb.hash))) throw new XrayError('state_mismatch', 'pinned block');
  if (run.res.done) throw new XrayError('state_mismatch', 'program already done');
  if (!Array.isArray(responses) || responses.length !== run.res.value.length) throw new XrayError('bad_responses', `expected ${run.res.value.length} responses`);
  run.res = run.gen.next(responses);
  const base = { v: 1 as const, inputHash: state.inputHash, input: state.input };
  return emit(run, base, [...state.answers, responses]);
}

/** The only loop with I/O: the transport answers each batch in order. */
export async function runProgram<I, R>(program: Program<I, R>, transport: (rs: Rpc[]) => Promise<unknown[]>, input: I): Promise<R> {
  let s = startProgram(program, input);
  while ('need' in s) s = stepProgram(program, s.state, await transport(s.need));
  return s.done;
}
