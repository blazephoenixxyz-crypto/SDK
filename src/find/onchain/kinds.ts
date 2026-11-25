// Creation events by venue kind: DATA, not branches (a new venue shape is one more row). Kinds are
// the Hub's (bp-dex BlazePhoenixCore.sol: KIND_V2 0, KIND_V3 1, KIND_V4 4, KIND_SOLIDLY 5). A kind
// with no row here (Algebra 6, adapters, Gate wrappers) is not scanned: it is reported as not covered.
import type { Address, Hex } from 'viem';

/** Where the venue sits in the log: an indexed topic, or a 32-byte word of the data. */
export type VenueAt = { readonly topic: number } | { readonly word: number };

export interface CreationEvent {
  readonly kind: number;
  readonly signature: string;
  /** keccak256(signature); pinned by a test against an independent hash. */
  readonly topic0: Hex;
  /** Topics holding the two tokens. */
  readonly tokenTopics: readonly [number, number];
  readonly venue: VenueAt;
  /** The data is at least this many 32-byte words long. */
  readonly dataWords: number;
}

export const CREATION_EVENTS: readonly CreationEvent[] = [
  // Uniswap V2 and its forks: data = (pair, allPairs.length).
  { kind: 0, signature: 'PairCreated(address,address,address,uint256)', topic0: '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9', tokenTopics: [1, 2], venue: { word: 0 }, dataWords: 2 },
  // Uniswap V3, PancakeSwap V3, SushiSwap V3: fee indexed, data = (tickSpacing, venue).
  { kind: 1, signature: 'PoolCreated(address,address,uint24,int24,address)', topic0: '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118', tokenTopics: [1, 2], venue: { word: 1 }, dataWords: 2 },
  // Aerodrome Slipstream: tickSpacing indexed, data = (venue).
  { kind: 1, signature: 'PoolCreated(address,address,int24,address)', topic0: '0xab0d57f0df537bb25e80245ef7748fa62353808c54d6e528a9dd20887aed9ac2', tokenTopics: [1, 2], venue: { word: 0 }, dataWords: 1 },
  // Solidly (Aerodrome V2, Velodrome V2): stable indexed, data = (venue, allPools.length).
  { kind: 5, signature: 'PoolCreated(address,address,bool,address,uint256)', topic0: '0x2128d88d14c80cb081c1252a5acff7a264671bf199ce226b53788fb26065005e', tokenTopics: [1, 2], venue: { word: 0 }, dataWords: 2 },
  // Uniswap V4 PoolManager: the venue is the PoolId (topic 1); currency 0 can be native ETH (address 0).
  { kind: 4, signature: 'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)', topic0: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438', tokenTopics: [2, 3], venue: { topic: 1 }, dataWords: 5 },
];

/** Selectors of the counters a factory of this kind may have; the first that answers one word wins. */
export const COUNTERS: Readonly<Record<number, readonly Hex[]>> = {
  0: ['0x574f2ba3'], // allPairsLength()
  1: ['0xefde4e64'], // allPoolsLength() (Slipstream; Uniswap V3 has none and reverts)
  5: ['0xefde4e64'], // allPoolsLength()
};
/** Kinds whose every factory has a counter: one that does not answer is an absent measurement, never a match. */
export const COUNTER_REQUIRED: ReadonlySet<number> = new Set([0, 5]);

/** The Hub's `Factory_(address indexed factory, uint8 kind, uint8 mode)`: the set of factories to scan. */
export const FACTORY_EVENT = {
  signature: 'Factory_(address,uint8,uint8)',
  topic0: '0x7b6dd8d5ecfd4872b6fe986eab1d044b3dca1eceb21817b5ba62084a6b9bd494' as Hex,
} as const;

/** Hub selectors read at the target block. */
export const HUB_CALLS = {
  factoryCount: '0xcc805afa' as Hex,
  v4PoolManager: '0xc0c8eca6' as Hex,
  bridgeCount: '0xfbb2a53f' as Hex,
  /** bridge(uint8) */
  bridge: '0xd80b21d7' as Hex,
} as const;

export const eventsOfKind = (kind: number): readonly CreationEvent[] => CREATION_EVENTS.filter((e) => e.kind === kind);

/** A raw log as eth_getLogs returns it (the fields the index reads). */
export interface RawLog {
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber: string | number | bigint | null;
  logIndex?: string | number | null;
  removed?: boolean;
}

export interface DecodedVenue {
  /** A venue address, or a V4 PoolId (32 bytes). */
  venue: Hex;
  tokens: readonly [Address, Address];
  block: number;
}

const WORD = /^0x[0-9a-f]{64}$/;
const lower = (s: unknown) => (typeof s === 'string' ? s.toLowerCase() : '');
/** A 32-byte word that holds an address: the 12 high bytes are zero. */
const asAddress = (w: string): Address | null => (WORD.test(w) && /^0x0{24}/.test(w) ? (`0x${w.slice(26)}` as Address) : null);
const wordOf = (data: string, i: number) => `0x${data.slice(2 + 64 * i, 2 + 64 * (i + 1))}`;

/** Lowest of a list, in one pass: spreading a long list into Math.min overflows the argument limit. */
export const lowest = (xs: readonly number[]): number | null => {
  let lo: number | null = null;
  for (const x of xs) if (lo === null || x < lo) lo = x;
  return lo;
};

export const blockOf = (v: RawLog['blockNumber']): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : /^0x[0-9a-f]+$/i.test(v) ? parseInt(v, 16) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/** Decode a creation log of a source of `kind`: the row is chosen by topic0 among the rows of that
 *  kind. null when no row matches or the log is malformed (a token topic that is not an address,
 *  data too short): such a log is counted, never guessed. */
export function decodeCreation(kind: number, log: RawLog): DecodedVenue | null {
  const t0 = lower(log.topics?.[0]);
  const row = CREATION_EVENTS.find((e) => e.kind === kind && e.topic0 === t0);
  if (!row) return null;
  const topics = log.topics.map(lower);
  const data = lower(log.data);
  if (!/^0x([0-9a-f]{64})*$/.test(data) || (data.length - 2) / 64 < row.dataWords) return null;
  const a = asAddress(topics[row.tokenTopics[0]] ?? '');
  const b = asAddress(topics[row.tokenTopics[1]] ?? '');
  const block = blockOf(log.blockNumber);
  if (a === null || b === null || block === null) return null;
  let venue: Hex | null;
  if ('topic' in row.venue) {
    const t = topics[row.venue.topic] ?? '';
    venue = WORD.test(t) ? (t as Hex) : null;
  } else {
    venue = asAddress(wordOf(data, row.venue.word));
  }
  if (venue === null || /^0x0+$/.test(venue)) return null;
  return { venue, tokens: [a, b], block };
}
