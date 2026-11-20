// VERIF-5L F1 (2026-11-20): the token's own-balance rise in a move from the seller is a lower bound on the tax
// (ceil(10000 * selfDelta / sent)); it needs only the sent amount (BAL_X) and the self balance (SELF) read, never the
// pool delta. Red at e1c6390 (the floor sat inside the pool-read gate: WARN/NOT_MEASURED instead of CONDEMN).
import test from 'node:test';
import assert from 'node:assert/strict';
import { measure, instrumentVerdict, UM } from '../../src/xray/measure.js';

const ok = { ok: true, gas: 50_000n };
const base = (o: any = {}) => ({ tier: 'A', unmeasured: 0n, quoteBuy: ok, buy: ok, quoteSell: ok, sell: ok, transfer: ok, poolTransfer: ok,
  buyIn: 10n ** 18n, buyQuotedNet: 997_200n, buyDelivered: 997_200n, buyPoolSent: 1_000_000n, buyHops: 1n,
  sellIn: 1_000_000n, sellPoolReceived: 1_000_000n, sellTokenSelfDelta: 0n, sellOut: 10n ** 15n, sellQuotedNet: 10n ** 15n, sellHops: 1n,
  transferSent: 1000n, transferReceived: 1000n, poolTransferSent: 1000n, poolTransferReceived: 1000n,
  poolTransferTokenSelfDelta: 0n, poolTransferPairAnchorDelta: 0n, buySafetyBuffer: 0n, sellSafetyBuffer: 0n, ...o });

test('sale: self balance +50% of S with the pool delta unread (V4 first hop) condemns', () => {
  const r = base({ unmeasured: UM.POOL_SELL, sellTokenSelfDelta: 500_000n });
  const m = measure(r, { tier: 'C' });
  assert.equal(m.taxFloorBps, 5000n);
  assert.equal(instrumentVerdict(m, { maxTaxBps: 1000 }).status, 'CONDEMN');
});

test('transfer to the pair: self balance +50% with the pair read failed (POOL_SELL) condemns', () => {
  const r = base({ unmeasured: UM.POOL_SELL, poolTransferTokenSelfDelta: 500n });
  const m = measure(r, { tier: 'C' });
  assert.equal(m.taxFloorBps, 5000n);
  assert.equal(instrumentVerdict(m, { maxTaxBps: 1000 }).status, 'CONDEMN');
});

test('later sell: self balance +50% with a later pool unread condemns', () => {
  const r = base({ sellLater: ok, quoteLater: { ok: true }, sellLaterIn: 1000n, sellLaterOut: 10n ** 12n, sellLaterTokenSelfDelta: 500n,
    sellLaterQuotedNet: 10n ** 12n, sellLaterSafetyBuffer: 0n });
  const m = measure(r, { tier: 'A' });
  assert.equal(m.taxFloorBps, 5000n);
  assert.equal(instrumentVerdict(m, { maxTaxBps: 1000 }).status, 'CONDEMN');
});

test('control: same self rise with the pool delta read condemns (green today)', () => {
  const r = base({ sellTokenSelfDelta: 500_000n });
  const m = measure(r, { tier: 'C' });
  assert.equal(instrumentVerdict(m, { maxTaxBps: 1000 }).status, 'CONDEMN');
});

// ±1 wei around maxTaxBps with the pool delta unread: ceil(10000 * 99_900 / 1e6) = 999 < 1000 is not condemned by the
// floor; 99_901 wei rounds up to 1000 >= 1000 and condemns.
test('sale, pool delta unread: self rise 999 bps exact is not a CONDEMN, +1 wei (rounded up to 1000) is', () => {
  const lo = measure(base({ unmeasured: UM.POOL_SELL, sellTokenSelfDelta: 99_900n }), { tier: 'C' });
  assert.equal(lo.taxFloorBps, 999n);
  assert.notEqual(instrumentVerdict(lo, { maxTaxBps: 1000 }).status, 'CONDEMN');
  const hi = measure(base({ unmeasured: UM.POOL_SELL, sellTokenSelfDelta: 99_901n }), { tier: 'C' });
  assert.equal(hi.taxFloorBps, 1000n);
  assert.equal(instrumentVerdict(hi, { maxTaxBps: 1000 }).status, 'CONDEMN');
});

// The floor still needs the sent amount: with the seller's token balance unread (BAL_X) S is not a measurement, so
// no floor is taken from it (absent is not a value), at the sale and at the transfer to the pair.
test('seller balance unread (BAL_X): no self floor from the sale or the transfer to the pair', () => {
  const m = measure(base({ unmeasured: UM.BAL_X | UM.POOL_SELL, sellTokenSelfDelta: 500_000n, poolTransferTokenSelfDelta: 500n }), { tier: 'C' });
  assert.equal(m.taxFloorBps, null);
  assert.notEqual(instrumentVerdict(m, { maxTaxBps: 1000 }).status, 'CONDEMN');
});
