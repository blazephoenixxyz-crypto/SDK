// JSON-safe projection: bigint → decimal string, recursively. Use it before
// JSON.stringify, when handing a quote to an HTTP response, a queue or an LLM.
export type Jsonify<T> = T extends bigint
  ? string
  : T extends (infer U)[]
    ? Jsonify<U>[]
    : T extends readonly (infer U)[]
      ? readonly Jsonify<U>[]
      : T extends object
        ? { [K in keyof T]: Jsonify<T[K]> }
        : T;

export function toJSON<T>(v: T): Jsonify<T> {
  return walk(v) as Jsonify<T>;
}

function walk(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'function') continue;
      out[k] = walk(val);
    }
    return out;
  }
  return v;
}
