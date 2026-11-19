// Sans-IO stepping: Step = {need, state} | {done}; state carries inputHash and the pinned block;
// a tampered or foreign state fails closed with state_mismatch. Replay keeps the state serialisable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, inputHash, startProgram, stepProgram, runProgram, type Program, type Rpc } from '../../src/xray/step.js';

type In = { token: string; amount: bigint };
const toy: Program<In, { n: number; out: unknown }> = function* (input, io) {
  const [cid] = yield [{ method: 'eth_chainId', params: [] }];
  const [blk] = (yield [{ method: 'eth_getBlockByNumber', params: ['latest', false] }]) as any[];
  io.pin({ number: BigInt(blk.number), hash: blk.hash });
  const [out] = yield [{ method: 'eth_call', params: [{ to: input.token, data: '0x' }, { blockHash: blk.hash }] }];
  return { n: Number(cid), out };
};
const input: In = { token: '0x' + '7a'.repeat(20), amount: 10n ** 15n };
const node = (r: Rpc): unknown => r.method === 'eth_chainId' ? '0x2105'
  : r.method === 'eth_getBlockByNumber' ? { number: '0x10', hash: '0x' + 'aa'.repeat(32) } : '0x01';
const J = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test('canonical input is key-order independent and keeps bigints exact', () => {
  assert.equal(canonical({ b: 1n, a: [2n, 'x'] }), canonical({ a: [2n, 'x'], b: 1n }));
  assert.notEqual(canonical({ a: 1n }), canonical({ a: '1' }));
  assert.notEqual(inputHash(input), inputHash({ ...input, amount: input.amount + 1n }));
});
test('start -> step -> step -> done; Rpc has no id; state survives JSON', () => {
  let s = startProgram(toy, input);
  const seen: string[] = [];
  for (let i = 0; i < 5 && 'need' in s; i++) {
    for (const r of s.need) { assert.deepEqual(Object.keys(r).sort(), ['method', 'params']); seen.push(r.method); }
    s = stepProgram(toy, J(s.state), s.need.map(node));
  }
  assert.ok('done' in s);
  assert.deepEqual(seen, ['eth_chainId', 'eth_getBlockByNumber', 'eth_call']);
  assert.deepEqual((s as any).done, { n: 8453, out: '0x01' });
});
test('runProgram is the only loop with I/O and gives the same report', async () => {
  const rep = await runProgram(toy, async (rs) => rs.map(node), input);
  assert.deepEqual(rep, { n: 8453, out: '0x01' });
});
test('state_mismatch: tampered input, tampered hash, foreign version, changed pinned block', () => {
  const s1 = startProgram(toy, input) as any;
  const s2 = stepProgram(toy, s1.state, s1.need.map(node)) as any;
  const s3 = stepProgram(toy, s2.state, s2.need.map(node)) as any;
  assert.equal(s3.state.block.hash, '0x' + 'aa'.repeat(32));
  const bad = (st: any) => assert.throws(() => stepProgram(toy, st, ['0x01']), /state_mismatch/);
  bad({ ...s3.state, input: { ...s3.state.input, token: '0x' + '66'.repeat(20) } });
  bad({ ...s3.state, inputHash: '0x' + '00'.repeat(32) });
  bad({ ...s3.state, v: 2 });
  const a = J(s3.state); a.answers[1][0].hash = '0x' + 'bb'.repeat(32); bad(a);
  const b = J(s3.state); b.block.number = '17'; bad(b);
});
test('responses must match the pending need one to one', () => {
  const s1 = startProgram(toy, input) as any;
  assert.throws(() => stepProgram(toy, s1.state, []), /bad_responses/);
  assert.throws(() => stepProgram(toy, s1.state, ['0x2105', '0x1']), /bad_responses/);
});
test('a program that pins two different blocks fails closed', () => {
  const two: Program<In, number> = function* (_i, io) {
    yield [{ method: 'eth_blockNumber', params: [] }];
    io.pin({ number: 1n, hash: '0x' + '01'.repeat(32) });
    io.pin({ number: 2n, hash: '0x' + '02'.repeat(32) });
    return 0;
  };
  const s = startProgram(two, input) as any;
  assert.throws(() => stepProgram(two, s.state, ['0x1']), /state_mismatch/);
});
test('canonical refuses a __proto__ key (two inputs must never share a hash)', () => {
  assert.throws(() => canonical(JSON.parse('{"__proto__":1,"a":1}')), /bad_input/);
  assert.throws(() => canonical({ $bigint: '1' }), /bad_input/);
});
