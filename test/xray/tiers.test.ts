// Port of deep-xray-tiers@1998a4d tiers/scan: parity of the pure pieces and decision 12 (rung by probe only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tierVerdict, classifyProbe, classifyToken, selectTier, LADDER } from '../../src/xray/tiers.js';
import { scan } from '../../src/xray/scan.js';
import { makeCtx, feeFor, laterClock } from '../../src/xray/ctx.js';

const rpcErr = (code: number, message = 'x', http?: number) => (http ? { httpStatus: http, body: { jsonrpc: '2.0', id: 1, error: { code, message } } } : { error: { code, message } });

test('tierVerdict: infimum by meet, unknown value reads WARN, inherited keys are not tiers', () => {
  assert.equal(tierVerdict({ A: 'MEASURED', C: 'CONDEMN' }).v, 'CONDEMN');
  assert.deepEqual(tierVerdict({ A: 'MEASURED', B: 'WARN' }).tiers, ['A', 'B']);
  assert.equal(tierVerdict({ A: 'toString' }).v, 'WARN');
  assert.equal(tierVerdict({ B: 'MEASURED' }).v, 'MEASURED');
  assert.equal(tierVerdict({ B: 'MEASURED' }).best, 'B');
  assert.equal(tierVerdict({}).v, 'WARN');
  assert.equal(tierVerdict(Object.create({ A: 'MEASURED' })).why, 'not measured: no tier ran');
});

test('classifyProbe: -32601 (also as HTTP 400 body) steps down; 429/5xx/transport is provider unavailable; data or code 3 is a revert', () => {
  assert.equal(classifyProbe('A', rpcErr(-32601)).cls, 'down');
  assert.equal(classifyProbe('A', rpcErr(-32601, 'the method eth_simulateV1 does not exist', 400)).cls, 'down');
  assert.equal(classifyProbe('A', { httpStatus: 429, body: { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'x' } } }).cls, 'unavailable');
  assert.equal(classifyProbe('B', { httpStatus: 503 }).cls, 'unavailable');
  assert.equal(classifyProbe('B', { transportError: 'reset' }).cls, 'unavailable');
  assert.equal(classifyProbe('B', rpcErr(-32005)).cls, 'unavailable');
  assert.equal(classifyProbe('C', { error: { code: 3, message: 'reverted', data: '0x' } }).cls, 'reverted');
  assert.equal(classifyProbe('A', { result: [{ calls: [{ status: '0x1' }] }] }).cls, 'ok');
  assert.equal(classifyProbe('A', { result: [{ calls: [{ status: '0x0' }] }] }).cls, 'reverted');
  assert.equal(classifyProbe('A', { result: '0x' }).cls, 'down');
  assert.equal(classifyProbe('B', { result: '0x' }).cls, 'ok');
});

test('classifyToken: an HTTP 400 JSON-RPC error body keeps its JSON-RPC code; HTTP 503 is not measured by status', () => {
  assert.deepEqual([classifyToken(rpcErr(-32000, 'Out Of Gas', 400)).cls, (classifyToken(rpcErr(-32000, 'Out Of Gas', 400)) as any).code], ['not-measured', -32000]);
  assert.equal((classifyToken({ httpStatus: 503 }) as any).why, 'provider unavailable (http 503)');
  assert.equal((classifyToken({ httpStatus: 503 }) as any).code, 503);
  assert.equal(classifyToken({ result: '0x00' }).cls, 'ok');
});

test('selectTier walks the ladder only on down; unavailable stops; none left is NOT_MEASURED', () => {
  assert.deepEqual(LADDER, ['A:d4', 'A:d2', 'B', 'C']);
  assert.deepEqual(selectTier({}), { rung: 'A:d4', status: 'ask' });
  assert.deepEqual(selectTier({ 'A:d4': rpcErr(-32601) }), { rung: 'A:d2', status: 'ask' });
  assert.equal(selectTier({ 'A:d4': { httpStatus: 503 } }).why, 'provider unavailable');
  const down = Object.fromEntries(LADDER.map((r) => [r, rpcErr(-32601)]));
  assert.equal(selectTier(down).why, 'no tier answered');
  assert.deepEqual(selectTier({ 'A:d4': rpcErr(-32601), 'A:d2': rpcErr(-32601), B: { result: '0x' } }), { rung: 'B', status: 'run' });
});

const H = (k: number) => ({ number: '0x' + (100 + k).toString(16), hash: '0x' + String(k + 1).repeat(64).slice(0, 64), timestamp: '0x' + (1000 + 2 * k).toString(16),
  baseFeePerGas: '0x64', mixHash: '0x' + 'ab'.repeat(32), miner: '0x' + '11'.repeat(20), gasLimit: '0x1c9c380' });
export const BLK = { number: 100, hash: H(0).hash, timestamp: 1000n, baseFee: 100n, headers: [0, 1, 2, 3, 4, 5].map(H), gasPrice: 50n };
const IDS = { X: '0x' + '22'.repeat(20), Y: '0x' + '33'.repeat(20) };
const TOKEN = '0x' + '44'.repeat(20);

test('ctx: fee covers the base fee of the pinned block, later clock from 5 real blocks, no random actors', () => {
  const f = feeFor(BLK);
  assert.ok(f.gasPrice >= f.maxFee && f.maxFee >= 2n * 100n);
  assert.equal(laterClock(BLK.headers, 100).laterTime, 1008n + 200n);
  assert.throws(() => makeCtx(8453, TOKEN, BLK, { buyIn: 10n ** 15n, N: 100, mode: 'd4' }, undefined as any), /X and Y come from the caller/);
});

test('decision 12: a token-call error after a good probe never moves the rung', () => {
  const mk = (o: any = {}) => makeCtx(8453, TOKEN, BLK, { buyIn: 10n ** 15n, N: 100, mode: 'd4', ...o }, IDS);
  const g = scan(mk);
  let s = g.next(undefined as any);
  assert.equal((s.value as any)[0].method, 'eth_simulateV1');
  assert.equal(Object.hasOwn((s.value as any)[0], 'id'), false);
  s = g.next([{ result: [{ calls: [{ status: '0x1' }] }] }]);
  assert.equal(s.done, false);
  s = g.next([rpcErr(-32601, 'method not found', 400)]);
  assert.equal(s.done, true);
  const r: any = s.value;
  assert.equal(r.rung, 'A:d4');
  assert.equal(r.status, 'NOT_MEASURED');
  assert.equal(r.probes.length, 1);
});
