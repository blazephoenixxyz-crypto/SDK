// Happy path of the fake reaches MEASURED with every tax measured (W2-core-6, step 0).
// Before: the fake router credited the buyer without debiting the pool, so the pool's token delta was 0 and
// measure() left buyTaxBps null ("buy pool delta not measured" -> NOT_MEASURED "a tax was not measured").
// measure.ts is right to refuse P = 0 (tokens that did not leave the pool are not a measured buy); the fake was wrong.
// Gamut: tax 0 / 300 / 499 bps (MEASURED, exact) and 500 (CONDEMN at the >= boundary), on rungs A:d4, B and C.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runXray } from '../../src/xray/index.js';
import { fakeNode, TOKEN } from './fake.js';

const IN = { chainId: 8453, token: TOKEN, amountIn: 10n ** 15n, maxTaxBps: 500 };
const down = { error: { code: -32601, message: 'the method eth_simulateV1 does not exist/is not available' } };
const refused = { error: { code: -32602, message: 'state override refused' } };
const RUNGS: Record<string, any> = { 'A:d4': {}, B: { 'A:d4': down, 'A:d2': down }, C: { 'A:d4': down, 'A:d2': down, B: refused } };
const TAXES = ['buyTaxBps', 'sellTaxBps', 'sellTaxSwapBps', 'transferTaxBps'] as const;

// V5 (F1, F3, owner decisions 1-2, 2026-11-20): tier B reads neither the quote safety buffer nor the token contract's
// balance around the transfer to the pair, so there sellTaxBps is not measured (null, TIER_LIMITS.B) and a tax is
// MEASURED only when it plus the protocol maximum buffer (10 bps) is below maxTaxBps: 499 + 10 >= 500 is NOT_MEASURED.
for (const [rung, probe] of Object.entries(RUNGS)) {
  for (const taxBps of [0n, 300n, 499n]) {
    const nm = rung === 'B' && taxBps + 10n >= BigInt(IN.maxTaxBps);
    test(`[happy] ${rung} tax ${taxBps} bps: ${nm ? 'NOT_MEASURED (B: tax + 10 bps buffer >= maxTaxBps)' : 'MEASURED'}, every tax measured exactly`, async () => {
      const r = await runXray(fakeNode({ probe, taxBps }).transport, IN);
      assert.equal(r.rung, rung);
      const sim = r.instruments.find((i) => i.name === 'sim')!;
      for (const k of TAXES) assert.equal((sim.values as any)[k], rung === 'B' && k === 'sellTaxBps' ? null : taxBps, k);
      if (nm) {
        assert.equal(sim.status, 'NOT_MEASURED'); assert.equal(sim.reason, `buyTaxBps ${taxBps} + quote buffer 10 >= ${IN.maxTaxBps}`);
        assert.equal(r.verdict, 'WARN');
        return;
      }
      assert.equal(sim.status, 'MEASURED', sim.reason);
      assert.equal(r.verdict, 'MEASURED');
    });
  }
  test(`[happy] ${rung} tax 500 bps = maxTaxBps: CONDEMN (>= boundary)`, async () => {
    const r = await runXray(fakeNode({ probe, taxBps: 500n }).transport, IN);
    assert.equal(r.rung, rung);
    assert.equal(r.verdict, 'CONDEMN');
    assert.match(r.instruments.find((i) => i.name === 'sim')!.reason, /TaxBps 500 >= 500/);
  });
}
