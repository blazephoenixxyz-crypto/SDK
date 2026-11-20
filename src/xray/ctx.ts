// Port of deep-xray-tiers@1998a4d core/ctx.mjs (feeFor, laterClock) and live/run.mjs (DEP, pinBlock, makeCtx).
// Pure: pinBlock is a generator of exact JSON-RPC batches; makeCtx takes the actors X, Y from the caller (no randomness).
import { getAddress, keccak256 } from 'viem';
import type { Rpc } from './step.js';
import { MC3 } from './abi.js';
const B = (x: any): bigint => BigInt(x);

/**
 * A fee the pinned block B accepts. eth_gasPrice is read at "latest" and can sit below the base fee of B
 * (42161: "max fee per gas less than block base fee"), so gasPrice = max(eth_gasPrice, maxFee).
 */
export function feeFor(blk: any) {
  const bf0 = B(blk.baseFee);
  const bf1 = B(blk.headers[1]?.baseFeePerGas ?? bf0);
  const prio = blk.gasPrice > bf0 ? blk.gasPrice - bf0 : 1n;
  const maxFee = 2n * (bf1 > bf0 ? bf1 : bf0) + prio;
  const gasPrice = blk.gasPrice > maxFee ? blk.gasPrice : maxFee;
  return { prio, maxFee, gasPrice };
}

/** Later-sell clock measured over 5 real blocks: laterTime = h4 + max(1, ceil(N * span / 5)). */
export function laterClock(headers: any, N: any) {
  const span = B(headers[5].timestamp) - B(headers[0].timestamp);
  const adv = (B(N) * span + 4n) / 5n;
  return { span, dt: Number(span) / 5, laterTime: B(headers[4].timestamp) + (adv > 0n ? adv : 1n) };
}

// 1.0.0 deployments: src/deployments.ts; codehash pins: R-rpc-codehash.tsv (drpc). `back` = blocks behind latest.
type Deployment = { readonly router: string; readonly quoter: string; readonly weth: string; readonly rh: string; readonly qh: string; readonly back: number };
const deepFreeze = <T>(o: T): T => { for (const v of Object.values(o as object)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };
/** Frozen in depth: no importer swaps an address or a codehash pin, or adds a chain. */
export const XRAY_DEPLOYMENTS: Readonly<Record<number, Deployment>> = deepFreeze({
  8453: { router: '0x2a779f9Be49aac57495A8B6467Cc325a8a47Eb9f', quoter: '0x4cEF0615614B212895F45Aa1D4833B16666E18d3', weth: '0x4200000000000000000000000000000000000006',
    rh: '0x0e27f3bf65b3205426a66dc83be63da2f237b1d2871b1d9e925089d0c6274b5a', qh: '0x4460c56806aed93e33c7708e2b688b498df08505b96a937c6aa3b5dfbd3cb1ea', back: 10 },
  1: { router: '0xE1aE5f49013920CF71De8CED4043e14C4d63416b', quoter: '0x4a20AA0912388ff7A9221Ab6BFC224cc20Baa0c3', weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    rh: '0xb6200a71740ca586d1804607bd4fb18f87cea7a3fc5751149cc7045e04c01ba8', qh: '0x1f4ed21d01bf221e709f43f8dfc59010ea5646bbe40df19ff0fe373588e4aa6f', back: 6 },
  42161: { router: '0x7262e7483ab6f0db7b8f90eC3a9de3B02Ab36F6A', quoter: '0xfB18EF6f62A0278A273Af4b7A46b454F9E482dc2', weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    rh: '0x28cd7e5d22ac01dc2b2a69414227412cccddeea8eb54bee79fb98ebf7e4c92aa', qh: '0xdb0ed3f4236747d427390050de99b09cd2dd5f53c6dd4f0222ba3a02fa3e2684', back: 40 },
});
/** Multicall3 runtime codehash, the same on 1, 8453 and 42161 (eth_getCode via dRPC, 3808 bytes; W2-core-5). */
export const MC3_CODEHASH = '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891';
const res = (r: any, what: string) => {
  if (r === null || typeof r !== 'object' || !Object.hasOwn(r, 'result') || r.result === null || r.result === undefined) throw new Error('pin: no result for ' + what);
  return r.result;
};
export type Blk = { number: number; hash: string; timestamp: bigint; baseFee: bigint; headers: any[]; gasPrice: bigint;
  /** Code read at the pinned block: the token has code; Multicall3 has the pinned codehash (else tier C is unavailable). */
  code?: { token: boolean; mc3: boolean } };

/**
 * Pin the block: chainId check, latest - back, 6 headers, then one code batch at headers[0]: router/quoter codehash
 * (fail closed), token code and Multicall3 codehash (reported in `code`, never thrown: the caller decides).
 */
export function* pinBlock(chainId: number, token: string): Generator<Rpc[], Blk, unknown[]> {
  const d = XRAY_DEPLOYMENTS[chainId];
  if (!d) throw new Error('no deployment on chain ' + chainId);
  const [c, lat, gp] = yield [{ method: 'eth_chainId', params: [] }, { method: 'eth_blockNumber', params: [] }, { method: 'eth_gasPrice', params: [] }];
  if (parseInt(res(c, 'eth_chainId'), 16) !== chainId) throw new Error('chainId mismatch');
  const n = parseInt(res(lat, 'eth_blockNumber'), 16) - d.back;
  const hs = (yield [0, 1, 2, 3, 4, 5].map((k) => ({ method: 'eth_getBlockByNumber', params: ['0x' + (n + k).toString(16), false] }))).map((h, k) => res(h, 'header ' + (n + k)));
  const codes = yield [d.router, d.quoter, token, MC3].map((a) => ({ method: 'eth_getCode', params: [a, { blockHash: hs[0].hash }] }));
  [d.rh, d.qh].forEach((want, i) => { if (keccak256(res(codes[i], 'eth_getCode')) !== want) throw new Error('codehash mismatch ' + (i ? d.quoter : d.router)); });
  return { number: n, hash: hs[0].hash, timestamp: B(hs[0].timestamp), baseFee: B(hs[0].baseFeePerGas ?? 0), headers: hs, gasPrice: B(res(gp, 'eth_gasPrice')),
    code: { token: /^0x[0-9a-fA-F]+$/.test(res(codes[2], 'eth_getCode')), mc3: keccak256(res(codes[3], 'eth_getCode')) === MC3_CODEHASH } };
}

export function makeCtx(chainId: number, token: string, blk: Blk, { buyIn, N, mode, clock = 'measured', gas = 'fixed' }: any, ids: { X: string; Y: string }) {
  if (!ids?.X || !ids?.Y) throw new Error('makeCtx: X and Y come from the caller');
  const d = XRAY_DEPLOYMENTS[chainId];
  const h = blk.headers;
  const fee = feeFor(blk);
  const { dt, laterTime } = laterClock(h, N);
  const bo = (k: number) => {
    if (k === 5) return { number: '0x' + (blk.number + 4 + N).toString(16), ...(clock === 'node' ? {} : { time: '0x' + laterTime.toString(16) }), ...(mode === 'd4' ? { prevRandao: h[4].mixHash, feeRecipient: h[4].miner, gasLimit: h[4].gasLimit } : {}) };
    return mode === 'd4' ? { prevRandao: h[k].mixHash, feeRecipient: h[k].miner, time: h[k].timestamp, gasLimit: h[k].gasLimit } : undefined;
  };
  return { chainId, token: getAddress(token), router: d.router, quoter: d.quoter, weth: d.weth, X: getAddress(ids.X), Y: getAddress(ids.Y), funder: d.weth,
    buyIn: B(buyIn), sellFracBps: 5000n, transferFracBps: 1000n, poolFracBps: 1000n, block: blk, deadline: blk.timestamp + 3600n,
    laterDeadline: (clock === 'node' ? laterTime + 12n * B(N) : laterTime) + 600n, N, dt, laterTime, mode, clock, gas, gasLimit: B(h[0].gasLimit), blockOverrides: bo,
    fee, xBalance: B(buyIn) + 200_000_000n * fee.maxFee };
}
