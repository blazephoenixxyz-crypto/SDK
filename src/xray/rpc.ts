// Reading one transport reply (decision 12, X1-tiers-4 (c)). Pure: the transport hands over what it got.
// A reply is either a JSON-RPC envelope ({result} | {error}) or an HTTP wrapper {httpStatus, body} or
// {transportError}. An HTTP 4xx (not 429) whose body is a valid JSON-RPC error is that JSON-RPC error
// (dRPC answers -32601 with HTTP 400); -32601 means the method, so the tier, does not exist here and the
// ladder steps down. Rate limit, server error, transport failure or no JSON-RPC body: provider unavailable.

export type RpcReply = { result: unknown } | { error: unknown } | { httpStatus?: number; body?: unknown; transportError?: unknown } | null | undefined;
export type RpcClass =
  | { cls: 'result'; result: unknown }
  | { cls: 'error'; code: number; message: string; data?: unknown; tierMissing: boolean }
  | { cls: 'unavailable'; why: 'provider unavailable' };

const UNAVAILABLE = { cls: 'unavailable', why: 'provider unavailable' } as const;
export const METHOD_NOT_FOUND = -32601;
const RATE_LIMITED = new Set([429, -32005]);

function envelope(x: unknown, strict: boolean): RpcClass {
  if (x === null || typeof x !== 'object') return { ...UNAVAILABLE };
  const o = x as Record<string, unknown>;
  if (strict && o.jsonrpc !== '2.0') return { ...UNAVAILABLE };
  const hasR = Object.hasOwn(o, 'result') && o.result !== undefined, hasE = Object.hasOwn(o, 'error') && o.error !== undefined;
  if (hasR === hasE) return { ...UNAVAILABLE };
  if (hasR) return { cls: 'result', result: o.result };
  const e = o.error as Record<string, unknown> | null;
  if (e === null || typeof e !== 'object' || !Number.isSafeInteger(e.code) || (strict && typeof e.message !== 'string')) return { ...UNAVAILABLE };
  const code = e.code as number;
  if (RATE_LIMITED.has(code)) return { ...UNAVAILABLE };
  const out: RpcClass = { cls: 'error', code, message: typeof e.message === 'string' ? e.message : '', tierMissing: code === METHOD_NOT_FOUND };
  if (e.data !== undefined) out.data = e.data;
  return out;
}

export function classifyRpcReply(reply: RpcReply): RpcClass {
  if (reply === null || typeof reply !== 'object') return { ...UNAVAILABLE };
  const w = reply as { httpStatus?: unknown; body?: unknown; transportError?: unknown };
  if (w.transportError !== undefined) return { ...UNAVAILABLE };
  if (w.httpStatus === undefined && w.body === undefined) return envelope(reply, false);
  const s = w.httpStatus;
  if (s !== undefined && (typeof s !== 'number' || !Number.isInteger(s))) return { ...UNAVAILABLE };
  let body = w.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return { ...UNAVAILABLE }; } }
  if (s === undefined || (s >= 200 && s < 300)) return envelope(body, true);
  if (s >= 400 && s < 500 && s !== 429) {
    const c = envelope(body, true);
    return c.cls === 'error' ? c : { ...UNAVAILABLE };
  }
  return { ...UNAVAILABLE };
}
