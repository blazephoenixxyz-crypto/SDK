// buildReport: verdict is the lattice infimum; NOT_MEASURED instruments are listed; the text says what was measured.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeFunctionResult } from 'viem';
import { PROBE_ABI } from '../../src/xray/probe.js';
import { buildReport } from '../../src/xray/report.js';

const g = JSON.parse(fs.readFileSync(new URL('./golden/v2-halfsell-direct-56632746.json', import.meta.url), 'utf8'));
export const RESULT = () => decodeFunctionResult({ abi: PROBE_ABI as any, functionName: 'probe', data: g.returnData }) as any;
const CTX = { X: '0x' + '22'.repeat(20), N: 100, fee: { gasPrice: 7n } };
export const rep = (result: any, amountIn = 10n ** 15n, tier = 'A') => buildReport({ chainId: 8453, block: { number: 56632746, hash: '0x' + 'aa'.repeat(32), timestamp: 1n },
  target: '0x' + '44'.repeat(20), amountIn, maxTaxBps: 100, ctx: CTX, scan: result ? { tier, rung: tier === 'A' ? 'A:d4' : tier, status: 'RAN', result } : { tier: null, rung: null, status: 'NOT_MEASURED', why: 'provider unavailable' } });

test('no scan: WARN, every instrument NOT_MEASURED, reason carried', () => {
  const r = rep(null);
  assert.equal(r.verdict, 'WARN');
  assert.ok(r.notMeasured.includes('sim') && r.notMeasured.includes('quoter'));
  assert.match(r.text, /provider unavailable/);
});

test('a sell revert condemns through the lattice; sender is Multicall3 on tier C', () => {
  const res = RESULT(); res.sell = { ...res.sell, ok: false, ran: true, gas: 5n }; res.direct = { ...res.direct, ok: false, ran: true, gas: 5n };
  const r = rep(res, 10n ** 15n, 'C');
  assert.equal(r.verdict, 'CONDEMN');
  assert.equal(r.instruments[0].conditions.sender, '0xcA11bde05977b3631167028862bE2a173976CA11');
  assert.equal(r.instruments[0].conditions.blocksLater, 0);
});

// Decision (i), V-X1-2 amtlimit: the same token is MEASURED at 1e15 and CONDEMN at 1e16; the report carries the size.
test('(i) amtlimit: the report carries amountIn per leg and the text says "measured at <amount>"', () => {
  const small = rep(RESULT(), 10n ** 15n);
  const big = RESULT(); big.buyIn = 10n ** 16n; big.sell = { ...big.sell, ok: false, ran: true, gas: 5n }; big.direct = { ...big.direct, ok: false, ran: true, gas: 5n };
  const large = rep(big, 10n ** 16n);
  assert.equal(large.verdict, 'CONDEMN');
  for (const [r, a] of [[small, 10n ** 15n], [large, 10n ** 16n]] as const) {
    assert.equal(r.amountIn, a);
    assert.ok(r.text.includes(`measured at ${a}`), r.text);
    const legs = Object.fromEntries((r as any).legs.map((l: any) => [l.leg, l.amountIn]));
    assert.deepEqual(Object.keys(legs), ['buy', 'sell', 'transfer']);
    assert.equal(legs.buy, r === small ? RESULT().buyIn : 10n ** 16n);
  }
});

// Decision (ii), V-X1-2 walletrevert: R = {sim, quoter, transfer}; transferOk null is NOT_MEASURED and never "transfers measured".
test('(ii) walletrevert: transfer not run => transfer NOT_MEASURED, verdict <= WARN, text never says transfers measured', () => {
  const res = RESULT(); res.transfer = { ok: false, gas: 0n, revertData: '0x' };
  const r = rep(res);
  const t = r.instruments.find((i) => i.name === 'transfer');
  assert.equal(t?.status, 'NOT_MEASURED');
  assert.ok(r.notMeasured.includes('transfer'));
  assert.notEqual(r.verdict, 'MEASURED');
  assert.doesNotMatch(r.text, /transfers? measured/i);
});
test('(ii) transfer in R: a missing transfer instrument caps the verdict at WARN', async () => {
  const { REQUIRED, combine } = await import('../../src/xray/lattice.js');
  assert.deepEqual([...REQUIRED], ['sim', 'quoter', 'transfer']);
  assert.equal(combine({ sim: 'MEASURED', quoter: 'MEASURED' }), 'WARN');
  assert.equal(combine({ sim: 'MEASURED', quoter: 'MEASURED', transfer: 'MEASURED' }), 'MEASURED');
});
test('(ii) transfer measured: instrument MEASURED with the transferred amount', () => {
  const res = RESULT(); res.transfer = { ok: true, ran: true, gas: 5n, revertData: '0x' }; res.transferSent = 1000n; res.transferReceived = 1000n;
  const r = rep(res);
  const t = r.instruments.find((i) => i.name === 'transfer');
  assert.equal(t?.status, 'MEASURED');
  assert.equal(t?.conditions.amountIn, 1000n);
  const rv = RESULT(); rv.transfer = { ok: false, ran: true, gas: 5n, revertData: '0x' }; rv.transferSent = 1000n;
  assert.equal(rep(rv).instruments.find((i) => i.name === 'transfer')?.status, 'WARN');
  const tx = RESULT(); tx.transfer = { ok: true, ran: true, gas: 5n, revertData: '0x' }; tx.transferSent = 1000n; tx.transferReceived = 500n;
  assert.equal(rep(tx).instruments.find((i) => i.name === 'transfer')?.status, 'CONDEMN');
});
