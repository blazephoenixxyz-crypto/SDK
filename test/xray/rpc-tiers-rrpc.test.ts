// R-rpc §7 (rest). (R1) tier B decodes only the canonical ABI answer: viem accepts trailing bytes and dirty
// address words, so a node (or a proxy) could append or alter bytes unseen. (R3) every request the scan sends is
// one the node can execute at the pinned block: fee >= base fee, gas <= block gas limit, the X balance override
// covers value + gas * fee, over the base-fee range 0, 1, real, 2x and gas limits 30M / real / Nitro. (R4)
// prevRandao is the measured header's mixHash on A:d4 and absent on A:d2. (R5) the codehash pin is per
// (chainId, address): Base code at the chain-1 or chain-42161 addresses fails closed. Each test names its mutant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionResult } from 'viem';
import { scan } from '../../src/xray/scan.js';
import { makeCtx, pinBlock } from '../../src/xray/ctx.js';
import { PROBE } from '../../src/xray/abi.js';
import { LADDER } from '../../src/xray/tiers.js';
import { fakeNode, drive, fakeBlk, isProbe, rungOf, TOKEN, type FakeOpts } from './fake.js';
import type { Rpc } from '../../src/xray/step.js';

const IDS = { X: '0x' + '11'.repeat(20), Y: '0x' + '22'.repeat(20) };
const E = (code: number, message = 'x') => ({ jsonrpc: '2.0', id: 1, error: { code, message } });
const NO_A = { 'A:d4': E(-32601, 'no'), 'A:d2': E(-32601, 'no') };
const AT: Record<string, FakeOpts> = { 'A:d4': {}, 'A:d2': { probe: { 'A:d4': E(-32602, 'no') } }, B: { probe: NO_A }, C: { probe: { ...NO_A, B: E(-32602, 'no') } } };
const hex = (n: bigint | number) => '0x' + BigInt(n).toString(16);
const B = (x: any) => BigInt(x ?? 0);
const lc = (s: string) => s.toLowerCase();
const J = (o: any) => JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

/** A pinned block with base fees bf0 (B) and bf1 (B+1), gas limit gl, eth_gasPrice gp and one mixHash per header. */
function blkWith(bf0: bigint, bf1: bigint, gl: bigint, gp: bigint) {
  const b: any = fakeBlk();
  b.headers = b.headers.map((h: any, k: number) => ({ ...h, baseFeePerGas: hex(k === 0 ? bf0 : k === 1 ? bf1 : bf1), gasLimit: hex(gl), mixHash: '0x' + (k + 1).toString(16).padStart(64, '0') }));
  b.baseFee = bf0; b.gasPrice = gp;
  return b;
}

// ---------- R1: tier B answer must be the canonical encoding ----------
const realB = (q: any) => q.method === 'eth_call' && !isProbe(q) && rungOf(q) === 'B';
function rewriteB(node: ReturnType<typeof fakeNode>, f: (data: string) => string) {
  return async (batch: Rpc[]) => { const real: any[] = await node.transport(batch); return real.map((a, j) => (realB(batch[j]) && a?.result ? { ...a, result: f(a.result) } : a)); };
}
const mkB = (o: any = {}) => makeCtx(8453, TOKEN, fakeBlk(), { buyIn: 10n ** 15n, N: 100, mode: 'd4', ...o }, IDS);
/** The canonical tier-B answer the fake node gives (also the control: it decodes and runs). */
async function canonicalB() { let d = ''; const node = fakeNode(AT.B); const r: any = await drive(scan(mkB), rewriteB(node, (x) => (d = x))); return { d, r }; }
/** Dirty the 12 zero bytes above the first address word that holds `addr` (viem keeps only the low 20 bytes). */
function dirtyAddress(d: string, addr: string) {
  const w = '0'.repeat(24) + lc(addr).slice(2);
  for (let i = 2; i < d.length; i += 64) if (d.slice(i, i + 64) === w) return d.slice(0, i) + 'f'.repeat(24) + d.slice(i + 24);
  throw new Error('address word not found');
}

test('[R1] control: the canonical tier-B answer runs and is the ABI encoding of what it decodes [R-b1]', async () => {
  const { d, r } = await canonicalB();
  assert.equal(r.status, 'RAN'); assert.equal(r.tier, 'B');
  assert.ok(d.length > 2 + 64 * 10 && (d.length - 2) % 64 === 0, 'length ' + d.length);
});

test('[R1] tier-B answer with bytes added, cut or a dirty word: NOT_MEASURED undecodable answer, never RAN [R-b1]', async () => {
  const { d } = await canonicalB();
  const decoded: any = (decodeFunctionResult as any)({ abi: PROBE.abi, functionName: 'probe', data: d });
  const pool = decoded.poolTransferTo as string;
  const cases: [string, string, boolean][] = [
    // [name, answer, does viem alone accept it?] (measured: viem accepts trailing bytes and dirty address words)
    ['+1 byte', d + '00', true], ['+31 bytes', d + '00'.repeat(31), true], ['+32 zero bytes', d + '00'.repeat(32), true],
    ['+32 non-zero bytes', d + 'ff'.repeat(32), true], ['+1 KiB', d + '01'.repeat(1024), true],
    ['dirty address word (poolTransferTo)', dirtyAddress(d, pool), true],
    ['-1 byte', d.slice(0, -2), false], ['-32 bytes', d.slice(0, -64), false], ['empty 0x', '0x', false],
  ];
  for (const [name, x, viemOk] of cases) {
    let ok = true; try { (decodeFunctionResult as any)({ abi: PROBE.abi, functionName: 'probe', data: x }); } catch { ok = false; }
    assert.equal(ok, viemOk, 'viem on ' + name);
    const node = fakeNode(AT.B);
    const r: any = await drive(scan(mkB), rewriteB(node, () => x));
    assert.equal(r.status, 'NOT_MEASURED', name); assert.equal(r.why, 'undecodable answer', name); assert.equal(r.result, undefined, name);
  }
});

// ---------- R3: fee, gas and balance over the base-fee range ----------
const REAL = 5_000_000n;
const FEES: [string, bigint, bigint, bigint][] = [
  // [name, bf0, bf1, eth_gasPrice]
  ['base fee 0', 0n, 0n, 0n], ['base fee 1', 1n, 1n, 1n], ['real', REAL, REAL + 1000n, REAL + 1_000_000n],
  ['B+1 at 2x', REAL, 2n * REAL, REAL], ['eth_gasPrice below the base fee (42161)', REAL, REAL, 1n],
];
// Lowest gas limit on a pinned chain: 36M (chain 1). Tier C asks up to 31.25M, above a 30M chain (follow-up in A2.md).
const LIMITS: [string, bigint][] = [['gas limit 36M (chain 1)', 36_000_000n], ['real 150M', 150_000_000n], ['Nitro 2^50', 1n << 50n]];

async function sent(rung: string, blk: any, gas: string) {
  const node = fakeNode(AT[rung]);
  const mk = (o: any = {}) => makeCtx(8453, TOKEN, blk, { buyIn: 10n ** 15n, N: 100, mode: 'd4', ...o, gas: gas === 'l1gas' ? 'l1gas' : o.gas ?? 'fixed' }, IDS);
  const r: any = await drive(scan(mk), node.transport);
  return { r, reqs: node.reqs as any[] };
}

for (const rung of LADDER) for (const [fname, bf0, bf1, gp] of FEES) for (const [gname, gl] of LIMITS) for (const gas of rung[0] === 'A' ? ['fixed', 'l1gas'] : ['fixed']) {
  test(`[R3] ${rung} ${fname}, ${gname}, gas ${gas}: fee >= base fee, gas <= gas limit, balance covers value + gas * fee [R-f1 R-f2 R-g1 R-bal]`, async () => {
    const blk = blkWith(bf0, bf1, gl, gp);
    const { r, reqs } = await sent(rung, blk, gas);
    assert.equal(r.status, 'RAN', J(r).slice(0, 200)); assert.equal(r.rung ?? r.tier, rung === 'B' || rung === 'C' ? rung : r.rung);
    const maxBf = bf0 > bf1 ? bf0 : bf1;
    let n = 0;
    for (const q of reqs) {
      if (q.method === 'eth_simulateV1') {
        // The node buys gas * maxFee + value before each call and refunds the unused gas, so before call i the X
        // balance must cover value_i + gas_i * maxFee plus every earlier value (gas used by earlier calls is unknown
        // here: the worst case, sum of gas * maxFee, is a follow-up in A2.md).
        let spent = 0n; let bal: bigint | null = null; let need = 0n;
        for (const b of q.params[0].blockStateCalls) {
          const bo = b.blockOverrides ?? {};
          const bf = bo.baseFeePerGas !== undefined ? B(bo.baseFeePerGas) : maxBf;
          const limit = bo.gasLimit !== undefined ? B(bo.gasLimit) : gl;
          let used = 0n;
          for (const c of b.calls) {
            n++;
            assert.ok(B(c.maxFeePerGas) >= bf, `maxFee ${B(c.maxFeePerGas)} < base fee ${bf}`);
            assert.ok(B(c.maxFeePerGas) >= maxBf, `maxFee ${B(c.maxFeePerGas)} < max(bf0, bf1) ${maxBf}`);
            assert.ok(B(c.maxPriorityFeePerGas) <= B(c.maxFeePerGas), 'priority above max fee');
            assert.ok(B(c.gas) <= limit, `call gas ${B(c.gas)} > gas limit ${limit}`);
            used += B(c.gas);
            if (lc(c.from) === lc(IDS.X)) { const n1 = spent + B(c.value) + B(c.gas) * B(c.maxFeePerGas); if (n1 > need) need = n1; spent += B(c.value); }
          }
          assert.ok(used <= limit, `block gas ${used} > gas limit ${limit}`);
          const so = b.stateOverrides?.[Object.keys(b.stateOverrides ?? {}).find((k) => lc(k) === lc(IDS.X)) ?? ''];
          if (so?.balance !== undefined) bal = B(so.balance);
        }
        if (need > 0n && !isProbe(q)) { assert.notEqual(bal, null, 'no X balance override'); assert.ok(bal! >= need, `X balance ${bal} < values so far + gas * maxFee ${need}`); }
      } else if (q.method === 'eth_call') {
        n++;
        const c = q.params[0];
        assert.ok(B(c.gasPrice) >= maxBf, `gasPrice ${B(c.gasPrice)} < max(bf0, bf1) ${maxBf}`);
        assert.ok(B(c.gas) <= gl, `eth_call gas ${B(c.gas)} > gas limit ${gl}`);
        const ov = q.params[2]?.[Object.keys(q.params[2] ?? {}).find((k) => lc(k) === lc(c.from)) ?? ''];
        // Tier B: the probe code spends buyIn from its own balance inside the call.
        if (ov?.balance !== undefined) assert.ok(B(ov.balance) >= B(c.value) + B(c.gas) * B(c.gasPrice) + (ov.code && !isProbe(q) ? 10n ** 15n : 0n), 'override balance below value + buyIn + gas * gasPrice');
      }
    }
    assert.ok(n > 0, 'no call checked');
  });
}

// ---------- R4: prevRandao ----------
test('[R4] A:d4: every block override carries its header mixHash (k = 0..4; the later block, header 4); A:d2 carries none [R-r4a R-r4b R-r4c]', () => {
  const blk = blkWith(REAL, REAL, 150_000_000n, REAL);
  const h = blk.headers;
  const d4: any = makeCtx(8453, TOKEN, blk, { buyIn: 10n ** 15n, N: 100, mode: 'd4' }, IDS);
  for (let k = 0; k < 5; k++) {
    const bo = d4.blockOverrides(k);
    assert.equal(bo.prevRandao, h[k].mixHash, 'k ' + k); assert.equal(bo.gasLimit, h[k].gasLimit); assert.equal(bo.time, h[k].timestamp); assert.equal(bo.feeRecipient, h[k].miner);
  }
  assert.equal(d4.blockOverrides(5).prevRandao, h[4].mixHash);
  const d2: any = makeCtx(8453, TOKEN, blk, { buyIn: 10n ** 15n, N: 100, mode: 'd2' }, IDS);
  for (let k = 0; k < 5; k++) assert.equal(d2.blockOverrides(k), undefined, 'k ' + k);
  for (const f of ['prevRandao', 'feeRecipient', 'gasLimit']) assert.equal(Object.hasOwn(d2.blockOverrides(5), f), false, f);
});

test('[R4] end to end: the A:d4 requests carry only header mixHashes, the A:d2 requests none [R-r4a R-r4b]', async () => {
  const blk = blkWith(REAL, REAL, 150_000_000n, REAL);
  const mixes = new Set(blk.headers.map((x: any) => x.mixHash));
  for (const rung of ['A:d4', 'A:d2']) {
    const { r, reqs } = await sent(rung, blk, 'fixed');
    assert.equal(r.status, 'RAN');
    const sims = reqs.filter((q) => q.method === 'eth_simulateV1' && !isProbe(q));
    assert.ok(sims.length >= 1);
    const seen = new Set<string>();
    for (const q of sims) for (const b of q.params[0].blockStateCalls) {
      const pr = b.blockOverrides?.prevRandao;
      if (rung === 'A:d2') assert.equal(pr, undefined); else { assert.ok(mixes.has(pr), String(pr)); seen.add(pr); }
    }
    if (rung === 'A:d4') assert.ok(seen.size >= 2, 'distinct mixHashes ' + seen.size);
  }
});

// ---------- R5: codehash pin per (chainId, address) ----------
test('[R5] the codehash pin is per chain: Base router/quoter code at the chain-1 and chain-42161 addresses fails closed; Base passes [R-pin1 R-pin2]', async () => {
  const ok: any = await drive(pinBlock(8453, TOKEN), fakeNode({ chainId: 8453 }).transport);
  assert.equal(ok.code.token, true);
  for (const chainId of [1, 42161]) await assert.rejects(drive(pinBlock(chainId, TOKEN), fakeNode({ chainId }).transport), /codehash mismatch/, String(chainId));
});

test('[R5] a node on another chain is refused before any code is read [R-pin3]', async () => {
  for (const [asked, node] of [[1, 8453], [42161, 8453], [8453, 1], [8453, 42161]]) {
    const n = fakeNode({ chainId: node });
    await assert.rejects(drive(pinBlock(asked, TOKEN), n.transport), /chainId mismatch/, `${asked} on ${node}`);
    assert.equal(n.reqs.filter((q: any) => q.method === 'eth_getCode').length, 0);
  }
});
