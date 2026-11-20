// @blazephoenix/sdk/xray: the own honeypot instrument, sans-IO (DEEP §3.0). xrayStart/xrayStep are pure;
// runXray is the only function with I/O and only through the injected transport.
import { getAddress, keccak256, toHex } from 'viem';
import { startProgram, stepProgram, inputHash, XrayError, type Io, type Rpc, type State, type Step } from './step.js';
import { pinBlock, makeCtx, XRAY_DEPLOYMENTS } from './ctx.js';
import { scan, type Gen } from './scan.js';
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
  // Nitro: contracts see the L1 block.number, so the later sale's gap does not cover a block-number gate (b2).
  const sc = nitroUncovered(sc0, input.chainId);
  return buildReport({ chainId: input.chainId, block: blk, target: getAddress(input.token), amountIn: input.amountIn, maxTaxBps: input.maxTaxBps, scan: sc, ctx: mk() });
}

export const xrayStart = (input: XrayInput): Step<XrayReport> => startProgram(xrayProgram, input);
export const xrayStep = (state: State, responses: unknown[]): Step<XrayReport> => stepProgram(xrayProgram, state, responses);

/** The only I/O: the injected transport answers each batch, in order, one reply per request. */
export async function runXray(transport: Transport, input: XrayInput): Promise<XrayReport> {
  let s = xrayStart(input);
  while ('need' in s) {
    const replies = await transport(s.need);
    if (!Array.isArray(replies) || replies.length !== s.need.length) throw new XrayError('bad_responses', 'transport must answer every request');
    s = xrayStep(s.state, replies);
  }
  return s.done;
}
