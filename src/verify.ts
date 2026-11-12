// =============================================================================
//  verifyPlan — re-check a SwapPlan against what YOU asked for, from its bytes.
//
//  A plan is a plain object: it may have crossed a process, a queue, an MCP
//  server or an LLM (toJSON) before it reaches execute(). Simulation runs the
//  same bytes, so it cannot tell a tampered plan from an honest one. This check
//  decodes plan.tx.data and plan.approval.tx.data and compares every field with
//  the expectation built from the request and the deployment the SDK resolved,
//  never with the plan's own claims alone. Pure — no I/O. Fails closed.
// =============================================================================

import { decodeFunctionData, encodeFunctionData } from 'viem';
import { ERC20_ABI, ROUTER_ABI } from './abis.js';
import { routeFingerprint } from './calldata.js';
import { MAX_UINT256 } from './erc20.js';
import { BlazeError } from './errors.js';
import type { Address, Route, SwapPlan, TxRequest } from './types.js';

export interface PlanExpectation {
  chainId: number;
  /** The Router of the deployment the SDK resolved for chainId — not the plan's. */
  router: Address;
  /** As the Router sees it (WETH when the input is native ETH). */
  tokenIn: Address;
  tokenOut: Address;
  nativeIn: boolean;
  amountIn: bigint;
  recipient: Address;
  /** The signed minimum must be at least this. */
  minOutAtLeast: bigint;
  /** The exact deadline asked for … */
  deadline?: bigint;
  /** … or, for a relative one, the latest acceptable. */
  maxDeadline?: bigint;
  /** 'exact': approve amountIn; 'max': MAX_UINT256; 'either': one of the two. */
  approve: 'exact' | 'max' | 'either';
}

export interface VerifiedPlan {
  entry: SwapPlan['entry'];
  amountIn: bigint;
  minOut: bigint;
  recipient: Address;
  deadline: bigint;
  approval: { spender: Address; amount: bigint } | null;
}

const SWAP_ENTRIES: readonly string[] = ['swapExactIn', 'swapExactInNative', 'swapBestExactIn'];
const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const sameTx = (a: TxRequest, b: TxRequest) => a.chainId === b.chainId && same(a.to, b.to) && same(a.data, b.data) && a.value === b.value;

function refuse(fields: string[], mismatches: string[]): never {
  throw new BlazeError('plan_mismatch',
    `plan refused — it does not execute what you asked for (${fields.join(', ')}): ${mismatches.join('; ')}`,
    { details: { fields, mismatches } });
}

/** Throws `plan_mismatch` (details.fields names each failed field) unless the plan's
 *  bytes are canonical, agree with the plan's own claims, and execute exactly `want`.
 *  Against `want` a plan may only be stricter (a higher minimum), never looser. */
export function verifyPlan(plan: SwapPlan, want: PlanExpectation): VerifiedPlan {
  try {
    return check(plan, want);
  } catch (e) {
    if (e instanceof BlazeError && e.code === 'plan_mismatch') throw e;
    return refuse(['shape'], [`malformed plan: ${(e as Error)?.message?.split('\n')[0] ?? 'unreadable'}`]);
  }
}

function check(plan: SwapPlan, want: PlanExpectation): VerifiedPlan {
  const fields: string[] = [];
  const bad: string[] = [];
  const fail = (f: string, m: string) => { if (!fields.includes(f)) fields.push(f); bad.push(m); };
  const { tx, quote } = plan;

  if (tx.chainId !== want.chainId || quote.chainId !== want.chainId) fail('chainId', `chainId ${tx.chainId} ≠ ${want.chainId}`);
  if (!same(tx.to, want.router) || !same(quote.router, want.router)) fail('to', `to ${tx.to} is not the Router ${want.router}`);

  let d: { functionName: string; args?: readonly unknown[] };
  try { d = decodeFunctionData({ abi: ROUTER_ABI, data: tx.data }); } catch { return refuse(['selector', ...fields], ['tx.data is not a Router call', ...bad]); }
  const fn = d.functionName;
  if (!SWAP_ENTRIES.includes(fn) || fn !== plan.entry || (fn === 'swapExactInNative') !== want.nativeIn) {
    return refuse(['selector', ...fields], [`Router function ${fn} (plan says ${plan.entry}, nativeIn ${want.nativeIn})`, ...bad]);
  }
  // Canonical form: the bytes must be exactly the encoding of what was decoded, so what is
  // checked is what the Router reads (no dirty address words, odd offsets or trailing bytes).
  if (!same(encodeFunctionData({ abi: ROUTER_ABI, functionName: fn, args: d.args } as never), tx.data)) {
    fail('calldata', 'tx.data is not the canonical encoding of the call it decodes to');
  }
  const a = d.args as readonly unknown[];
  let route: Route | undefined, amountIn: bigint, minOut: bigint, recipient: Address, deadline: bigint, tIn: unknown, tOut: unknown;
  if (fn === 'swapExactIn') {
    [route, amountIn, minOut, recipient, deadline] = a as [Route, bigint, bigint, Address, bigint];
  } else if (fn === 'swapExactInNative') {
    [route, minOut, recipient, deadline] = a as [Route, bigint, Address, bigint];
    amountIn = tx.value;
  } else {
    [tIn, tOut, amountIn, minOut, recipient, deadline] = a as [Address, Address, bigint, bigint, Address, bigint];
  }
  if (route) {
    const h = route.hops;
    tIn = h[0]?.tokenIn;
    tOut = h[h.length - 1]?.tokenOut;
    let chained = h.length > 0 && h.every((x) => x.legs.length > 0);
    for (let i = 1; i < h.length; i++) if (!same(h[i]!.tokenIn, h[i - 1]!.tokenOut)) chained = false;
    if (!chained || routeFingerprint(route) !== routeFingerprint(quote.route)) fail('route', 'encoded route is not the quoted route');
  }
  if (tx.value !== (want.nativeIn ? want.amountIn : 0n)) fail('value', `value ${tx.value} ≠ ${want.nativeIn ? want.amountIn : 0n}`);
  if (amountIn !== want.amountIn || quote.amountIn !== want.amountIn) fail('amountIn', `amountIn ${amountIn} ≠ ${want.amountIn}`);
  if (!same(tIn, want.tokenIn) || !same(quote.tokenIn, want.tokenIn)) fail('tokenIn', `tokenIn ${String(tIn)} ≠ ${want.tokenIn}`);
  if (!same(tOut, want.tokenOut) || !same(quote.tokenOut, want.tokenOut)) fail('tokenOut', `tokenOut ${String(tOut)} ≠ ${want.tokenOut}`);
  if (!same(recipient, want.recipient) || !same(plan.recipient, want.recipient)) fail('recipient', `recipient ${recipient} ≠ ${want.recipient}`);
  if (deadline !== plan.deadline || (want.deadline !== undefined && deadline !== want.deadline)
    || (want.deadline === undefined && (want.maxDeadline === undefined || deadline > want.maxDeadline))) {
    fail('deadline', `deadline ${deadline} (plan ${plan.deadline}, want ${want.deadline ?? `≤ ${want.maxDeadline}`})`);
  }
  // The plan's own claim must equal its bytes; only the request bound is one-sided (stricter is fine).
  if (minOut < want.minOutAtLeast || minOut !== plan.minOut || minOut === 0n) {
    fail('minOut', `minOut ${minOut} (plan says ${plan.minOut}, required ≥ ${want.minOutAtLeast})`);
  }

  let approval: VerifiedPlan['approval'] = null;
  const ap = plan.approval;
  if (ap && want.nativeIn) fail('approval', 'native input needs no approval');
  if (ap) {
    const at = ap.tx;
    if (!same(at.to, want.tokenIn) || !same(ap.token, want.tokenIn)) fail('approvalTo', `approval to ${at.to} is not tokenIn ${want.tokenIn}`);
    if (at.chainId !== want.chainId) fail('approvalChainId', `approval chainId ${at.chainId} ≠ ${want.chainId}`);
    if (at.value !== 0n) fail('approvalValue', `approval value ${at.value} ≠ 0`);
    let spender: Address | undefined, amount: bigint | undefined;
    try {
      const ad = decodeFunctionData({ abi: ERC20_ABI, data: at.data });
      if (ad.functionName === 'approve') {
        [spender, amount] = ad.args as unknown as [Address, bigint];
        if (!same(encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] }), at.data)) spender = amount = undefined;
      }
    } catch { /* refused below */ }
    if (spender === undefined || amount === undefined) {
      fail('approvalSelector', 'approval.tx.data is not a canonical approve(address,uint256)');
    } else {
      if (!same(spender, want.router) || !same(ap.spender, want.router)) fail('spender', `spender ${spender} is not the Router ${want.router}`);
      const ok = want.approve === 'exact' ? amount === want.amountIn
        : want.approve === 'max' ? amount === MAX_UINT256
          : amount === want.amountIn || amount === MAX_UINT256;
      if (!ok || amount !== ap.amount) fail('approvalAmount', `approval amount ${amount} (${want.approve}, amountIn ${want.amountIn})`);
      approval = { spender, amount };
    }
  }
  const steps = ap ? [ap.tx, tx] : [tx];
  if (plan.steps.length !== steps.length || !plan.steps.every((s, i) => sameTx(s, steps[i]!))) fail('steps', 'plan.steps is not [approval?, tx]');

  if (fields.length) refuse(fields, bad);
  return { entry: plan.entry, amountIn, minOut, recipient, deadline, approval };
}

// ── snapshot ─────────────────────────────────────────────────────────────────
//  What is verified must be what is signed. A plan handed to execute() is still held by the
//  caller: a getter, a Proxy or a later write to the same object would change the bytes between
//  the check and the send. snapshotPlan copies it once, as inert data, and execute() verifies,
//  simulates and signs only that copy. Anything that is not plain data is refused, not coerced.

const BIGINT_PATHS = ['tx.value', 'minOut', 'deadline', 'quote.amountIn', 'quote.amountOut', 'quote.preview.ironFloor'] as const;
const INT_PATHS = ['tx.chainId', 'quote.chainId', 'quote.quotedAt', 'slippageBps'] as const;

function notData(m: string): never {
  throw new BlazeError('bad_request', `plan is not plain data: ${m} — pass the SwapPlan buildSwap returned (bigints as bigint)`);
}

function inert(v: unknown, path: string, depth: number): unknown {
  const t = typeof v;
  if (v === null || t === 'bigint' || t === 'string' || t === 'number' || t === 'boolean' || t === 'undefined') return v;
  if (t !== 'object' || depth > 32) notData(`${path || 'plan'} is a ${t}`);
  const o = v as object;
  const isArr = Array.isArray(o);
  const proto = Object.getPrototypeOf(o);
  if (isArr ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) notData(`${path || 'plan'} is not a plain object`);
  const out: Record<string, unknown> = isArr ? ([] as unknown as Record<string, unknown>) : {};
  for (const k of Reflect.ownKeys(o)) {
    if (typeof k === 'symbol') notData(`${path || 'plan'} has a symbol key`);
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (!d || !('value' in d)) notData(`${path ? `${path}.` : ''}${k} is an accessor (getter/setter)`);
    if (isArr && k === 'length') continue;
    if (!d.enumerable) continue;
    out[k] = inert(d.value, path ? `${path}.${k}` : k, depth + 1);
  }
  return out;
}

const at = (o: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((x, k) => (x !== null && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), o);

/** A deep, inert copy of `plan` (each property read once), or `bad_request` when it is not plain
 *  data: accessors, Proxies, class instances, functions, or bigint fields that are not bigints
 *  (a JSON-crossed plan). Verify, simulate and sign the copy, never the caller's object. */
export function snapshotPlan(plan: unknown): SwapPlan {
  if (plan === null || typeof plan !== 'object') notData('not an object');
  const snap = inert(plan, '', 0) as SwapPlan;
  // A Proxy answers the reads above with whatever it likes, once; it is still refused, not trusted.
  if (typeof structuredClone === 'function') {
    try { structuredClone(plan); } catch { notData('it cannot be cloned (a Proxy, a function or another non-data value)'); }
  }
  for (const p of BIGINT_PATHS) if (typeof at(snap, p) !== 'bigint') notData(`${p} must be a bigint`);
  for (const p of INT_PATHS) if (!Number.isSafeInteger(at(snap, p))) notData(`${p} must be an integer`);
  if (!Array.isArray(snap.steps)) notData('steps must be an array');
  snap.steps.forEach((s, i) => { if (typeof at(s, 'value') !== 'bigint') notData(`steps.${i}.value must be a bigint`); });
  if (snap.approval !== null && snap.approval !== undefined) {
    if (typeof snap.approval.amount !== 'bigint' || typeof at(snap.approval, 'tx.value') !== 'bigint') notData('approval.amount and approval.tx.value must be bigints');
    if (snap.approval.current !== undefined && typeof snap.approval.current !== 'bigint') notData('approval.current must be a bigint');
  }
  return snap;
}
