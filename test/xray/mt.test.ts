// MT1-MT14: port of deep-xray-tiers test/tiers.test.mjs:19-140 and test/ctx.test.mjs:8-23 (MT7, MT9) to the
// sans-IO TS core. Tier choice by a token-independent probe (decision 12), token errors never move the rung, A
// retries by code, the report carries tier + uncovered classes, nothing says "reverted" for a step that did not run.
// MT14 was rowsFor (live/batch.mjs, a CLI); here it is the SDK's own text and instruments (runXray).
import test from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../../src/xray/scan.js';
import { makeCtx, feeFor, laterClock } from '../../src/xray/ctx.js';
import { runXray } from '../../src/xray/index.js';
import { PROBE, MC3 } from '../../src/xray/abi.js';
import { classifyProbe, prepareA, prepareB, prepareC, prepareProbe, l1Gas, GAS_B, aRetry, tierVerdict, TIER_UNCOVERED } from '../../src/xray/tiers.js';
import { fakeNode, drive, fakeBlk, TOKEN, BPC_TRANSFER, type FakeOpts } from './fake.js';

const hex = (n: bigint | number) => '0x' + BigInt(n).toString(16);
const IDS = { X: '0x' + '11'.repeat(20), Y: '0x' + '22'.repeat(20) };
const BLK = fakeBlk();
const mkFor = (chainId: number) => (o: any = {}) => makeCtx(chainId, TOKEN, BLK, { buyIn: 10n ** 15n, N: 100, mode: 'd4', ...o }, IDS);
const mk = mkFor(8453);
const run = async (o: FakeOpts = {}, chainId = 8453) => { const node = fakeNode({ ...o, chainId }); const r: any = await drive(scan(mkFor(chainId)), node.transport); return { r, node }; };
const E = (code: number, message = 'x', extra = {}) => ({ jsonrpc: '2.0', id: 1, error: { code, message, ...extra } });
const IN = { chainId: 8453, token: TOKEN, amountIn: 10n ** 15n, maxTaxBps: 500 };

// ---- classifyProbe
test('[MT2] probe: 429 / -32005 / http / transport / non-JSON -> provider unavailable, on every tier', () => {
  for (const t of ['A', 'B', 'C']) for (const r of [{ httpStatus: 429 }, { httpStatus: 503 }, E(429), E(-32005), { transportError: 'timeout' }, { body: '<html>' }, undefined]) {
    const c: any = classifyProbe(t, r);
    assert.equal(c.cls, 'unavailable', t + JSON.stringify(r)); assert.equal(c.why, 'provider unavailable');
  }
});
test('[MT11] probe: a non-revert error steps down (-32601, -32602, -32000); 12 routing is provider unavailable (R-rpc.md:51,81)', () => {
  const real = [E(-32601, 'the method eth_simulateV1 does not exist/is not available'), E(-32602, 'invalid argument'), E(-32000, 'BLOBBASEFEE is not supported on Arbitrum')];
  for (const t of ['A', 'B', 'C']) for (const r of real) assert.equal((classifyProbe(t, r) as any).cls, 'down', t + r.error.code);
  for (const t of ['A', 'B', 'C']) assert.deepEqual(classifyProbe(t, E(12, "Can't route your request to suitable provider")), { cls: 'unavailable', why: 'provider unavailable' }, t);
});
test('probe: an executed revert is NOT_MEASURED "probe reverted" (decision 1); ok answers run; wrong shape steps down', () => {
  assert.equal((classifyProbe('A', { result: [{ calls: [{ status: '0x0', returnData: '0x' }] }] }) as any).cls, 'reverted');
  assert.equal((classifyProbe('B', E(3, 'execution reverted', { data: '0x' })) as any).cls, 'reverted');
  assert.equal((classifyProbe('A', { result: [{ calls: [{ status: '0x1', returnData: '0x' }] }] }) as any).cls, 'ok');
  assert.equal((classifyProbe('B', { result: '0x' }) as any).cls, 'ok');
  assert.equal((classifyProbe('A', { result: [] }) as any).cls, 'down');
});
// ---- the probe has the same request shape as the rung's real calls
test('[MT3a][MT3b][MT3c][MT4a][MT4b][MT4c] probe and real requests: fee-carrying, pinned block, same keys', () => {
  const c = mk();
  const a: any = prepareA(c, {}).req, pa: any = prepareProbe('A:d4', c).req;
  assert.equal(a.params[1], hex(BLK.number)); assert.equal(pa.params[1], hex(BLK.number));
  const ca = a.params[0].blockStateCalls[0].calls[0], cp = pa.params[0].blockStateCalls[0].calls[0];
  assert.equal(ca.maxFeePerGas, hex(c.fee.maxFee)); assert.equal(cp.maxFeePerGas, hex(c.fee.maxFee));
  assert.deepEqual(Object.keys(cp).sort(), Object.keys(ca).sort());
  assert.deepEqual(pa.params[0].blockStateCalls[0].blockOverrides, a.params[0].blockStateCalls[0].blockOverrides);
  assert.deepEqual(pa.params[0].blockStateCalls[0].stateOverrides, a.params[0].blockStateCalls[0].stateOverrides);
  assert.equal(pa.params[0].validation, true);
  assert.equal(cp.value, '0x1'); assert.equal(cp.to, c.Y);
  const b: any = prepareB(c, c.X).req, pb: any = prepareProbe('B', c).req;
  for (const q of [b, pb]) { assert.deepEqual(q.params[1], { blockHash: BLK.hash }); assert.equal(q.params[0].gasPrice, hex(c.fee.gasPrice)); assert.equal(q.params[2][c.X].code, PROBE.runtime); }
  const cc: any = prepareC(c, {}).req, pc: any = prepareProbe('C', c).req;
  for (const q of [cc, pc]) { assert.deepEqual(q.params[1], { blockHash: BLK.hash }); assert.equal(q.params[0].gasPrice, hex(c.fee.gasPrice)); assert.equal(q.params[0].to, MC3); assert.equal(q.params[0].from, c.funder); }
});
test('[MT12] l1gas mode: every A call gets min(GAS_B, gasLimit / steps)', () => {
  assert.equal(l1Gas(0x4000000000000n, 50), GAS_B);
  assert.equal(l1Gas(100_000_000n, 50), 2_000_000n);
  assert.equal(l1Gas(GAS_B * 50n + 49n, 50), GAS_B); // boundary: one wei over GAS_B per step is still GAS_B
  const q: any = prepareA(mk({ gas: 'l1gas' }), {}).req;
  for (const c of q.params[0].blockStateCalls.flatMap((b: any) => b.calls)) assert.equal(c.gas, hex(GAS_B));
});
// ---- ctx (deep-xray-tiers test/ctx.test.mjs)
test('[MT7] feeFor: maxFee = 2*max(bf_B, bf_B+1) + prio; gasPrice = max(eth_gasPrice, maxFee)', () => {
  const blk = { baseFee: 20_104_000n, gasPrice: 6_000_000n, headers: [{ baseFeePerGas: hex(20_104_000) }, { baseFeePerGas: hex(20_108_000) }] };
  assert.deepEqual(feeFor(blk), { prio: 1n, maxFee: 40_216_001n, gasPrice: 40_216_001n }); // eth_gasPrice below the base fee
  const hi = feeFor({ ...blk, gasPrice: 10n ** 11n });
  assert.ok(hi.gasPrice >= 10n ** 11n); assert.equal(hi.gasPrice, hi.maxFee); assert.equal(hi.prio, 10n ** 11n - 20_104_000n);
  assert.equal(feeFor({ ...blk, gasPrice: 20_104_000n }).prio, 1n); // gasPrice == baseFee -> prio floor 1 wei
});
test('[MT9] laterClock: span over 5 real blocks, advance ceil(N*span/5), floor 1 s', () => {
  const H = [1794517790, 1794517790, 1794517791, 1794517791, 1794517791, 1794517791].map((t) => ({ timestamp: hex(t) }));
  assert.deepEqual(laterClock(H, 100), { span: 1n, dt: 0.2, laterTime: 1794517811n }); // sub-second blocks
  assert.equal(laterClock(H, 0).laterTime, 1794517792n); // N=0: still +1 s
  assert.equal(laterClock(H.map(() => H[0]), 100).laterTime, 1794517791n); // span 0: +1 s
  const eth = H.map((_, k) => ({ timestamp: hex(1000 + 12 * k) }));
  assert.equal(laterClock(eth, 100).laterTime, 1048n + 1200n); // 12 s blocks: N*12
});
// ---- scan
test('[MT1] scan probes A first on every chain (no chainId table): 8453 and 42161 -> A:d4', async () => {
  for (const id of [8453, 42161]) { const { r, node } = await run({}, id); assert.equal(r.rung, 'A:d4'); assert.equal(r.status, 'RAN'); assert.equal(node.reqs[0].method, 'eth_simulateV1'); }
});
test('scan happy path: rung A:d4, probe ok, buy, sell and later sell ran', async () => {
  const { r } = await run();
  assert.equal(r.tier, 'A'); assert.deepEqual(r.probes.map((p: any) => p.rung + ':' + p.cls), ['A:d4:ok']);
  assert.equal(r.result.buy.ok, true); assert.equal(r.result.sell.ok, true); assert.equal(r.result.sellLater?.ok, true);
});
test('[MT11] code 12 on the d4 probe (R-rpc.tsv:50) -> NOT_MEASURED provider unavailable, no step-down to A:d2', async () => {
  const { r, node } = await run({ probe: { 'A:d4': E(12, "Can't route your request to suitable provider") } });
  assert.equal(r.status, 'NOT_MEASURED'); assert.equal(r.why, 'provider unavailable'); assert.equal(r.tier, null);
  assert.deepEqual(r.probes.map((p: any) => p.rung), ['A:d4']); assert.equal(node.reqs.length, 1);
});
test('-32601 on both A probes (simulateV1 absent, R-rpc.tsv:72) -> B measures', async () => {
  const no = E(-32601, 'the method eth_simulateV1 does not exist/is not available');
  const { r } = await run({ probe: { 'A:d4': no, 'A:d2': no } });
  assert.equal(r.rung, 'B'); assert.equal(r.status, 'RAN'); assert.equal(r.result.sell.ok, true);
});
test('B probe -32602 (override refused) -> C measures', async () => {
  const no = E(-32601, 'no'); const { r } = await run({ probe: { 'A:d4': no, 'A:d2': no, B: E(-32602, 'invalid argument 2') } });
  assert.equal(r.rung, 'C'); assert.equal(r.status, 'RAN');
});
test('[MT2] 429 on the first probe -> NOT_MEASURED provider unavailable, nothing else asked', async () => {
  const { r, node } = await run({ probe: { 'A:d4': { httpStatus: 429 } } });
  assert.equal(r.status, 'NOT_MEASURED'); assert.equal(r.why, 'provider unavailable'); assert.equal(node.reqs.length, 1);
});
test('[MT2b] end to end: HTTP 500 carrying a good result body is provider unavailable, never MEASURED', async () => {
  const body = { jsonrpc: '2.0', id: 1, result: [{ calls: [{ status: '0x1', returnData: '0x' }] }] };
  const f = fakeNode({ probe: { 'A:d4': { httpStatus: 500, body } } });
  const r = await runXray(f.transport, IN);
  assert.equal(r.rung, null); assert.equal(r.verdict, 'WARN');
  const sim = r.instruments.find((i) => i.name === 'sim')!;
  assert.equal(sim.status, 'NOT_MEASURED'); assert.match(sim.reason, /provider unavailable/);
  assert.equal(f.reqs.filter((q) => q.method === 'eth_simulateV1').length, 1);
});
test('probe reverted -> NOT_MEASURED "probe reverted", no step-down', async () => {
  const { r, node } = await run({ probe: { 'A:d4': { jsonrpc: '2.0', id: 1, result: [{ calls: [{ status: '0x0', returnData: '0x' }] }] } } });
  assert.equal(r.status, 'NOT_MEASURED'); assert.equal(r.why, 'probe reverted'); assert.equal(node.reqs.length, 1);
});
test('[MT6a] a token-call error with a step-down code never moves the rung (-32602 in round 2)', async () => {
  const { r, node } = await run({ tokenErr: { 'A:d4': { 2: E(-32602, 'invalid argument') } } });
  assert.equal(r.rung, 'A:d4'); assert.equal(r.status, 'NOT_MEASURED'); assert.equal(r.code, -32602);
  assert.ok(node.reqs.every((q: any) => q.method === 'eth_simulateV1'));
});
test('[MT6b] a token-call "not supported" text never moves the rung', async () => {
  const { r } = await run({ tokenErr: { 'A:d4': { 3: E(-32000, 'BLOBBASEFEE is not supported on Arbitrum') } } });
  assert.equal(r.rung, 'A:d4'); assert.equal(r.status, 'NOT_MEASURED'); assert.equal(r.code, -32000);
});
test('[MT8] -38021 in the later block -> one retry with the node clock, labelled', async () => {
  const { r } = await run({ nodeclockErr: true });
  assert.equal(r.status, 'RAN'); assert.deepEqual(r.retries, ['nodeclock']); assert.equal(r.clock, 'node'); assert.equal(r.result.sellLater?.ok, true);
});
test('[MT12] -38013 intrinsic gas -> one retry with l1gas; both faults accumulate; each retry once', async () => {
  const one = (await run({ l1gasErr: true })).r;
  assert.equal(one.status, 'RAN'); assert.deepEqual(one.retries, ['l1gas']); assert.equal(one.gas, 'l1gas');
  const two = (await run({ l1gasErr: true, nodeclockErr: true })).r;
  assert.equal(two.status, 'RAN'); assert.deepEqual([...two.retries].sort(), ['l1gas', 'nodeclock']);
  assert.equal(aRetry({ status: 'NOT_MEASURED', code: -38021 }, ['nodeclock']), null);
});
test('[MT10] sell revert inside simulateV1 (payload only in error.data) is measured as a revert with its data', async () => {
  const { r } = await run({ sellRevert: true });
  assert.equal(r.status, 'RAN'); assert.equal(r.result.sell.ok, false); assert.equal(r.result.sell.revertData, BPC_TRANSFER);
});
test('[MT13] report carries the tier and the classes it does not cover', async () => {
  assert.deepEqual(TIER_UNCOVERED.A, []);
  assert.ok(TIER_UNCOVERED.B.includes('a6'));
  for (const k of [...TIER_UNCOVERED.B, 'a1', 'a7']) assert.ok(TIER_UNCOVERED.C.includes(k), k);
  const no = E(-32601, 'no'); const { r } = await run({ probe: { 'A:d4': no, 'A:d2': no } });
  assert.deepEqual(r.uncovered, TIER_UNCOVERED.B); assert.ok(r.limits.length > 0);
});
test('[MT5] tierVerdict is the infimum', () => {
  assert.equal(tierVerdict({ A: 'MEASURED', C: 'CONDEMN' }).v, 'CONDEMN');
  assert.equal(tierVerdict({ A: 'WARN', B: 'MEASURED' }).v, 'WARN');
});
// ---- MT14: nothing says "reverted" for a step that did not run
for (const [o, step] of [[{ noSellRoute: true }, 'sell'], [{ noRoute: true }, 'buy']] as const) {
  test(`[MT14] ${step} did not run: "${step} not measured", never "reverted" (text and instruments)`, async () => {
    const r = await runXray(fakeNode(o).transport, IN);
    const sim = r.instruments.find((i) => i.name === 'sim')!;
    assert.equal(sim.status, 'NOT_MEASURED'); assert.equal(sim.reason, `${step} not measured`);
    assert.equal((sim.values as any)[`${step}Ok`], null);
    assert.doesNotMatch(r.text, /revert/i);
    for (const i of r.instruments) assert.doesNotMatch(String(i.reason), /revert/i, i.name);
  });
}
