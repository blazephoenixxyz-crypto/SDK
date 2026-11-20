// @blazephoenix/sdk/xray: the own honeypot instrument, sans-IO (DEEP §3.0). xrayStart/xrayStep are pure;
// runXray is the only function with I/O and only through the injected transport.
import { getAddress, keccak256, toHex } from 'viem';
import { startProgram, stepProgram, inputHash, XrayError, type Io, type Rpc, type State, type Step } from './step.js';
import { pinBlock, makeCtx, XRAY_DEPLOYMENTS, type Blk } from './ctx.js';
import { scan, type Gen } from './scan.js';
import { classifyRpcReply } from './rpc.js';
import { buildReport, type XrayReport } from './report.js';
import { validMaxTaxBps } from './measure.js';
import { nitroUncovered } from './tiers.js';

export type XrayInput = { chainId: number; token: string; amountIn: bigint; maxTaxBps: number; N?: number; X?: string; Y?: string };
export type Transport = (batch: Rpc[]) => Promise<unknown[]>;
export { XrayError, type Rpc, type State, type Step, type XrayReport };
export { classifyRpcReply } from './rpc.js';
export { meet, combine, normalize, REQUIRED } from './lattice.js';

const ADDR = /^0x[0-9a-fA-F]{40}$/;
function actor(input: XrayInput, who: 'X' | 'Y'): string {
  const given = input[who];
  if (given !== undefined) return getAddress(given);
  return getAddress('0x' + keccak256(toHex(`blazephoenix-xray:${who}:${inputHash(input)}`)).slice(-40));
}

/**
 * Tier A simulates at the pinned block NUMBER (tiers.ts prepareA/prepareProbe; B and C pass the hash). After the run
 * the block at that number must still carry the pinned hash: a different, missing or unreadable hash is NOT_MEASURED.
 */
function* samePin(blk: Blk): Gen<string | null> {
  const [reply] = yield [{ method: 'eth_getBlockByNumber', params: ['0x' + blk.number.toString(16), false] }];
  const k = classifyRpcReply(reply as any);
  const hash = k.cls === 'result' && k.result !== null && typeof k.result === 'object' ? (k.result as any).hash : undefined;
  if (typeof hash !== 'string') return 'pinned block not re-read after tier A';
  return hash.toLowerCase() === blk.hash.toLowerCase() ? null : 'pinned block hash changed after tier A (reorg)';
}

/** An explicitly undefined N, X or Y is the omitted one: same canonical input, inputHash and actors. */
const OPT = ['N', 'X', 'Y'] as const;
function normInput(input: XrayInput): XrayInput {
  if (input === null || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) return input;
  if (!OPT.some((k) => Object.hasOwn(input, k) && input[k] === undefined)) return input;
  const o: any = { ...input };
  for (const k of OPT) if (Object.hasOwn(o, k) && o[k] === undefined) delete o[k];
  return o;
}

function* xrayProgram(input: XrayInput, io: Io): Gen<XrayReport> {
  if (input === null || typeof input !== 'object' || !XRAY_DEPLOYMENTS[input.chainId]) throw new XrayError('bad_input', 'chainId');
  if (typeof input.token !== 'string' || !ADDR.test(input.token)) throw new XrayError('bad_input', 'token');
  if (typeof input.amountIn !== 'bigint' || input.amountIn <= 0n) throw new XrayError('bad_input', 'amountIn');
  if (input.maxTaxBps === undefined) throw new XrayError('bad_input', 'maxTaxBps is an owner decision: pass it');
  if (!validMaxTaxBps(input.maxTaxBps)) throw new XrayError('bad_input', 'maxTaxBps must be an integer in [1, 10000]');
  const N = input.N ?? 100;
  const blk = yield* pinBlock(input.chainId, getAddress(input.token));
  io.pin({ number: BigInt(blk.number), hash: blk.hash });
  const ids = { X: actor(input, 'X'), Y: actor(input, 'Y') };
  const mk = (o: any = {}) => makeCtx(input.chainId, input.token, blk, { buyIn: input.amountIn, N, mode: 'd4', ...o }, ids);
  const sc0 = blk.code?.token === false
    ? { tier: null, rung: null, status: 'NOT_MEASURED', why: 'token has no code at the pinned block', uncovered: null, limits: [], probes: [] }
    : yield* scan(mk, [], { noC: blk.code?.mc3 === false ? 'Multicall3 codehash differs from the pin: tier C unavailable' : undefined });
  const moved = sc0.tier === 'A' && sc0.status === 'RAN' ? yield* samePin(blk) : null;
  // Nitro: contracts see the L1 block.number, so the later sale's gap does not cover a block-number gate (b2).
  const report = (s: typeof sc0) => buildReport({ chainId: input.chainId, block: blk, target: getAddress(input.token), amountIn: input.amountIn, maxTaxBps: input.maxTaxBps, scan: nitroUncovered(s, input.chainId), ctx: mk() });
  const r = report(sc0);
  // A moved pin downgrades what tier A measured to NOT_MEASURED, except a CONDEMN: a tax lower bound >= maxTaxBps
  // condemns at every tier, and a reorg must not turn a condemnation into a softer verdict.
  return moved && r.verdict !== 'CONDEMN' ? report({ ...sc0, status: 'NOT_MEASURED', why: moved }) : r;
}

export const xrayStart = (input: XrayInput): Step<XrayReport> => startProgram(xrayProgram, normInput(input));
export const xrayStep = (state: State, responses: unknown[]): Step<XrayReport> => stepProgram(xrayProgram, state, responses);

/**
 * The only I/O: the injected transport answers each batch, in order, one reply per request. A rejected batch is a
 * failed reply for every request ({transportError}): provider unavailable after the pin, a failed pin before it.
 */
export async function runXray(transport: Transport, input: XrayInput): Promise<XrayReport> {
  let s = xrayStart(input);
  while ('need' in s) {
    let replies: unknown[];
    try { replies = await transport(s.need); } catch { replies = s.need.map(() => ({ transportError: 'transport rejected' })); }
    if (!Array.isArray(replies) || replies.length !== s.need.length) throw new XrayError('bad_responses', 'transport must answer every request');
    s = xrayStep(s.state, replies);
  }
  return s.done;
}
