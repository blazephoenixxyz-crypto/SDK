// Lesson (d): the tier comes only from the node's real answer, never from a chainId table (R-rpc.md §6 rule,
// IC3/IC8). -32601 / -32602 to eth_simulateV1 step down exactly one tier (A -> B), and B -> C; the same node
// behaviour gives the same rung on every chain, with or without an entry of its own. Golden vectors: the
// eth_simulateV1 answers measured on 8 networks x 2 providers (sub/R-rpc.tsv, C6 rows, 12/11/2026).
// Each test names the mutant that turns it red (xray-ship/mut.mjs, R- block).
import test from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../../src/xray/scan.js';
import { makeCtx } from '../../src/xray/ctx.js';
import { MC3 } from '../../src/xray/abi.js';
import { fakeNode, drive, fakeBlk, TOKEN, type FakeOpts } from './fake.js';

const IDS = { X: '0x' + '11'.repeat(20), Y: '0x' + '22'.repeat(20) };
const BLK = fakeBlk();
const E = (code: number, message = 'x') => ({ jsonrpc: '2.0', id: 1, error: { code, message } });
const H400 = (code: number, message = 'x') => ({ httpStatus: 400, body: JSON.stringify(E(code, message)) });
/** Context of chain `id`. A chain without a deployment entry reuses the 8453 addresses: only chainId differs. */
const mkFor = (id: number) => (o: any = {}) => {
  const known = [1, 8453, 42161].includes(id);
  const c = makeCtx(known ? id : 8453, TOKEN, BLK, { buyIn: 10n ** 15n, N: 100, mode: 'd4', ...o }, IDS);
  return known ? c : { ...c, chainId: id };
};
async function run(o: FakeOpts, id: number) {
  const node = fakeNode({ ...o, chainId: [1, 8453, 42161].includes(id) ? id : 8453 });
  const r: any = await drive(scan(mkFor(id)), node.transport);
  return { r, node, probes: r.probes.map((p: any) => p.rung + ':' + p.cls) };
}
const toC = (reqs: any[]) => reqs.filter((q) => q.method === 'eth_call' && String(q.params[0].to).toLowerCase() === MC3.toLowerCase());

for (const code of [-32601, -32602]) for (const [form, ans] of [['JSON-RPC', E], ['HTTP 400 body', H400]] as const) {
  test(`[R-d1] eth_simulateV1 ${code} (${form}) steps down exactly one tier: A -> B, C never asked [R-d1 R-d2 R-d3]`, async () => {
    const no = ans(code, 'the method eth_simulateV1 does not exist/is not available');
    const { r, node, probes } = await run({ probe: { 'A:d4': no, 'A:d2': no } }, 8453);
    assert.deepEqual(probes, ['A:d4:down', 'A:d2:down', 'B:ok']);
    assert.equal(r.tier, 'B'); assert.equal(r.rung, 'B'); assert.equal(r.status, 'RAN');
    assert.equal(toC(node.reqs).length, 0);
  });
  test(`[R-d2] B probe ${code} (${form}) after A is absent steps down exactly one tier: B -> C [R-d1 R-d2 R-d3]`, async () => {
    const no = E(-32601, 'the method eth_simulateV1 does not exist');
    const { r, probes } = await run({ probe: { 'A:d4': no, 'A:d2': no, B: ans(code, 'invalid argument 2: state override') } }, 8453);
    assert.deepEqual(probes, ['A:d4:down', 'A:d2:down', 'B:down', 'C:ok']);
    assert.equal(r.tier, 'C'); assert.equal(r.status, 'RAN');
  });
}

test('[R-d3] C probe -32601 after A and B are absent: NOT_MEASURED "no tier answered", never a value [R-d3]', async () => {
  const no = E(-32601, 'no');
  const { r, probes } = await run({ probe: { 'A:d4': no, 'A:d2': no, B: no, C: no } }, 8453);
  assert.deepEqual(probes, ['A:d4:down', 'A:d2:down', 'B:down', 'C:down']);
  assert.equal(r.tier, null); assert.equal(r.status, 'NOT_MEASURED'); assert.equal(r.why, 'no tier answered');
});

// Same node behaviour, four chains: 1, 8453, 42161 (deployment entries, 42161 Nitro) and 10 / 31337 (no entry).
const SCEN: [string, FakeOpts, string, string[]][] = [
  ['simulateV1 answers', {}, 'A:d4', ['A:d4:ok']],
  ['simulateV1 -32601', { probe: { 'A:d4': E(-32601), 'A:d2': E(-32601) } }, 'B', ['A:d4:down', 'A:d2:down', 'B:ok']],
  ['simulateV1 -32602', { probe: { 'A:d4': E(-32602), 'A:d2': E(-32602) } }, 'B', ['A:d4:down', 'A:d2:down', 'B:ok']],
  ['simulateV1 -32601, B -32602', { probe: { 'A:d4': E(-32601), 'A:d2': E(-32601), B: E(-32602) } }, 'C', ['A:d4:down', 'A:d2:down', 'B:down', 'C:ok']],
];
for (const [name, o, rung, probes] of SCEN) {
  test(`[R-d4] ${name}: rung ${rung} on chains 1, 8453, 42161, 10 and 31337 alike (no chainId table) [R-d4a R-d4b]`, async () => {
    for (const id of [1, 8453, 42161, 10, 31337]) {
      const x = await run(o, id);
      assert.equal(x.r.rung, rung, 'chain ' + id); assert.deepEqual(x.probes, probes, 'chain ' + id); assert.equal(x.r.status, 'RAN', 'chain ' + id);
      assert.equal(x.node.reqs[0].method, 'eth_simulateV1', 'chain ' + id);
    }
  });
}

// Golden: R-rpc.tsv C6-1blk-val-realbo (the A:d4 shape) and C6-1blk-val (the A:d2 shape), per network x provider.
const OK = null;
const GOLD: [string, number, string, unknown, unknown, string][] = [
  ['ethereum', 1, 'drpc', OK, OK, 'A:d4'], ['ethereum', 1, 'public', OK, OK, 'A:d4'],
  ['base', 8453, 'drpc', OK, OK, 'A:d4'], ['base', 8453, 'public', OK, OK, 'A:d4'],
  ['optimism', 10, 'drpc', OK, OK, 'A:d4'], ['optimism', 10, 'public', OK, OK, 'A:d4'],
  ['unichain', 130, 'drpc', OK, OK, 'A:d4'], ['unichain', 130, 'public', OK, OK, 'A:d4'],
  ['arbitrum', 42161, 'drpc', OK, OK, 'A:d4'], ['arbitrum', 42161, 'public', OK, OK, 'A:d4'],
  ['robinhood', 4663, 'drpc', OK, OK, 'A:d4'], ['robinhood', 4663, 'public', OK, OK, 'A:d4'],
  ['bsc', 56, 'drpc', E(-38021, 'block timestamps must be in order: 1794516585 <= 1794516585'), OK, 'A:d2'], ['bsc', 56, 'public', OK, OK, 'A:d4'],
  ['avalanche', 43114, 'drpc', E(-32601, 'the method eth_simulateV1 does not exist/is not available'), E(-32601, 'the method eth_simulateV1 does not exist/is not available'), 'B'],
  ['avalanche', 43114, 'public', E(-32601, 'the method eth_simulateV1 does not exist'), E(-32601, 'the method eth_simulateV1 does not exist'), 'B'],
];
test('[R-d5] golden R-rpc.tsv C6: 8 networks x 2 providers, the rung follows the measured answer only [R-d1 R-d3 R-d4b]', async () => {
  assert.equal(new Set(GOLD.map((g) => g[1])).size, 8);
  for (const [net, id, prov, d4, d2, want] of GOLD) {
    const probe: Record<string, unknown> = {};
    if (d4) probe['A:d4'] = d4;
    if (d2) probe['A:d2'] = d2;
    const { r } = await run({ probe }, id);
    assert.equal(r.rung, want, `${net} ${id} ${prov}`); assert.equal(r.status, 'RAN', `${net} ${id} ${prov}`);
  }
});
