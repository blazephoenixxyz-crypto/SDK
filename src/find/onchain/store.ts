// The index is an append-only list of operations per chain. The state is DERIVED from it (one
// producer): a log count is the number of distinct venues a source holds, never a stored number.
// Venues are written before the cursor that covers them, in one append: a crash between two appends
// leaves a cursor that claims nothing it did not scan. FileStore writes an append as one line, so a
// crash inside it loses the whole chunk, never its cursor alone.
import type { Address, Hex } from 'viem';

export interface CursorOp {
  o: 'c';
  source: Address;
  kind: number;
  /** The contiguous block range scanned, inclusive. */
  from: number;
  to: number;
  /** Hash of block `to` when it was known; null → the tip is not trusted (rescanned from to − 64). */
  hash: Hex | null;
  /** More events than the small-source limit: only the recent window belongs to layer 1. */
  large: boolean;
}
export interface VenueOp { o: 'v'; source: Address; kind: number; venue: Hex; t0: Address; t1: Address; block: number }
/** A log the source emitted that could not be decoded: counted, never guessed. */
export interface MalformedOp { o: 'm'; source: Address; block: number; logIndex: number }
export interface TokenOp {
  o: 'k'; token: Address; status: 'READ' | 'FAILED'; reason?: string;
  symbol: string | null; name: string | null; ks: string | null; kn: string | null; readAtBlock: number;
}
/** Drop what a source found above block `after` (a reorg or an untrusted tip). */
export interface DropOp { o: 'd'; source: Address; after: number }
/** Drop every token text read above block `after` (a reorg): read again by the next text pass. */
export interface TextDropOp { o: 't'; after: number }
/** What the Hub and the target block said on the last update. */
export interface RunOp {
  o: 'r';
  hub: Address;
  head: number; target: number; hash: Hex; by: 'finalized' | 'head-confirmations';
  factoryCount: number | null;
  v4PoolManager: Address | null;
  bridges: Address[] | null;
  /** Counter per source at `target` (allPairsLength/allPoolsLength); null where the factory answered
   *  that it has none (a revert or no data); no key where it was not measured (absent is not zero). */
  counters: Record<string, number | null>;
  /** Hub reads that did not answer (absent is not zero). */
  failed: string[];
}
/** A Hub `Factory_` log: a factory admitted (or refreshed in place) with its kind; the last one wins. */
export interface FactoryOp { o: 'f'; source: Address; factory: Address; kind: number; mode: number; block: number; logIndex: number }
export type IndexOp = CursorOp | VenueOp | MalformedOp | TokenOp | DropOp | TextDropOp | RunOp | FactoryOp;

/** One index per (store, chain), of one Hub: a run refuses a store that holds another Hub's index.
 *  `append` must be atomic per call: the ops of one call are all stored or none (a cursor is appended
 *  with the logs it covers, so a partial append would leave a cursor claiming logs that are missing).
 *  Two calls need not be atomic together; a run stopped between them resumes from the last one. */
export interface IndexStore {
  load(chainId: number): Promise<IndexOp[]>;
  append(chainId: number, ops: readonly IndexOp[]): Promise<void>;
}

/** In memory: the default (browser and Node), shared by every call in this module instance. */
export class MemoryStore implements IndexStore {
  private readonly ops = new Map<number, IndexOp[]>();
  async load(chainId: number) { return [...(this.ops.get(chainId) ?? [])]; }
  async append(chainId: number, ops: readonly IndexOp[]) {
    const l = this.ops.get(chainId) ?? [];
    l.push(...ops.map((o) => structuredClone(o)));
    this.ops.set(chainId, l);
  }
}

export const defaultStore: IndexStore = new MemoryStore();

/** Node only: `<dir>/<chainId>.jsonl`, one append per line (a JSON array of its operations; a line
 *  holding one operation object is read too). node:fs is imported on first use, so a browser bundle
 *  never needs it. A torn last line (a crash mid-write) is ignored on load: its chunk is all or nothing.
 *  One writer per directory and chain: runs in one process wait for each other whichever FileStore
 *  instance (with the same `dir` string) they use; two processes on one directory are not serialized. */
export class FileStore implements IndexStore {
  constructor(readonly dir: string) {}
  private path(chainId: number) { return `${this.dir.replace(/\/+$/, '')}/${chainId}.jsonl`; }
  async load(chainId: number): Promise<IndexOp[]> {
    const fs = await import('node:fs/promises');
    let text: string;
    try { text = await fs.readFile(this.path(chainId), 'utf8'); } catch (e) { if ((e as { code?: string }).code === 'ENOENT') return []; throw e; }
    const out: IndexOp[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      let v: IndexOp | IndexOp[];
      try { v = JSON.parse(line) as IndexOp | IndexOp[]; } catch { continue; /* torn line */ }
      if (Array.isArray(v)) out.push(...v); else out.push(v);
    }
    return out;
  }
  async append(chainId: number, ops: readonly IndexOp[]) {
    if (ops.length === 0) return;
    const fs = await import('node:fs/promises');
    await fs.mkdir(this.dir, { recursive: true });
    // A torn last line has no newline: start on a fresh line, or the first op would join it and be lost.
    const p = this.path(chainId);
    const torn = await fs.open(p, 'r').then(async (h) => {
      try { const { size } = await h.stat(); if (size === 0) return false; const b = new Uint8Array(1); await h.read(b, 0, 1, size - 1); return b[0] !== 0x0a; } finally { await h.close(); }
    }, (e: { code?: string }) => { if (e.code === 'ENOENT') return false; throw e; });
    await fs.appendFile(p, (torn ? '\n' : '') + JSON.stringify(ops) + '\n', 'utf8');
  }
}

export interface IndexedVenue { source: Address; kind: number; venue: Hex; tokens: readonly [Address, Address]; block: number }
export interface Cursor extends Omit<CursorOp, 'o'> { logs: number; malformed: number }

/** The state an op list describes. */
export interface IndexState {
  cursors: Map<string, Cursor>;
  venues: Map<string, Map<string, IndexedVenue>>;
  malformed: Map<string, Set<string>>;
  tokens: Map<string, Omit<TokenOp, 'o'>>;
  /** token (lower case) → its venues */
  byToken: Map<string, IndexedVenue[]>;
  /** factory (lower case) → its last Factory_ log, per Hub */
  factories: Map<string, Omit<FactoryOp, 'o'>>;
  run: RunOp | null;
}

const lc = (s: string) => s.toLowerCase();

export function materialize(ops: readonly IndexOp[]): IndexState {
  const cursors = new Map<string, Omit<CursorOp, 'o'>>();
  const venues = new Map<string, Map<string, IndexedVenue>>();
  const malformed = new Map<string, Map<string, number>>();
  const tokens = new Map<string, Omit<TokenOp, 'o'>>();
  const factoryLogs = new Map<string, Omit<FactoryOp, 'o'>>();
  let run: RunOp | null = null;
  for (const op of ops) {
    switch (op.o) {
      case 'c': { const { o: _o, ...c } = op; cursors.set(lc(op.source), c); break; }
      case 'v': {
        const s = lc(op.source);
        const m = venues.get(s) ?? new Map<string, IndexedVenue>();
        m.set(lc(op.venue), { source: op.source, kind: op.kind, venue: op.venue, tokens: [op.t0, op.t1], block: op.block });
        venues.set(s, m);
        break;
      }
      case 'm': {
        const s = lc(op.source);
        const m = malformed.get(s) ?? new Map<string, number>();
        m.set(`${op.block}:${op.logIndex}`, op.block);
        malformed.set(s, m);
        break;
      }
      case 'f': { const { o: _o, ...f } = op; factoryLogs.set(`${lc(op.source)}:${op.block}:${op.logIndex}`, f); break; }
      case 'k': { const { o: _o, ...t } = op; tokens.set(lc(op.token), t); break; }
      case 'd': {
        const s = lc(op.source);
        for (const [k, v] of venues.get(s) ?? []) if (v.block > op.after) venues.get(s)!.delete(k);
        for (const [k, b] of malformed.get(s) ?? []) if (b > op.after) malformed.get(s)!.delete(k);
        for (const [k, f] of factoryLogs) if (lc(f.source) === s && f.block > op.after) factoryLogs.delete(k);
        break;
      }
      case 't': for (const [k, t] of tokens) if (t.readAtBlock > op.after) tokens.delete(k); break;
      case 'r': run = op; break;
    }
  }
  const out: IndexState = { cursors: new Map(), venues, malformed: new Map(), tokens, byToken: new Map(), factories: new Map(), run };
  const ordered = [...factoryLogs.values()].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  for (const [s, m] of malformed) out.malformed.set(s, new Set(m.keys()));
  for (const [s, c] of cursors) {
    // Count only what lies inside the scanned range: a venue outside it was dropped or never covered.
    const inRange = (b: number) => b >= c.from && b <= c.to;
    const logs = [...(venues.get(s)?.values() ?? [])].filter((v) => inRange(v.block)).length
      + ordered.filter((f) => lc(f.source) === s && inRange(f.block)).length;
    const bad = [...(malformed.get(s)?.values() ?? [])].filter(inRange).length;
    out.cursors.set(s, { ...c, logs: logs + bad, malformed: bad });
  }
  for (const f of ordered) {
    const c = out.cursors.get(lc(f.source));
    if (c && f.block >= c.from && f.block <= c.to) out.factories.set(lc(f.factory), f);
  }
  for (const m of venues.values()) for (const v of m.values()) for (const t of v.tokens) {
    const l = out.byToken.get(lc(t)) ?? [];
    l.push(v);
    out.byToken.set(lc(t), l);
  }
  return out;
}
