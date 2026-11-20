// Red-first for the X1-tiers-4 order (c): an HTTP error whose body is a JSON-RPC error (decision 12).
// Each test names the mutant that turns it red (sub/W2-core.tsv, W2-core-3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRpcReply } from '../../src/xray/rpc.js';

// (c) decision 12: an HTTP 4xx whose body is a valid JSON-RPC error is that error; -32601 (method does not
// exist) means the tier is unavailable and the ladder steps down. No JSON-RPC body = provider unavailable.
const E32601 = { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'the method eth_simulateV1 does not exist/is not available' } };
test('(c) HTTP 400 + JSON-RPC -32601 body (dRPC): tier unavailable, steps down [M-c]', () => {
  for (const body of [E32601, JSON.stringify(E32601)]) {
    const c = classifyRpcReply({ httpStatus: 400, body });
    assert.equal(c.cls, 'error'); assert.equal((c as any).code, -32601); assert.equal((c as any).tierMissing, true);
  }
});
test('(c) HTTP 400 + other JSON-RPC error is that error, not a missing tier', () => {
  const c = classifyRpcReply({ httpStatus: 400, body: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid params' } } });
  assert.equal(c.cls, 'error'); assert.equal((c as any).tierMissing, false);
});
test('(c) HTTP error without a JSON-RPC body: provider unavailable', () => {
  for (const body of [undefined, 'Bad Request', '{"error":"x"}', { error: { code: -32601 } }, { jsonrpc: '2.0', error: { code: '-32601', message: 'x' } }, { id: 1, error: { code: -32601, message: 'x' } }, { jsonrpc: '2.0', id: 1, result: '0x01' }]) {
    assert.equal(classifyRpcReply({ httpStatus: 400, body }).cls, 'unavailable', JSON.stringify(body));
  }
});
test('(c) rate limit / server error / transport stay provider unavailable, even with a JSON-RPC body (MT2b)', () => {
  for (const s of [429, 500, 503]) assert.equal(classifyRpcReply({ httpStatus: s, body: E32601 }).cls, 'unavailable', String(s));
  assert.equal(classifyRpcReply({ transportError: 'ECONNRESET' }).cls, 'unavailable');
  for (const code of [429, -32005]) assert.equal(classifyRpcReply({ error: { code, message: 'limit' } }).cls, 'unavailable');
  assert.equal(classifyRpcReply({}).cls, 'unavailable');
  assert.equal(classifyRpcReply(null).cls, 'unavailable');
});
test('(c) plain answers: result and a 200 JSON-RPC -32601', () => {
  assert.deepEqual(classifyRpcReply({ result: '0x01' }), { cls: 'result', result: '0x01' });
  assert.deepEqual(classifyRpcReply({ httpStatus: 200, body: { jsonrpc: '2.0', id: 1, result: '0x' } }), { cls: 'result', result: '0x' });
  assert.equal((classifyRpcReply(E32601) as any).tierMissing, true);
});
