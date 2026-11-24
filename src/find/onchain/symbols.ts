// Many eth_calls in one: Multicall3 aggregate3 with allowFailure, in lots that bisect on error. Used
// for symbol()/name() of every indexed token and for the Hub and counter reads at the target block.
import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { skeleton, tokenText } from '../../text.js';
import { Meter, MeterStop, toHex, why, type ChainRpc } from './rpc.js';

export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
/** Subcalls per eth_call: 9 000 drew HTTP 413 on a measured node, 4 000 (2 000 tokens) passed. */
export const MAX_SUBCALLS = 3_000;
const SYMBOL: Hex = '0x95d89b41';
const NAME: Hex = '0x06fdde03';
const MC_ABI = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }', 'function aggregate3(Call3[] calls) payable returns (Result[] returnData)']);

/** The reason of a call the transport failed (every try), as opposed to a revert: the one producer of it. */
export const CALL_FAILED = 'call failed: ';
export interface Call { to: Address; data: Hex }
export type CallResult = { ok: true; data: Hex } | { ok: false; reason: string };

/** Run calls at `block`; a lot that errors is split in two until one call is left, which is tried
 *  three times and then answers its error. A budget stop throws MeterStop (the caller keeps what it has). */
export async function callMany(m: Meter, rpc: ChainRpc, calls: readonly Call[], block: number, maxPerLot = MAX_SUBCALLS): Promise<CallResult[]> {
  const out: CallResult[] = new Array(calls.length);
  const lots: [number, number][] = [];
  for (let i = 0; i < calls.length; i += maxPerLot) lots.push([i, Math.min(calls.length, i + maxPerLot)]);
  while (lots.length) {
    const [a, b] = lots.shift()!;
    let res: CallResult[] | null = null;
    let err = '';
    for (let attempt = 0; attempt < (b - a === 1 ? 3 : 1) && res === null; attempt++) {
      try { res = await aggregate(m, rpc, calls.slice(a, b), block); } catch (e) { if (e instanceof MeterStop) throw e; err = why(e); }
    }
    if (res) { res.forEach((r, i) => { out[a + i] = r; }); continue; }
    if (b - a === 1) { out[a] = { ok: false, reason: `${CALL_FAILED}${err}` }; continue; }
    const mid = a + Math.ceil((b - a) / 2);
    lots.unshift([a, mid], [mid, b]);
  }
  return out;
}

async function aggregate(m: Meter, rpc: ChainRpc, calls: readonly Call[], block: number): Promise<CallResult[]> {
  const data = encodeFunctionData({ abi: MC_ABI, functionName: 'aggregate3', args: [calls.map((c) => ({ target: c.to, allowFailure: true, callData: c.data }))] });
  const raw = await m.call<string>(rpc, 'eth_call', [{ to: MULTICALL3, data }, toHex(block)]);
  if (typeof raw !== 'string' || raw === '0x') throw new Error('Multicall3 answered nothing (no code at this block?)');
  const res = decodeFunctionResult({ abi: MC_ABI, functionName: 'aggregate3', data: raw as Hex }) as readonly { success: boolean; returnData: Hex }[];
  if (res.length !== calls.length) throw new Error(`Multicall3 answered ${res.length} results for ${calls.length} calls`);
  return res.map((r) => (r.success ? { ok: true, data: r.returnData } : { ok: false, reason: 'reverted' }));
}

/** One 32-byte word as a number, or null (absent is not zero). */
export function wordNumber(r: CallResult | undefined): number | null {
  if (!r?.ok || !/^0x[0-9a-fA-F]{64}$/.test(r.data)) return null;
  const n = BigInt(r.data);
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
}
export function wordAddress(r: CallResult | undefined): Address | null {
  if (!r?.ok || !/^0x0{24}[0-9a-fA-F]{40}$/.test(r.data)) return null;
  return `0x${r.data.slice(26).toLowerCase()}` as Address;
}

/** A string the contract returned: ABI string, else a bytes32 (old tokens), else null. */
export function decodeText(r: CallResult): string | null {
  if (!r.ok) return null;
  try { return decodeAbiParameters([{ type: 'string' }], r.data)[0]; } catch { /* not an ABI string */ }
  if (/^0x[0-9a-fA-F]{64}$/.test(r.data)) {
    const bytes = Uint8Array.from(r.data.slice(2).match(/../g)!.map((h) => parseInt(h, 16)));
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, end));
  }
  return null;
}

/** What the index keeps of a token's own text: display text capped, and the skeletons it is found by. */
export interface TokenText {
  token: Address;
  status: 'READ' | 'FAILED';
  reason?: string;
  symbol: string | null;
  name: string | null;
  /** skeleton(symbol), skeleton(name): the keys a query is matched on (src/text.ts, the same rule as matchesQuery). */
  ks: string | null;
  kn: string | null;
  readAtBlock: number;
}

export function textOf(token: Address, sym: CallResult, nam: CallResult, block: number): TokenText {
  const s = decodeText(sym), n = decodeText(nam);
  const failed = !sym.ok && !nam.ok && sym.reason !== 'reverted' ? sym.reason : null;
  const reason = failed ?? (s === null && n === null ? `symbol: ${sym.ok ? 'not a string' : sym.reason}; name: ${nam.ok ? 'not a string' : nam.reason}` : undefined);
  return {
    token, status: s === null && n === null ? 'FAILED' : 'READ', ...(reason ? { reason } : {}),
    symbol: s === null ? null : tokenText(s), name: n === null ? null : tokenText(n),
    ks: s === null ? null : skeleton(s), kn: n === null ? null : skeleton(n), readAtBlock: block,
  };
}

/** A FAILED reading where symbol() or name() never answered (the transport failed): nothing was measured. */
export const transportFailed = (x: { status: string; reason?: string }): boolean => x.status === 'FAILED' && !!x.reason?.includes(CALL_FAILED);

/** symbol() and name() of each token at `block`, two subcalls per token. */
export async function readTexts(m: Meter, rpc: ChainRpc, tokens: readonly Address[], block: number, maxPerLot = MAX_SUBCALLS): Promise<TokenText[]> {
  const calls: Call[] = tokens.flatMap((t) => [{ to: t, data: SYMBOL }, { to: t, data: NAME }]);
  const r = await callMany(m, rpc, calls, block, maxPerLot - (maxPerLot % 2));
  return tokens.map((t, i) => textOf(t, r[2 * i], r[2 * i + 1], block));
}
