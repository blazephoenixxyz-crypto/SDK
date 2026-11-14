// Offline tests for the Router rescue/renunciation decoder. Run: npm test
// The logs are built from the signature strings (toEventSelector, pad,
// encodeAbiParameters), not from the module's ABI, so the oracle is independent
// of the code under test.
//   1.0.0 Routers: no rescue door; renounceControl -> Cfg(0, address(0)).
//   2.0.0 before the rename: cancelRescue -> RescueQueued(token, to, 0); renounceControl -> Cfg(0, address(0)).
//   2.0.0 Routers: cancelRescue -> RescueCancelled(token, to); renounceControl -> ControlRenounced().
import { encodeAbiParameters, getAbiItem, getAddress, pad, toEventSelector, zeroAddress, type Hex } from 'viem';
import { ROUTER_ABI } from '../src/abis.js';
import {
  CFG_TOPIC0, CONTROL_RENOUNCED_TOPIC0, RESCUE_CANCELLED_TOPIC0, RESCUE_QUEUED_TOPIC0,
} from '../src/constants.js';
import { ROUTER_CONTROL_EVENTS_ABI, decodeRouterControlLog } from '../src/controlEvents.js';

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq<T>(name: string, got: T, want: T) {
  const s = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
  check(name, Object.is(got, want) || s(got) === s(want), `got ${s(got)}, want ${s(want)}`);
}

const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const TO = getAddress('0x00000000000000000000000000000000000000a1');
const ADMIN = getAddress('0x00000000000000000000000000000000000000b2');
const SIG = {
  queued: 'RescueQueued(address,address,uint256)',
  cancelled: 'RescueCancelled(address,address)',
  cfg: 'Cfg(uint8,address)',
  renounced: 'ControlRenounced()',
} as const;
const t0 = (s: string) => toEventSelector(s);
const word = (a: Hex) => pad(a, { size: 32 });
const queued = (eta: bigint) => ({
  topics: [t0(SIG.queued), word(TOKEN), word(TO)],
  data: encodeAbiParameters([{ type: 'uint256' }], [eta]),
});
const cfg = (id: number, who: Hex) => ({
  topics: [t0(SIG.cfg)], data: encodeAbiParameters([{ type: 'uint8' }, { type: 'address' }], [id, who]),
});

// ── topic0 constants: from the signature strings ──
console.log('topic0');
eq('RescueQueued topic0', t0(SIG.queued) as string, RESCUE_QUEUED_TOPIC0 as string);
eq('RescueCancelled topic0', t0(SIG.cancelled) as string, RESCUE_CANCELLED_TOPIC0 as string);
eq('Cfg topic0', t0(SIG.cfg) as string, CFG_TOPIC0 as string);
eq('ControlRenounced topic0', t0(SIG.renounced) as string, CONTROL_RENOUNCED_TOPIC0 as string);

// ── parity with the generated Router ABI: same signature and same indexed layout ──
console.log('parity with ROUTER_ABI');
{
  const layout = (e: unknown) => JSON.stringify((e as { inputs: { type: string; indexed?: boolean }[] }).inputs
    .map((i) => [i.type, i.indexed === true]));
  for (const name of ['RescueQueued', 'Cfg', 'RescueCancelled', 'ControlRenounced'] as const) {
    const generated = getAbiItem({ abi: ROUTER_ABI as never, name } as never);
    const ours = ROUTER_CONTROL_EVENTS_ABI.find((e) => e.name === name);
    check(`${name} is in ROUTER_ABI`, generated !== undefined);
    if (generated !== undefined) eq(`${name} layout matches ROUTER_ABI`, layout(ours), layout(generated));
  }
}

// ── cancelRescue ──
console.log('cancelRescue');
eq('2.0.0 RescueCancelled(token, to) -> cancel, read from the indexed topics',
  decodeRouterControlLog({ topics: [t0(SIG.cancelled), word(TOKEN), word(TO)], data: '0x' }),
  { kind: 'RescueCancelled', token: TOKEN, to: TO, legacy: false });
eq('pre-rename 2.0.0 RescueQueued(token, to, 0) -> cancel, legacy form',
  decodeRouterControlLog(queued(0n)), { kind: 'RescueCancelled', token: TOKEN, to: TO, legacy: true });
eq('RescueCancelled with token and to in data (not the declared layout) -> undefined',
  decodeRouterControlLog({
    topics: [t0(SIG.cancelled)], data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [TOKEN, TO]),
  }), undefined);

// ── queueRescue: eta > 0 in every version ──
console.log('queueRescue');
const eta48h = 1_763_000_000n + 48n * 3600n;
eq('RescueQueued eta = now + 48h -> queued', decodeRouterControlLog(queued(eta48h)),
  { kind: 'RescueQueued', token: TOKEN, to: TO, eta: eta48h });
eq('RescueQueued eta = 1 (0 + 1 wei of time) -> queued, not a cancel', decodeRouterControlLog(queued(1n)),
  { kind: 'RescueQueued', token: TOKEN, to: TO, eta: 1n });
eq('RescueQueued eta = 2^256 - 1 -> queued', decodeRouterControlLog(queued(2n ** 256n - 1n)),
  { kind: 'RescueQueued', token: TOKEN, to: TO, eta: 2n ** 256n - 1n });

// ── renounceControl ──
console.log('renounceControl');
eq('2.0.0 ControlRenounced() -> renounced', decodeRouterControlLog({ topics: [t0(SIG.renounced)], data: '0x' }),
  { kind: 'ControlRenounced', legacy: false });
eq('1.0.0 and pre-rename 2.0.0 Cfg(0, address(0)) -> renounced, legacy form', decodeRouterControlLog(cfg(0, zeroAddress)),
  { kind: 'ControlRenounced', legacy: true });
eq('Cfg(0, admin) is setAdmin, not a renunciation -> undefined', decodeRouterControlLog(cfg(0, ADMIN)), undefined);
for (const id of [1, 2, 3, 4]) {
  eq(`Cfg(${id}, address(0)) is a setter, not a renunciation -> undefined`, decodeRouterControlLog(cfg(id, zeroAddress)), undefined);
}

// ── other logs ──
console.log('other logs');
eq('Swap topic0 -> undefined', decodeRouterControlLog({
  topics: [t0('Swap(address,address,address,uint256,uint256,uint256)'), word(ADMIN), word(TOKEN), word(TO)],
  data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [1n, 1n, 1n]),
}), undefined);
eq('no topics -> undefined', decodeRouterControlLog({ topics: [], data: '0x' }), undefined);
eq('RescueQueued with data cut short -> undefined',
  decodeRouterControlLog({ topics: queued(0n).topics, data: '0x' }), undefined);
eq('RescueQueued with a missing indexed topic -> undefined',
  decodeRouterControlLog({ topics: [t0(SIG.queued), word(TOKEN)], data: queued(0n).data }), undefined);

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
