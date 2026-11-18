// =============================================================================
//  Errors — every failure has a stable machine `code`, and every enumerated
//  protocol revert (RouterE / QuoterE / SolverE / HubE / GateE / AdapterE) is
//  decoded into a sentence taken from the contract's own source comments. Any
//  other custom error the Dex declares decodes by name, without a `code`.
// =============================================================================

import { decodeErrorResult } from 'viem';
import { BLAZE_ERRORS_ABI } from './abis.generated.js';
import type { DecodedError, Hex } from './types.js';
import { scrubUrls } from './rpc.js';

/** A copy of an error chain that keeps names and messages but no URL in any of them:
 *  transport errors quote the URL they called (key and all) in message, details and url fields. */
function scrubCause(c: unknown, depth = 0): unknown {
  if (c === undefined || c === null || depth > 8) return undefined;
  if (!(c instanceof Error)) return scrubUrls(String(c));
  const inner = scrubCause((c as { cause?: unknown }).cause, depth + 1);
  const out = new Error(scrubUrls(c.message), inner !== undefined ? { cause: inner } : undefined);
  out.name = c.name;
  return out;
}

/** Text that came from outside (a token's revert reason): printable ASCII only, one line, capped.
 *  It is shown to people and agents, so it never carries control characters or a long payload. */
export function untrustedText(t: string | undefined, max = 120): string {
  return (t ?? '').replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export type BlazeErrorCode =
  | 'rpc_required'
  | 'rpc_chain_mismatch'
  | 'rpc_error'
  | 'bad_chain'
  | 'bad_request'
  | 'not_deployed'
  | 'unsupported_by_version'
  | 'no_route'
  | 'not_executable'
  | 'calldata_mismatch'
  | 'min_implausible'
  | 'min_above_exact'
  | 'deployment_unverified'
  | 'reverted'
  | 'wallet_chain_mismatch';

export class BlazeError extends Error {
  readonly code: BlazeErrorCode;
  readonly details?: Record<string, unknown>;
  readonly revert?: DecodedError;
  constructor(code: BlazeErrorCode, message: string, opts: { details?: Record<string, unknown>; revert?: DecodedError; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: scrubCause(opts.cause) } : undefined);
    this.name = 'BlazeError';
    this.code = code;
    this.details = opts.details;
    this.revert = opts.revert;
  }
}

// Meanings copied from the contracts' own comments (BlazePhoenix-Dex src/).
const ROUTER: Record<number, string> = {
  1: 'unauthorized',
  2: 'router paused',
  3: 'bad input (route, amount, entry-point preconditions)',
  4: 'deadline passed',
  5: 'slippage: output below the minimum (your userMinOut or the on-chain floor)',
  6: 'callback authentication failed',
  7: 'reentrancy refused',
  8: 'swap failed (a leg delivered nothing / fee would consume the leg)',
  9: 'disallowed or paused V4 hook on the route',
  10: 'userMinOut is 0 with a non-zero amountIn — a real minimum is mandatory',
  11: 'a V4 leg disagrees with its own key (direction or pool id)',
  13: 'fee-on-transfer token on a V3-only route',
  14: 'rescue not queued or still inside the 48h timelock',
  15: 'a swap settled without paying the protocol fee',
  16: 'the fee was paid twice on an anchored route',
};
const QUOTER: Record<number, string> = {
  3: 'constructed with a zero address',
  4: 'batch larger than 32 entries',
  6: 'callback from an unexpected caller',
};
const SOLVER: Record<number, string> = {
  4: 'bad input: zero address, identical tokens or zero amount',
  5: 'no route: no executable path for this pair and size',
};
const HUB: Record<number, string> = {
  1: 'unauthorized', 2: 'hub paused', 3: 'zero address', 4: 'bad input',
  5: 'unknown pool / invalid kind', 6: 'max slots', 7: 'bridge cap', 8: 'hook denied',
  9: 'V4 claim ineligible',
};

const GATE: Record<number, string> = {
  1: 'not the curator', 2: 'control renounced or not the admin', 3: 'bad argument',
  4: 'no live adapter (none, or its code moved from the pin)', 5: 'resolve gave no pool',
  6: 'adapter code refused by the scan', 7: 'timelock running', 8: 'nothing pending',
  9: 'adapter code moved since the proposal', 10: 'replacing a family after renounce',
  11: 're-entered', 12: 'not exact-in', 13: 'paid less than asked',
  14: 'the adapter kept part of the input or of the output', 15: 'the wrapper was left holding it',
  16: 'the pair already holds MAX_WRAPPERS_PER_PAIR wrappers',
};
const ADAPTER: Record<number, string> = {
  0: 'zero address at construction', 1: 'the caller is not a wrapper of the Gate',
  2: 'the venue does not vouch for the pool (registry / factory / vault)', 3: 'the pair is not traded by that pool',
  4: 'an asset or the form of the pool is refused (asset type, ETH sentinel, metapool, native-enabled tricrypto)',
  5: 'an allowance survived the venue call (PULL), or allowance() could not be read (a failed read is not a zero)',
  6: "a venue callback outside the adapter's own call, or not from the venue", 7: "the pool's hooks are refused",
  8: 'the hint is malformed', 9: 'the amount is outside what the venue takes',
};

const TABLES: Record<string, { contract: DecodedError['contract']; codes: Record<number, string> }> = {
  RouterE: { contract: 'Router', codes: ROUTER },
  QuoterE: { contract: 'Quoter', codes: QUOTER },
  SolverE: { contract: 'Solver', codes: SOLVER },
  HubE: { contract: 'Hub', codes: HUB },
  GateE: { contract: 'Gate', codes: GATE },
  AdapterE: { contract: 'Adapter', codes: ADAPTER },
};

/** The decoded form of one revert. Only an enumerated protocol error (TABLES) or a Panic has a
 *  `code`; any other error's first argument is data (a delta, a flag, an amount), never a code.
 *  `Error(string)` keeps its text, cleaned as untrusted. */
function describeDecoded(name: string, args: readonly unknown[] | undefined): DecodedError {
  const a0 = Array.isArray(args) && args.length ? args[0] : undefined;
  if (name === 'Error') return { contract: 'unknown', name, reason: untrustedText(typeof a0 === 'string' ? a0 : undefined) || name };
  if (TABLES[name] || name === 'Panic') return describeProtocolError(name, a0 === undefined ? undefined : Number(a0));
  return describeProtocolError(name);
}

export function describeProtocolError(name: string, code?: number): DecodedError {
  const t = TABLES[name];
  if (!t) return { contract: 'unknown', name, ...(code !== undefined ? { code } : {}), reason: name };
  return {
    contract: t.contract,
    name,
    ...(code !== undefined ? { code } : {}),
    reason: code !== undefined ? (t.codes[code] ?? `code ${code}`) : name,
  };
}

/** Decode raw revert data (0x…) into a protocol error, if it is one of ours. */
export function decodeRevertData(data: Hex | undefined): DecodedError | undefined {
  if (!data || data === '0x' || data.length < 10) return undefined;
  try {
    const e = decodeErrorResult({ abi: BLAZE_ERRORS_ABI, data });
    return describeDecoded(e.errorName, e.args as readonly unknown[] | undefined);
  } catch {
    return undefined;
  }
}

/** Walk any error (viem's nested ContractFunctionExecutionError, a raw RPC
 *  error, …) and return the protocol revert inside it, if there is one. */
export function decodeBlazeError(err: unknown): DecodedError | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { data?: unknown; errorName?: string; args?: unknown[]; raw?: Hex; cause?: unknown };
    // viem ContractFunctionRevertedError: `data` is the decoded { errorName, args }.
    const d = e.data as { errorName?: string; args?: unknown[] } | Hex | undefined;
    if (d && typeof d === 'object' && typeof d.errorName === 'string') {
      return describeDecoded(d.errorName, d.args);
    }
    if (typeof d === 'string') {
      const r = decodeRevertData(d as Hex);
      if (r) return r;
    }
    if (typeof e.raw === 'string') {
      const r = decodeRevertData(e.raw);
      if (r) return r;
    }
    cur = e.cause;
  }
  return undefined;
}

/** True when the error is a node refusing to serve (network / 429 / 5xx),
 *  as opposed to the contract answering with a revert. */
export function isTransportError(err: unknown): boolean {
  const s = String((err as { name?: string })?.name ?? '') + ' ' + String((err as Error)?.message ?? '');
  return /HttpRequestError|TimeoutError|WebSocketRequestError|fetch failed|ECONN|ETIMEDOUT|429|rate limit/i.test(s)
    && !decodeBlazeError(err);
}
