// Nitro later sell (-38013), port of deep-xray-tiers RED 3c4a794 -> GREEN 6191343 (test/nitro-later.test.mjs, MT25/25b/25c).
// After N empty simulated blocks the base fee decays to ~32 wei and the L1 poster gas exceeds any call gas. Measured
// (live/nitro-later.mjs, 42161 @523689908, 4663 @112876536, dRPC): without override -> -38013 at gas 300k and 30M;
// blockOverrides.baseFeePerGas = the pinned block's base fee on the later block only -> status 0x1. Off Nitro it changes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../../src/xray/scan.js';
import { makeCtx } from '../../src/xray/ctx.js';
import { fakeNode, isProbe, drive, fakeBlk, TOKEN } from './fake.js';

const hex = (n: bigint | number) => '0x' + BigInt(n).toString(16);
const IDS = { X: '0x' + '11'.repeat(20), Y: '0x' + '22'.repeat(20) };
const BLK = fakeBlk();
const mkFor = (chainId: number) => (o: any = {}) => makeCtx(chainId, TOKEN, BLK, { buyIn: 10n ** 15n, N: 100, mode: 'd4', ...o }, IDS);
const realA = (reqs: any[]) => reqs.filter((q) => q.method === 'eth_simulateV1' && !isProbe(q));
const later = (q: any) => q.params[0].blockStateCalls.filter((b: any) => b.blockOverrides?.number);

test('[nitro-fake] the fake reproduces -38013: a later block without a base fee override fails', async () => {
  const f = fakeNode({ chainId: 42161, nitroLater: true });
  const b = { calls: [{ from: IDS.X, to: IDS.Y, gas: hex(30_000_000), data: '0x095ea7b3' }], blockOverrides: { number: hex(BLK.number + 104) } as any };
  const req = { method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: [{ from: IDS.X, to: IDS.Y, data: '0x095ea7b3' }] }, b], validation: true }, hex(BLK.number)] };
  assert.equal(((await f.send(req)) as any).error?.code, -38013);
  b.blockOverrides.baseFeePerGas = hex(BLK.baseFee);
  assert.equal(((await f.send(req)) as any).error, undefined);
});

for (const chainId of [42161, 8453]) test(`[MT25] ${chainId}: the later sell runs with baseFeePerGas = the pinned base fee, only on that block, no retry`, async () => {
  const f = fakeNode({ chainId, nitroLater: true });
  const r = await drive(scan(mkFor(chainId)), f.transport);
  assert.equal(r.status, 'RAN');
  assert.deepEqual(r.retries ?? [], []);
  assert.equal(r.result.sellLater?.ok, true);
  const L = realA(f.reqs).flatMap(later);
  assert.ok(L.length >= 1);
  for (const b of L) assert.equal(b.blockOverrides.baseFeePerGas, hex(BLK.baseFee)); // MT25b: header B+4 base fee instead
  for (const q of realA(f.reqs)) for (const b of q.params[0].blockStateCalls) if (!b.blockOverrides?.number) assert.equal(b.blockOverrides?.baseFeePerGas, undefined); // MT25c
});
