// Lesson (c): a provider that is unavailable is a fact about the provider, not about the token. 429, -32005,
// dRPC code 12 ("Can't route your request", R-rpc.md:51,81: "not measured", not "unsupported"), HTTP 5xx,
// a transport failure and an answer with neither result nor error are NOT_MEASURED "provider unavailable":
// they never step a tier down and never give MEASURED. A limit in the middle of a scan (the tier answered,
// then 429) never lifts the verdict above what was measured. Each test names its mutant (xray-ship/mut.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../../src/xray/scan.js';
import { makeCtx } from '../../src/xray/ctx.js';
import { runXray } from '../../src/xray/index.js';
import { classifyRpcReply } from '../../src/xray/rpc.js';
import { classifyProbe, LADDER } from '../../src/xray/tiers.js';
import { fakeNode, drive, fakeBlk, isProbe, rungOf, TOKEN, type FakeOpts } from './fake.js';
import type { Rpc } from '../../src/xray/step.js';

const IDS = { X: '0x' + '11'.repeat(20), Y: '0x' + '22'.repeat(20) };
const BLK = fakeBlk();
const mk = (o: any = {}) => makeCtx(8453, TOKEN, BLK, { buyIn: 10n ** 15n, N: 100, mode: 'd4', ...o }, IDS);
const E = (code: number, message = 'x') => ({ jsonrpc: '2.0', id: 1, error: { code, message } });
const IN = { chainId: 8453, token: TOKEN, amountIn: 10n ** 15n, maxTaxBps: 500 };
const CODE12 = "Can't route your request to suitable provider, if you specified certain providers revise the list";

/** Unavailable answers; `real` is the answer the node would have given (a good body under a bad status). */
const V: [string, (real: unknown) => unknown][] = [
  ['HTTP 429', () => ({ httpStatus: 429 })],
  ['HTTP 429 + good body', (real) => ({ httpStatus: 429, body: real })],
  ['JSON-RPC 429', () => E(429, 'Too Many Requests')],
  ['JSON-RPC -32005', () => E(-32005, 'limit exceeded')],
  ['JSON-RPC 12 (dRPC routing)', () => E(12, CODE12)],
  ['HTTP 400 + JSON-RPC 12 body', () => ({ httpStatus: 400, body: JSON.stringify(E(12, CODE12)) })],
  ['HTTP 500 + good body', (real) => ({ httpStatus: 500, body: real })],
  ['HTTP 503 + -32601 body', () => ({ httpStatus: 503, body: E(-32601, 'the method eth_simulateV1 does not exist') })],
  ['HTTP 502, no body', () => ({ httpStatus: 502 })],
  ['transport failure', () => ({ transportError: 'ECONNRESET' })],
  ['neither result nor error', () => ({ jsonrpc: '2.0', id: 1 })],
  ['null', () => null],
];

/** The node's transport with the k-th request matching `pick` replaced by f(real answer). */
function inject(node: ReturnType<typeof fakeNode>, pick: (q: any) => boolean, k: number, f: (real: unknown) => unknown) {
  let n = 0;
  return async (batch: Rpc[]) => { const real = await node.transport(batch); return real.map((a, j) => (pick(batch[j]) && ++n === k ? f(a) : a)); };
}
const realOf = (rung: string) => (q: any) => (q.method === 'eth_simulateV1' || q.method === 'eth_call') && !isProbe(q) && rungOf(q)[0] === rung;
const probeOf = (rung: string) => (q: any) => (q.method === 'eth_simulateV1' || q.method === 'eth_call') && isProbe(q) && rungOf(q) === rung;

test('[R-u1] code 12 (dRPC routing) is provider unavailable, also as an HTTP 400 body; never a missing tier [R-u12]', () => {
  for (const r of [E(12, CODE12), { httpStatus: 400, body: E(12, CODE12) }, { httpStatus: 200, body: E(12, CODE12) }]) {
    assert.deepEqual(classifyRpcReply(r as any), { cls: 'unavailable', why: 'provider unavailable' }, JSON.stringify(r));
    for (const t of ['A', 'B', 'C']) assert.equal(classifyProbe(t, r).cls, 'unavailable', t);
  }
  // neighbours of 12 stay JSON-RPC errors (the set is exact, not a range)
  for (const code of [11, 13, -12]) assert.equal(classifyRpcReply(E(code) as any).cls, 'error', String(code));
});

// Probe position: every rung before the injected one answers -32601 (a missing tier), the injected one is unavailable.
for (const [i, rung] of LADDER.entries()) for (const [name, f] of V) {
  test(`[R-u2] ${name} on the ${rung} probe: NOT_MEASURED provider unavailable, no step-down, nothing else asked [R-u12 R-ustep R-uabs R-u5xx]`, async () => {
    const no = E(-32601, 'no');
    const node = fakeNode({ probe: Object.fromEntries(LADDER.slice(0, i).map((r) => [r, no])) });
    const r: any = await drive(scan(mk), inject(node, probeOf(rung), 1, f));
    assert.equal(r.status, 'NOT_MEASURED'); assert.equal(r.why, 'provider unavailable'); assert.equal(r.tier, null);
    assert.deepEqual(r.probes.map((p: any) => p.rung), LADDER.slice(0, i + 1));
    assert.equal(node.reqs.length, i + 1);
  });
}

test('[R-u2] end to end: each unavailable answer on the first probe gives WARN, never MEASURED [R-u12 R-ustep]', async () => {
  for (const [name, f] of V) {
    const node = fakeNode();
    const r = await runXray(inject(node, probeOf('A:d4'), 1, f), IN);
    assert.equal(r.verdict, 'WARN', name); assert.equal(r.rung, null, name);
    for (const ins of r.instruments) assert.equal(ins.status, 'NOT_MEASURED', name + ' ' + ins.name);
    assert.match(r.instruments.find((x) => x.name === 'sim')!.reason, /provider unavailable/, name);
    assert.equal(node.reqs.filter((q: any) => q.method === 'eth_simulateV1').length, 1, name);
  }
});

// A limit in the middle of the scan: tier A answered the probe and k - 1 rounds, then round k is unavailable.
async function roundsOf(o: FakeOpts, rung: string) {
  const node = fakeNode(o);
  const r: any = await drive(scan(mk), node.transport);
  assert.equal(r.status, 'RAN'); assert.equal(r.rung[0], rung);
  return node.reqs.filter(realOf(rung)).length;
}
const NO_A = { 'A:d4': E(-32601, 'no'), 'A:d2': E(-32601, 'no') };
for (const [rung, o] of [['A', {}], ['B', { probe: NO_A }], ['C', { probe: { ...NO_A, B: E(-32602, 'no') } }]] as [string, FakeOpts][]) {
  test(`[R-u3] tier ${rung} answered, then a limit at every round: NOT_MEASURED provider unavailable, same rung, nothing more asked [R-uwhy R-upartial R-u12]`, async () => {
    const R = await roundsOf(o, rung);
    assert.ok(rung === 'B' ? R === 1 : R >= 5, 'rounds ' + R);
    for (let k = 1; k <= R; k++) for (const [name, f] of V) {
      const node = fakeNode(o);
      const r: any = await drive(scan(mk), inject(node, realOf(rung), k, f));
      const at = `${name} at round ${k}`;
      assert.equal(r.status, 'NOT_MEASURED', at); assert.equal(r.tier, rung, at); assert.match(r.why, /^provider unavailable/, at);
      assert.equal(r.result, undefined, at); assert.deepEqual(r.retries ?? [], [], at);
      assert.equal(node.reqs.filter(realOf(rung)).length, k, at);
      for (const later of ['A', 'B', 'C'].filter((t) => t > rung)) assert.equal(node.reqs.filter((q: any) => rungOf(q)[0] === later).length, 0, at);
    }
  });
}

test('[R-u4] end to end: tier A answered, then a limit at every round: verdict WARN, never above what was measured [R-uwhy R-upartial]', async () => {
  const R = await roundsOf({}, 'A');
  assert.equal((await runXray(fakeNode().transport, IN)).verdict, 'MEASURED'); // control: the full run measures
  for (let k = 1; k <= R; k++) for (const [name, f] of V) {
    const r = await runXray(inject(fakeNode(), realOf('A'), k, f), IN);
    const at = `${name} at round ${k}`;
    assert.equal(r.verdict, 'WARN', at); assert.equal(r.rung, 'A:d4', at);
    const sim = r.instruments.find((x) => x.name === 'sim')!;
    assert.equal(sim.status, 'NOT_MEASURED', at); assert.match(sim.reason, /^provider unavailable/, at);
    assert.ok(r.instruments.every((x) => x.status !== 'MEASURED'), at);
    assert.deepEqual(r.legs.map((l) => l.amountIn), [null, null, null], at);
  }
});
