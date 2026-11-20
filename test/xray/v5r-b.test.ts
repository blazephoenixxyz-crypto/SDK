// Wave 5r (sub-b): review threads on ctx.ts:63, index.ts:50, scan.ts:12, step.ts:34 and step.ts:102.
// Each test fails at 540fd63 and passes with the fix; the mutant that reverts each fix is listed in mut.mjs (5r-b*).
import test from 'node:test';
import assert from 'node:assert/strict';
import { xrayStart, xrayStep, runXray, XrayError, type Rpc } from '../../src/xray/index.js';
import { fakeNode, header, TOKEN, LATEST } from './fake.js';

const IN = { chainId: 8453, token: TOKEN, amountIn: 10n ** 15n, maxTaxBps: 500 };
const PIN = LATEST - 10; // Base: back = 10
const hex = (n: number) => '0x' + n.toString(16);
const isRepin = (r: Rpc, seenSim: boolean) => seenSim && r.method === 'eth_getBlockByNumber' && r.params[0] === hex(PIN);
const circular = () => { const e: any = { message: 'socket hang up' }; e.self = e; return { transportError: e }; };

/** The fake node, with the block at the pinned number re-read after tier A answered by `repin` (a reply or a throw). */
function reorgNode(repin: (r: Rpc) => unknown, opts: Parameters<typeof fakeNode>[0] = {}) {
  const f = fakeNode(opts);
  let seenSim = false;
  const transport = async (batch: Rpc[]) => {
    const out = await f.transport(batch);
    return batch.map((r, i) => {
      const v = isRepin(r, seenSim) ? repin(r) : out[i];
      if (r.method === 'eth_simulateV1') seenSim = true;
      return v;
    });
  };
  return { transport, reqs: f.reqs };
}

// ---- ctx.ts:63: tier A simulates at the pinned NUMBER; the report must not name a hash that was not measured.
test('tier A: the block at the pinned number re-read with the pinned hash keeps the measurement', async () => {
  const n = reorgNode(() => ({ jsonrpc: '2.0', id: 1, result: header(PIN) }));
  const r = await runXray(n.transport, IN);
  assert.equal(r.rung, 'A:d4');
  assert.equal(r.instruments[0].status, 'MEASURED');
  assert.equal(r.block.hash, header(PIN).hash);
});

test('tier A: a different hash at the pinned number after the run (reorg) is NOT_MEASURED, never MEASURED', async () => {
  const other = { ...header(PIN), hash: '0x' + 'ee'.repeat(32) };
  const n = reorgNode(() => ({ jsonrpc: '2.0', id: 1, result: other }));
  const r = await runXray(n.transport, IN);
  assert.ok(n.reqs.some((q, i) => q.method === 'eth_getBlockByNumber' && q.params[0] === hex(PIN) && n.reqs.slice(0, i).some((p) => p.method === 'eth_simulateV1')), 'pinned number re-read after tier A');
  assert.ok(r.instruments.every((i) => i.status !== 'MEASURED' && i.status !== 'CLEAN'), JSON.stringify(r.instruments.map((i) => i.status)));
  assert.equal(r.instruments[0].status, 'NOT_MEASURED');
  assert.match(r.instruments[0].reason, /pinned block/);
  assert.notEqual(r.verdict, 'CLEAN');
});

test('tier A: a reorg after the run never turns a CONDEMN into NOT_MEASURED (tax lower bound >= maxTaxBps condemns at every tier)', async () => {
  const other = { ...header(PIN), hash: '0x' + 'ee'.repeat(32) };
  for (const opts of [{ taxBps: 1000n }, { sellRevert: true }]) {
    const base = await runXray(fakeNode(opts).transport, IN);
    assert.equal(base.verdict, 'CONDEMN', `control without reorg: ${JSON.stringify(opts, (_, v) => typeof v === 'bigint' ? String(v) : v)}`);
    const n = reorgNode(() => ({ jsonrpc: '2.0', id: 1, result: other }), opts);
    const r = await runXray(n.transport, IN);
    assert.ok(n.reqs.some((q, i) => q.method === 'eth_getBlockByNumber' && q.params[0] === hex(PIN) && n.reqs.slice(0, i).some((p) => p.method === 'eth_simulateV1')), 'pinned number re-read after tier A');
    assert.equal(r.verdict, 'CONDEMN', JSON.stringify(r.instruments.map((i) => i.status)));
    assert.equal(r.rung, base.rung);
  }
});

test('tier A: the re-read that fails, errors or returns null is NOT_MEASURED (absent is not the pinned hash)', async () => {
  for (const reply of [{ transportError: 'reset' }, { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'x' } }, { jsonrpc: '2.0', id: 1, result: null },
    { jsonrpc: '2.0', id: 1, result: { number: hex(PIN) } }, null]) {
    const r = await runXray(reorgNode(() => reply).transport, IN);
    assert.equal(r.instruments[0].status, 'NOT_MEASURED', JSON.stringify(reply));
    assert.notEqual(r.verdict, 'CLEAN');
  }
});

// ---- index.ts:50: a rejected batch is a failed reply, never an exception after the pin and never a step-down.
test('runXray: a rejected token-call batch is provider unavailable at tier A (NOT_MEASURED, no step-down)', async () => {
  const f = fakeNode();
  const r = await runXray(async (b) => { if (b[0].method === 'eth_simulateV1' && b[0].params[0] && (b[0].params[0] as any).blockStateCalls.flatMap((x: any) => x.calls).length > 1) throw new Error('ECONNRESET'); return f.transport(b); }, IN);
  assert.equal(r.rung, 'A:d4');
  assert.equal(r.instruments[0].status, 'NOT_MEASURED');
  assert.match(r.instruments[0].reason, /provider unavailable/);
  assert.ok(!f.reqs.some((q) => q.method === 'eth_call'), 'no request of tier B or C');
});

test('runXray: a rejected probe batch is provider unavailable, the ladder does not step down', async () => {
  const f = fakeNode();
  const r = await runXray(async (b) => { if (b[0].method === 'eth_simulateV1') throw new Error('timeout'); return f.transport(b); }, IN);
  assert.equal(r.instruments[0].status, 'NOT_MEASURED');
  assert.match(r.instruments[0].reason, /provider unavailable/);
  assert.ok(!f.reqs.some((q) => q.method === 'eth_call'), 'no request of tier B or C');
});

test('runXray: a rejected pin batch fails as a failed pin reply does (no block, no report), not with the raw rejection', async () => {
  const f = fakeNode();
  await assert.rejects(runXray(async (b) => { if (b[0].method === 'eth_getCode') throw Object.create(null); return f.transport(b); }, IN), /pin: no result/);
  await assert.rejects(runXray(async () => { throw new Error('down'); }, IN), /pin: no result/);
  await assert.rejects(runXray(((): Promise<unknown[]> => { throw new Error('sync'); }) as any, IN), /pin: no result/);
});

// ---- scan.ts:12: formatting the diagnostic of an unavailable reply never replaces NOT_MEASURED with an exception.
test('a circular transportError on the tier A token call is NOT_MEASURED (provider unavailable)', async () => {
  const f = fakeNode({ tokenErr: { 'A:d4': { 1: circular() } } });
  const r = await runXray(f.transport, IN);
  assert.equal(r.rung, 'A:d4');
  assert.equal(r.instruments[0].status, 'NOT_MEASURED');
  assert.match(r.instruments[0].reason, /provider unavailable/);
});

test('a circular transportError on the tier B token call is NOT_MEASURED (provider unavailable)', async () => {
  const down = { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'the method eth_simulateV1 does not exist' } };
  const f = fakeNode({ probe: { 'A:d4': down, 'A:d2': down }, tokenErr: { B: { 1: circular() } } });
  const r = await runXray(f.transport, IN);
  assert.equal(r.rung, 'B');
  assert.equal(r.instruments[0].status, 'NOT_MEASURED');
  assert.match(r.instruments[0].reason, /provider unavailable/);
});

// ---- step.ts:34: an explicitly undefined optional is the omitted one (same inputHash, same actors); maxTaxBps stays required.
test('explicit undefined N, X, Y give the same state and actors as omitted ones; maxTaxBps undefined is still bad_input', async () => {
  const base = xrayStart(IN);
  for (const extra of [{ N: undefined }, { X: undefined }, { Y: undefined }, { N: undefined, X: undefined, Y: undefined }]) {
    const s = xrayStart({ ...IN, ...extra });
    assert.deepEqual(s, base, JSON.stringify(Object.keys(extra)));
  }
  const a = await runXray(fakeNode().transport, IN);
  const b = await runXray(fakeNode().transport, { ...IN, N: undefined, X: undefined, Y: undefined });
  assert.deepEqual(b, a);
  try { xrayStart({ ...IN, maxTaxBps: undefined } as any); assert.fail('no throw'); } catch (e) { assert.ok(e instanceof XrayError && e.code === 'bad_input', String(e)); }
});

// ---- step.ts:102: the transcript keeps a copy of each reply batch; a later change by the transport does not reach it.
test('changing a reply object after xrayStep does not change the recorded answer or the replay', () => {
  const s = xrayStart(IN); assert.ok('need' in s);
  const replies: any[] = [{ result: '0x2105' }, { result: hex(LATEST) }, { result: '0x5b8d80' }];
  const s2 = xrayStep(s.state, replies); assert.ok('need' in s2);
  replies[0].result = '0x1';
  assert.deepEqual(s2.state.answers[0], [{ result: '0x2105' }, { result: hex(LATEST) }, { result: '0x5b8d80' }]);
  const hs = s2.need.map((q) => ({ result: header(parseInt(q.params[0] as string, 16)) }));
  assert.ok('need' in xrayStep(s2.state, hs));
});

test('replacing an element of the reply array after xrayStep does not change the recorded batch', () => {
  const s = xrayStart(IN); assert.ok('need' in s);
  const replies: any[] = [{ result: '0x2105' }, { result: hex(LATEST) }, { result: '0x5b8d80' }];
  const s2 = xrayStep(s.state, replies); assert.ok('need' in s2);
  replies[0] = { result: '0x1' };
  assert.deepEqual(s2.state.answers[0][0], { result: '0x2105' });
});
