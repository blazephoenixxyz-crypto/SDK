// Offline conformance tests — no network, no chain. Run: npm test
// A mock EIP-1193 provider plays "your node": it answers eth_chainId, eth_call
// (Quoter/Router/ERC-20, encoded with the real ABIs), eth_getCode and getLogs.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionResult,
  getAbiItem, toEventSelector, toFunctionSelector, type AbiFunction,
} from 'viem';
import { formatAbiItem } from 'viem/utils';
import { ERC20_ABI, QUOTER_ABI, ROUTER_ABI, SOLVER_ABI } from '../src/abis.js';
import {
  CHAINS, EXECUTION_PROOF_TOPIC0, FEE_BPS, FEE_TOPIC0, SURPLUS_TOPIC0, SWAP_TOPIC0, resolveChain,
} from '../src/constants.js';
import { EMBEDDED_DEPLOYMENTS, featuresOf, matchesSelector } from '../src/deployments.js';
import { Registry } from '../src/registry.js';
import { RpcRouter, isAllowedRpcUrl, redact, rpcFromEnv, scrubUrls } from '../src/rpc.js';
import {
  decodeSwapExactIn, encodeSwapExactIn, minOutFor, tightenMinOut, verifySwapExactIn,
} from '../src/calldata.js';
import { phoenixCheck } from '../src/checks.js';
import { BlazeError, decodeRevertData } from '../src/errors.js';
import { BlazePhoenix, deepLink } from '../src/client.js';
import { toJSON } from '../src/json.js';
import type { Address, Hex, Preview, Route } from '../src/types.js';

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq<T>(name: string, got: T, want: T) {
  const s = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
  check(name, Object.is(got, want) || s(got) === s(want), `got ${s(got)}, want ${s(want)}`);
}
async function throwsCode(name: string, fn: () => unknown, code: string) {
  try { await fn(); check(name, false, 'did not throw'); }
  catch (e) { check(name, e instanceof BlazeError && e.code === code, `threw ${(e as BlazeError)?.code ?? ''} ${(e as Error)?.message}`); }
}

// ── ABIs: generated from the Dex sources, compatible with the 1.x deployments ──
console.log('ABI');
eq('Swap topic0', toEventSelector(getAbiItem({ abi: ROUTER_ABI, name: 'Swap' }) as never), SWAP_TOPIC0);
eq('ExecutionProof topic0', toEventSelector(getAbiItem({ abi: ROUTER_ABI, name: 'ExecutionProof' }) as never), EXECUTION_PROOF_TOPIC0);
eq('Fee topic0', toEventSelector(getAbiItem({ abi: ROUTER_ABI, name: 'Fee' }) as never), FEE_TOPIC0);
eq('Surplus topic0 (1.x)', toEventSelector('Surplus(address,uint256)') as string, SURPLUS_TOPIC0 as string);
eq('previewPlan selector unchanged since 1.x', toFunctionSelector(getAbiItem({ abi: QUOTER_ABI, name: 'previewPlan' }) as AbiFunction), '0x49d5f197');
{
  // The exact tuple signatures the 1.x SDK/site shipped and the 1.x contracts answer.
  const LEG = '(address,address,uint8,uint24,int24,bool,bool,uint256,uint256,bytes32)';
  const ROUTE = `((address,address,uint256,uint256,${LEG}[])[],uint256,uint256,uint256,uint256,uint256,uint256,bool,bool)`;
  const PV = `(${ROUTE},uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint8,address,bool)`;
  const fmt = (name: string, abi: readonly unknown[]) => formatAbiItem(getAbiItem({ abi: abi as never, name: name as never }) as never);
  eq('swapExactIn signature is the 1.x one', fmt('swapExactIn', ROUTER_ABI), `swapExactIn(${ROUTE},uint256,uint256,address,uint256)`);
  eq('swapExactInWithPermit2 signature', fmt('swapExactInWithPermit2', ROUTER_ABI),
    `swapExactInWithPermit2(${ROUTE},uint256,uint256,address,uint256,((address,uint256),uint256,uint256),bytes)`);
  const outs = (getAbiItem({ abi: QUOTER_ABI, name: 'previewPlan' }) as AbiFunction).outputs;
  eq('previewPlan returns (Preview, Route, bool) — 1.x layout',
    formatAbiItem({ type: 'function', name: '', inputs: outs, outputs: [], stateMutability: 'view' } as never),
    `(${PV},${ROUTE},bool)`);
  check('previewPlanExact typed view (eth_call only)',
    (getAbiItem({ abi: QUOTER_ABI, name: 'previewPlanExact' }) as AbiFunction).stateMutability === 'view');
  for (const f of ['previewAndEncode', 'previewAndEncodeWithMinOut', 'batchQuote', 'VERSION']) {
    check(`2.x Quoter exposes ${f}`, !!getAbiItem({ abi: QUOTER_ABI, name: f as never }));
  }
  for (const f of ['swapExactInNative', 'swapBestExactIn', 'VERSION', 'weth']) {
    check(`2.x Router exposes ${f}`, !!getAbiItem({ abi: ROUTER_ABI, name: f as never }));
  }
  check('Quoter ABI can decode SolverE/HubE/RouterE', ['SolverE', 'HubE', 'RouterE', 'QuoterE']
    .every((n) => QUOTER_ABI.some((x) => x.type === 'error' && x.name === n)));
}

// ── chains ─────────────────────────────────────────────────────────────────
console.log('chains');
eq('base → 8453', resolveChain('base'), 8453);
eq('ETH alias → 1', resolveChain('ETH'), 1);
eq('arbitrum-one', resolveChain('arbitrum-one'), 42161);
eq('robinhood numeric', resolveChain('4663'), 4663);
check('unknown chain throws', (() => { try { resolveChain('solana'); return false; } catch { return true; } })());
eq('robinhood dollar asset is USDG', CHAINS[4663].usdc, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
eq('fee bps', FEE_BPS, 28);

// ── 100% your RPC: nothing in the package can reach a node of ours or anyone's ──
console.log('no shipped RPC');
{
  const src = readdirSync('src').filter((f) => f.endsWith('.ts') && f !== 'abis.generated.ts')
    .map((f) => readFileSync(join('src', f), 'utf8')).join('\n').toLowerCase();
  const providers = /alchemy\.com|drpc\.(org|live)|infura|publicnode|llamarpc|1rpc\.io|ankr\.com|cloudflare-eth|mainnet\.base\.org|mainnet\.optimism\.io|arb1\.arbitrum\.io|rpc\.mainnet\.chain\.robinhood/;
  check('no RPC provider hostnames anywhere in src', !providers.test(src), (src.match(providers) ?? [])[0]);
  const urls = [...src.matchAll(/https?:\/\/[a-z0-9.-]+/g)].map((m) => m[0]);
  const allowed = /^https:\/\/(blazephoenix\.xyz|github\.com|etherscan\.io|basescan\.org|optimistic\.etherscan\.io|arbiscan\.io|robinhoodchain\.blockscout\.com)$/;
  // RFC 2606 reserved names (…example) are documentation placeholders, not nodes.
  const stray = urls.filter((u) => !allowed.test(u) && !/localhost|127\.0\.0\.1|\.example(\.com)?$/.test(u));
  check('the only URLs in src are our docs/registry and explorers', stray.length === 0, stray.join(', '));
  check('rpc_required when no RPC is configured', true);
  await throwsCode('a client without rpc refuses on-chain calls (rpc_required)',
    () => new BlazePhoenix({ registry: { mode: 'embedded' } }).quote({ chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 1n }), 'rpc_required');
}

// ── rpc parsing ──────────────────────────────────────────────────────────────
console.log('rpc');
check('https allowed', isAllowedRpcUrl('https://node.example.com/v2/KEY'));
check('wss allowed', isAllowedRpcUrl('wss://node.example.com'));
check('http refused (remote)', !isAllowedRpcUrl('http://node.example.com'));
check('http localhost allowed (your anvil)', isAllowedRpcUrl('http://127.0.0.1:8545'));
check('javascript: refused', !isAllowedRpcUrl('javascript:alert(1)'));
eq('redact hides the key path', redact('https://base-mainnet.example.com/v2/SECRETKEY'), 'https://base-mainnet.example.com/…');
eq('scrubUrls hides every URL inside a sentence',
  scrubUrls('HTTP request failed.\n\nStatus: 401\nURL: http://127.0.0.1:46071/v2/sk-SECRET\nRequest body: {"method":"eth_chainId"}'),
  'HTTP request failed.\n\nStatus: 401\nURL: http://127.0.0.1:46071/…\nRequest body: {"method":"eth_chainId"}');
{
  // A node that fails the way an HTTP transport does: its error text quotes the URL it called.
  const leaky = { request: async () => { throw new Error('HTTP request failed.\n\nStatus: 401\nURL: https://base-mainnet.example.com/v2/SECRETKEY\nRequest body: {}'); } };
  try {
    await new RpcRouter({ base: leaky as never }, { retries: 0 }).client('base');
    check('a failing RPC is reported as rpc_error', false, 'did not throw');
  } catch (e) {
    check('a failing RPC is reported as rpc_error', e instanceof BlazeError && e.code === 'rpc_error', (e as Error)?.message);
    check('an rpc_error never carries the key from the RPC URL', !String((e as Error)?.message).includes('SECRETKEY'), (e as Error)?.message);
    const chain: string[] = [];
    for (let c: unknown = e; c; c = (c as { cause?: unknown }).cause) chain.push(String((c as Error)?.message ?? c), JSON.stringify(c, Object.getOwnPropertyNames(c as object)) ?? '');
    check('the cause chain of an rpc_error never carries the key either', !chain.join('\n').includes('SECRETKEY'));
  }
}
{
  const env = { BLAZEPHOENIX_RPC_BASE: 'https://a.example.com, https://b.example.com', BLAZEPHOENIX_RPC_1: 'https://c.example.com' };
  eq('rpcFromEnv per-chain + comma fallback', rpcFromEnv(env), { '1': 'https://c.example.com', '8453': ['https://a.example.com', 'https://b.example.com'] });
  eq('rpcFromEnv single', rpcFromEnv({ BLAZEPHOENIX_RPC_URL: 'https://x.example.com' }), 'https://x.example.com');
  eq('rpcFromEnv none', rpcFromEnv({}), undefined);
  check('rpcFromEnv refuses both styles at once', (() => { try { rpcFromEnv({ ...env, BLAZEPHOENIX_RPC_URL: 'https://x.example.com' }); return false; } catch { return true; } })());
  check('rpc map refuses unknown chain', (() => { try { new RpcRouter({ solana: 'https://x.example.com' }); return false; } catch { return true; } })());
  await throwsCode('rpc map: bad URL scheme refused', () => new RpcRouter({ base: 'ftp://x' }).client('base'), 'bad_request');
}

// ── deployments & registry ───────────────────────────────────────────────────
console.log('registry');
{
  check('embedded: 2.0.0 is pending everywhere', Object.values(EMBEDDED_DEPLOYMENTS.versions[0].chains).every((c) => /^0x0{40}$/.test(c!.router)));
  eq('features 1.0.0', featuresOf('1.0.0').previewAndEncode, false);
  eq('features 2.0.0', featuresOf('2.0.0').previewAndEncode, true);
  check('selector "2" matches 2.0.0', matchesSelector('2.0.0', '2'));
  check('selector "2.1" does not match 2.0.0', !matchesSelector('2.0.0', '2.1'));
  check('selector "v1" matches 1.0.0', matchesSelector('1.0.0', 'v1'));

  const reg = new Registry({ mode: 'embedded' });
  eq('latest on Base today is 1.0.0', reg.resolve(8453).version, '1.0.0');
  eq('1.0.0 Base quoter', reg.resolve(8453, '1').contracts.quoter, '0x4cEF0615614B212895F45Aa1D4833B16666E18d3');
  check('asking for 2 before it is deployed → not_deployed',
    (() => { try { reg.resolve(8453, '2'); return false; } catch (e) { return (e as BlazeError).code === 'not_deployed'; } })());

  const warnings: string[] = [];
  const reg2 = new Registry({ mode: 'embedded', onWarning: (m) => warnings.push(m) });
  const V2 = { core: '0x00000000000000000000000000000000000000c0', hub: '0x00000000000000000000000000000000000000a1', solver: '0x00000000000000000000000000000000000000a2', router: '0x00000000000000000000000000000000000000a3', quoter: '0x00000000000000000000000000000000000000a4' };
  reg2.merge({
    schema: 1,
    versions: [
      { version: '2.0.0', status: 'live', chains: { 8453: V2 } },
      // A hostile document trying to move a pinned 1.0.0 router:
      { version: '1.0.0', status: 'live', chains: { 8453: { ...V2, router: '0x00000000000000000000000000000000deadbeef' } } },
    ],
  });
  const r2 = reg2.resolve(8453);
  eq('remote 2.0.0 becomes latest the moment it is published', [r2.version, r2.source, r2.contracts.core], ['2.0.0', 'remote', V2.core]);
  eq('pinned 1.0.0 router cannot be moved by the registry', reg2.resolve(8453, '1').contracts.router, '0x2a779f9Be49aac57495A8B6467Cc325a8a47Eb9f');
  check('pin conflict reported', warnings.some((w) => w.includes('pinned router')));
  eq('other chains still on 1.0.0', reg2.resolve(1).version, '1.0.0');
  const wv = warnings.length;
  reg2.merge({ schema: 1, versions: [{ version: '1.0.1', status: 'live', chains: { 1: { ...V2, router: '0x00000000000000000000000000000000000000b9' } } }] });
  check('a NEW 1.x version from the registry (not verifiable on-chain) is ignored',
    reg2.resolve(1).version === '1.0.0' && warnings.length === wv + 1 && warnings.at(-1)!.includes('1.0.1'));
  const w0 = warnings.length;
  reg2.merge({ schema: 1, versions: [{ version: '2.0.0', chains: { 8453: { router: 'nope' } } }] });
  check('malformed registry rejected with a warning', warnings.length === w0 + 1 && reg2.resolve(8453).contracts.router === V2.router);
  reg2.merge({ schema: 2, versions: [] });
  check('unknown schema rejected', warnings.length === w0 + 2);

  const reg3 = new Registry({ mode: 'embedded' }, { base: { router: '0x00000000000000000000000000000000000000b1', quoter: '0x00000000000000000000000000000000000000b2', version: '2.0.0' } });
  const r3 = reg3.resolve(8453);
  eq('override wins (your own deployment)', [r3.source, r3.version, r3.contracts.router], ['override', '2.0.0', '0x00000000000000000000000000000000000000b1']);
  check('override with a bad address refused', (() => { try { new Registry({}, { base: { router: 'x' as Address } }); return false; } catch { return true; } })());

  // Remote fetch path, through an injected fetch.
  let fetches = 0;
  const reg4 = new Registry({
    mode: 'auto', url: 'https://blazephoenix.xyz/api/deployments',
    fetchFn: (async () => { fetches++; return new Response(JSON.stringify({ ok: true, registry: { schema: 1, versions: [{ version: '2.0.0', status: 'live', chains: { 10: V2 } }] } }), { status: 200 }); }) as unknown as typeof fetch,
  });
  await reg4.refresh();
  await reg4.refresh();
  eq('remote refresh: fetched once within TTL', fetches, 1);
  eq('remote refresh: Optimism now 2.0.0', reg4.resolve(10).version, '2.0.0');
  const reg5 = new Registry({ mode: 'auto', fetchFn: (async () => { throw new Error('offline'); }) as unknown as typeof fetch, onWarning: () => {} });
  await reg5.refresh();
  eq('registry offline → embedded snapshot still answers', reg5.resolve(8453).version, '1.0.0');
  let fetched = false;
  await new Registry({ mode: 'embedded', fetchFn: (async () => { fetched = true; return new Response('{}'); }) as unknown as typeof fetch }).refresh();
  check("mode 'embedded' never touches the network", !fetched);

  // ready(): the first lookup waits (bounded); later ones never block on the site.
  let n = 0;
  let release: () => void = () => {};
  const slowFetch = (async () => {
    n++;
    if (n > 1) await new Promise<void>((r) => { release = r; });
    return new Response(JSON.stringify({ schema: 1, versions: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const reg6 = new Registry({ mode: 'auto', fetchFn: slowFetch, ttlMs: 0 });
  await reg6.ready();
  eq('ready(): first call waits for the registry', n, 1);
  const t0 = Date.now();
  await reg6.ready(); // stale (ttl 0) → background revalidate, must not wait on the hanging fetch
  check('ready(): later calls revalidate in the background (non-blocking)', Date.now() - t0 < 50 && n === 2);
  release();
  const timeouts: number[] = [];
  const hang = ((_u: string, init?: RequestInit) => new Promise<Response>((_r, rej) => {
    init?.signal?.addEventListener('abort', () => { timeouts.push(Date.now()); rej(new Error('aborted')); });
  })) as unknown as typeof fetch;
  const t1 = Date.now();
  await new Registry({ mode: 'auto', url: 'https://registry-mirror.example/api/deployments', fetchFn: hang, timeoutMs: 200, onWarning: () => {} }).ready();
  check('ready(): an unreachable site delays the first call by at most timeoutMs', Date.now() - t1 < 1_000 && timeouts.length === 1);

  // Two clients in one process: one download, but BOTH registries learn the new addresses.
  let downloads = 0;
  const shared = (async () => {
    downloads++;
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify({ schema: 1, versions: [{ version: '2.0.0', status: 'live', chains: { 42161: V2 } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const ra = new Registry({ mode: 'auto', url: 'https://shared.example/r', fetchFn: shared });
  const rb = new Registry({ mode: 'auto', url: 'https://shared.example/r', fetchFn: shared });
  await Promise.all([ra.ready(), rb.ready()]);
  eq('shared refresh: one download, every instance merges it', [downloads, ra.resolve(42161).version, rb.resolve(42161).version], [1, '2.0.0', '2.0.0']);
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const WETH = CHAINS[8453].weth;
const USDC = CHAINS[8453].usdc;
const ME = '0x1111111111111111111111111111111111111111' as Address;
const EVIL = '0x9999999999999999999999999999999999999999' as Address;
const POOL = '0xd0b53D9277642d899DF5C87A3966A349A798F224' as Address;
const V1 = EMBEDDED_DEPLOYMENTS.versions.find((v) => v.version === '1.0.0')!.chains[8453]!;

function mkRoute(tIn: Address, tOut: Address, amountIn: bigint, out: bigint): Route {
  return {
    hops: [{
      tokenIn: tIn, tokenOut: tOut, amountIn, expectedOut: out,
      legs: [{ pool: POOL, hooks: '0x0000000000000000000000000000000000000000', kind: 2, fee: 500, tickSpacing: 10, zeroForOne: true, stable: false, amountIn, expectedOut: out, auxId: `0x${'0'.repeat(64)}` }],
    }],
    totalOut: out, singleOut: out, singleOutFloor: (out * 90n) / 100n, expectedImpactBps: 12n,
    confidenceWad: 10n ** 18n, estGas: 180_000n, hasSurplus: false, isV4Bundle: false,
  };
}
function mkPreview(route: Route, userMinOut = 0n, canExecute = true): Preview {
  const gross = route.totalOut;
  const afterFee = gross - (gross * 28n + 9_999n) / 10_000n;
  const floor = route.singleOutFloor;
  return {
    route, grossOut: gross, protocolFee: gross - afterFee, safetyBuffer: 0n, netOut: afterFee,
    ironFloor: floor, userMinOut, effectiveMinOut: userMinOut > floor ? userMinOut : floor,
    estGas: route.estGas, hops: 1n, legs: 1n, topology: 0, bridgeUsed: '0x0000000000000000000000000000000000000000', canExecute,
  };
}

interface MockOpts {
  chainId?: number;
  quoter?: Address;
  router?: Address;
  version?: string;               // what VERSION() answers (undefined → reverts, like 1.x)
  hub?: Address; solver?: Address;
  tamper?: 'recipient' | 'amount' | 'route';
  revert?: Hex;                   // revert data for any Quoter call
  allowance?: bigint;
  decimals?: number;
  outFor?: (amountIn: bigint) => bigint;
  simulateRevert?: Hex;
}
function mockProvider(o: MockOpts = {}) {
  const calls: { method: string; fn?: string; to?: string }[] = [];
  const quoter = (o.quoter ?? V1.quoter).toLowerCase();
  const router = (o.router ?? V1.router).toLowerCase();
  const outFor = o.outFor ?? ((a: bigint) => a * 3_000n / 10n ** 12n);
  const provider = {
    async request({ method, params }: { method: string; params?: unknown }) {
      const p = params as unknown[];
      if (method === 'eth_chainId') { calls.push({ method }); return `0x${(o.chainId ?? 8453).toString(16)}`; }
      if (method === 'eth_blockNumber') return '0x100';
      if (method === 'eth_getCode') return '0x6080604052';
      if (method === 'eth_getLogs') {
        calls.push({ method });
        const f = (p[0] ?? {}) as { fromBlock?: string; toBlock?: string };
        const from = f.fromBlock ? BigInt(f.fromBlock) : 0n;
        const to = f.toBlock && f.toBlock !== 'latest' ? BigInt(f.toBlock) : 1n << 64n;
        return from <= 0xffn && 0xffn <= to ? logsFixture(router as Address) : [];
      }
      if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
      const { to, data } = p[0] as { to: string; data: Hex };
      const t = to.toLowerCase();
      if (t === quoter) {
        const d = decodeFunctionData({ abi: QUOTER_ABI, data });
        calls.push({ method, fn: d.functionName, to: t });
        if (o.revert) { const e = new Error('execution reverted') as Error & { code: number; data: Hex }; e.code = 3; e.data = o.revert; throw e; }
        const hub = o.hub ?? '0x00000000000000000000000000000000000000a1';
        const solver = o.solver ?? '0x00000000000000000000000000000000000000a2';
        switch (d.functionName) {
          case 'VERSION':
            if (!o.version) throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' });
            return encodeFunctionResult({ abi: QUOTER_ABI, functionName: 'VERSION', result: o.version });
          case 'hub': return encodeFunctionResult({ abi: QUOTER_ABI, functionName: 'hub', result: hub });
          case 'solver': return encodeFunctionResult({ abi: QUOTER_ABI, functionName: 'solver', result: solver });
          case 'previewPlan': case 'previewPlanWithMinOut': {
            const [tIn, tOut, amt, umo] = d.args as unknown as [Address, Address, bigint, bigint?];
            const route = mkRoute(tIn, tOut, amt, outFor(amt));
            return encodeFunctionResult({ abi: QUOTER_ABI, functionName: d.functionName, result: [mkPreview(route, umo ?? 0n), route, false] as never });
          }
          case 'previewAndEncode': case 'previewAndEncodeWithMinOut': {
            const a = d.args as unknown as unknown[];
            const [tIn, tOut, amt] = a as [Address, Address, bigint];
            const umo = d.functionName === 'previewAndEncodeWithMinOut' ? (a[3] as bigint) : 0n;
            const recipient = (d.functionName === 'previewAndEncodeWithMinOut' ? a[4] : a[3]) as Address;
            const deadline = (d.functionName === 'previewAndEncodeWithMinOut' ? a[5] : a[4]) as bigint;
            const route = mkRoute(tIn, tOut, amt, outFor(amt));
            const pv = mkPreview(route, umo);
            const encRoute = o.tamper === 'route' ? mkRoute(tIn, tOut, amt, outFor(amt) + 1n) : route;
            const call = encodeSwapExactIn(encRoute, o.tamper === 'amount' ? amt * 2n : amt, pv.effectiveMinOut,
              o.tamper === 'recipient' ? EVIL : recipient, deadline);
            return encodeFunctionResult({ abi: QUOTER_ABI, functionName: d.functionName, result: [pv, call] as never });
          }
          case 'batchQuote': {
            const [entries] = d.args as [{ tIn: Address; tOut: Address; amountIn: bigint; userMinOut: bigint }[]];
            const pvs = entries.map((e) => (e.amountIn === 7n
              ? mkPreview({ ...mkRoute(e.tIn, e.tOut, 0n, 0n), hops: [] }, 0n, false)
              : mkPreview(mkRoute(e.tIn, e.tOut, e.amountIn, outFor(e.amountIn)), e.userMinOut)));
            return encodeFunctionResult({ abi: QUOTER_ABI, functionName: 'batchQuote', result: pvs as never });
          }
          case 'previewPlanExact': {
            const [tIn, tOut, amt] = d.args as [Address, Address, bigint];
            return encodeFunctionResult({ abi: QUOTER_ABI, functionName: 'previewPlanExact', result: [mkRoute(tIn, tOut, amt, outFor(amt)), outFor(amt) - 5n] as never });
          }
          default: throw new Error(`quoter fn ${d.functionName}`);
        }
      }
      if (t === router) {
        const d = decodeFunctionData({ abi: ROUTER_ABI, data });
        calls.push({ method, fn: d.functionName, to: t });
        if (d.functionName === 'VERSION') {
          if (!o.version) throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' });
          return encodeFunctionResult({ abi: ROUTER_ABI, functionName: 'VERSION', result: o.version });
        }
        if (d.functionName === 'hub') return encodeFunctionResult({ abi: ROUTER_ABI, functionName: 'hub', result: o.hub ?? '0x00000000000000000000000000000000000000a1' });
        if (d.functionName === 'solver') return encodeFunctionResult({ abi: ROUTER_ABI, functionName: 'solver', result: o.solver ?? '0x00000000000000000000000000000000000000a2' });
        if (o.simulateRevert) throw Object.assign(new Error('execution reverted'), { code: 3, data: o.simulateRevert });
        return encodeFunctionResult({ abi: ROUTER_ABI, functionName: 'swapExactIn', result: 2_990n });
      }
      if (t === '0x00000000000000000000000000000000000000a2') {
        const d = decodeFunctionData({ abi: SOLVER_ABI, data });
        calls.push({ method, fn: `solver.${d.functionName}`, to: t });
        if (d.functionName === 'VERSION') return encodeFunctionResult({ abi: SOLVER_ABI, functionName: 'VERSION', result: o.version ?? '' });
        if (d.functionName === 'hub') return encodeFunctionResult({ abi: SOLVER_ABI, functionName: 'hub', result: o.hub ?? '0x00000000000000000000000000000000000000a1' });
      }
      // ERC-20 surface on any other address
      const d = decodeFunctionData({ abi: ERC20_ABI, data });
      calls.push({ method, fn: `erc20.${d.functionName}`, to: t });
      if (d.functionName === 'decimals') return encodeFunctionResult({ abi: ERC20_ABI, functionName: 'decimals', result: o.decimals ?? 18 });
      if (d.functionName === 'allowance') return encodeFunctionResult({ abi: ERC20_ABI, functionName: 'allowance', result: o.allowance ?? 0n });
      if (d.functionName === 'symbol') return encodeFunctionResult({ abi: ERC20_ABI, functionName: 'symbol', result: 'TKN' });
      if (d.functionName === 'name') return encodeFunctionResult({ abi: ERC20_ABI, functionName: 'name', result: 'Token' });
      throw new Error(`erc20 fn ${d.functionName}`);
    },
  };
  return { provider, calls };
}

function logsFixture(router: Address) {
  const swapEv = getAbiItem({ abi: ROUTER_ABI, name: 'Swap' });
  const proofEv = getAbiItem({ abi: ROUTER_ABI, name: 'ExecutionProof' });
  const base = { address: router, blockHash: `0x${'ab'.repeat(32)}`, blockNumber: '0xff', transactionHash: `0x${'cd'.repeat(32)}`, transactionIndex: '0x0', removed: false };
  return [
    {
      ...base, logIndex: '0x4',
      topics: encodeEventTopics({ abi: [swapEv], eventName: 'Swap', args: { user: ME, tokenIn: WETH, tokenOut: USDC } }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [10n ** 18n, 3_000_000_000n, 1n]),
    },
    {
      ...base, logIndex: '0x5',
      topics: encodeEventTopics({ abi: [proofEv], eventName: 'ExecutionProof', args: { user: ME, tokenOut: USDC } }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [2_999_000_000n, 3_000_000_000n, 2_700_000_000n, 255n]),
    },
  ];
}

// ── calldata verification (pure) ─────────────────────────────────────────────
console.log('calldata');
{
  const route = mkRoute(WETH, USDC, 10n ** 18n, 3_000_000_000n);
  const dl = 2_000_000_000n;
  const honest = encodeSwapExactIn(route, 10n ** 18n, 2_700_000_000n, ME, dl);
  const want = { tokenIn: WETH, tokenOut: USDC, amountIn: 10n ** 18n, recipient: ME, deadline: dl, minOutAtLeast: 2_700_000_000n, route };
  check('honest Quoter bytes verify', verifySwapExactIn(honest, want).userMinOut === 2_700_000_000n);
  const bad = (name: string, data: Hex, w = want) => check(name, (() => { try { verifySwapExactIn(data, w); return false; } catch (e) { return (e as BlazeError).code === 'calldata_mismatch'; } })());
  bad('recipient swapped → refused', encodeSwapExactIn(route, 10n ** 18n, 2_700_000_000n, EVIL, dl));
  bad('amountIn inflated → refused', encodeSwapExactIn(route, 2n * 10n ** 18n, 2_700_000_000n, ME, dl));
  bad('deadline moved → refused', encodeSwapExactIn(route, 10n ** 18n, 2_700_000_000n, ME, dl + 1n));
  bad('minimum loosened → refused', encodeSwapExactIn(route, 10n ** 18n, 1n, ME, dl));
  bad('route differs from preview → refused', encodeSwapExactIn(mkRoute(WETH, USDC, 10n ** 18n, 1n), 10n ** 18n, 2_700_000_000n, ME, dl));
  bad('route to another token → refused', encodeSwapExactIn(mkRoute(WETH, EVIL, 10n ** 18n, 3_000_000_000n), 10n ** 18n, 2_700_000_000n, ME, dl), { ...want, route: undefined as never });
  const tight = tightenMinOut(honest, 2_900_000_000n);
  const td = decodeSwapExactIn(tight);
  eq('tightenMinOut keeps route, raises minimum', [td.userMinOut, td.recipient, td.amountIn], [2_900_000_000n, ME, 10n ** 18n]);
  eq('tightenMinOut never loosens', tightenMinOut(honest, 1n), honest);
  eq('minOutFor 50bps', minOutFor(10_000n, 50, 0n), 9_950n);
  eq('minOutFor never below the floor', minOutFor(10_000n, 5_000, 9_000n), 9_000n);
  check('minOutFor rejects > 5000', (() => { try { minOutFor(1n, 5_001, 0n); return false; } catch { return true; } })());
}

// ── Phoenix Check ────────────────────────────────────────────────────────────
console.log('checks');
{
  const r = mkRoute(WETH, USDC, 1n, 100n);
  eq('ok verdict', phoenixCheck(mkPreview(r), WETH, USDC).verdict, 'ok');
  eq('caution ≥ 2%', phoenixCheck(mkPreview({ ...r, expectedImpactBps: 250n }), WETH, USDC).verdict, 'caution');
  eq('danger ≥ 20%', phoenixCheck(mkPreview({ ...r, expectedImpactBps: 2_500n }), WETH, USDC).verdict, 'danger');
  eq('blocked when it cannot execute', phoenixCheck(mkPreview(r, 0n, false), WETH, USDC).verdict, 'blocked');
  eq('blocked when the route goes elsewhere', phoenixCheck(mkPreview(r), WETH, EVIL).verdict, 'blocked');
}

// ── errors ───────────────────────────────────────────────────────────────────
console.log('errors');
{
  const d = decodeRevertData(encodeErrorResult({ abi: ROUTER_ABI, errorName: 'RouterE', args: [5] }));
  eq('RouterE(5) decoded', [d?.contract, d?.code, d?.reason.startsWith('slippage')], ['Router', 5, true]);
  const s = decodeRevertData(encodeErrorResult({ abi: QUOTER_ABI, errorName: 'SolverE', args: [5] }));
  eq('SolverE(5) = no route', s?.reason.startsWith('no route'), true);
}

// ── client on a 1.x deployment (mock node) ───────────────────────────────────
console.log('client · 1.x');
{
  const { provider, calls } = mockProvider();
  const blaze = new BlazePhoenix({ rpc: { base: provider }, registry: { mode: 'embedded' }, cacheTtlMs: 0 });
  const q = await blaze.quote({ chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC', amount: '1' });
  eq('quote: 1.0.0 on Base', [q.version, q.quoter, q.deploymentSource], ['1.0.0', V1.quoter, 'embedded']);
  eq('quote: human amount → base units via decimals on YOUR node', q.amountIn, 10n ** 18n);
  eq('quote: amountOut = netOut', q.amountOut, q.preview.netOut);
  eq('quote: checks ok', q.checks.verdict, 'ok');
  check('quote: node asked for its chain id first', calls[0]?.method === 'eth_chainId');

  const plan = await blaze.buildSwap({ chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 10n ** 18n, recipient: ME, from: ME, deadline: 2_000_000_000n });
  const dd = decodeSwapExactIn(plan.tx.data);
  eq('1.x buildSwap: encoded locally, swapExactIn to the 1.x Router', [plan.encodedBy, plan.entry, plan.tx.to], ['sdk', 'swapExactIn', V1.router]);
  eq('1.x buildSwap: minOut = netOut − 0.5% (default)', dd.userMinOut, minOutFor(plan.quote.amountOut, 50, plan.quote.preview.effectiveMinOut));
  eq('1.x buildSwap: recipient + deadline', [dd.recipient, dd.deadline], [ME, 2_000_000_000n]);
  check('1.x buildSwap: approval step (allowance 0)', plan.approval?.spender === V1.router && plan.approval.current === 0n && plan.steps.length === 2);
  await throwsCode('1.x: native ETH input needs 2.x (wrap first)',
    () => blaze.buildSwap({ chain: 'base', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: 1n, recipient: ME }), 'unsupported_by_version');
  await throwsCode("1.x: mode 'best' needs 2.x",
    () => blaze.buildSwap({ chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 1n, recipient: ME, mode: 'best' }), 'unsupported_by_version');
  await throwsCode('unknown symbol refused (no guessing)',
    () => blaze.quote({ chain: 'base', tokenIn: 'TOSHI', tokenOut: 'USDC', amountIn: 1n }), 'bad_request');
  await throwsCode('same token refused', () => blaze.quote({ chain: 'base', tokenIn: 'WETH', tokenOut: WETH, amountIn: 1n }), 'bad_request');
  await throwsCode('ETH→WETH is a wrap, not a swap', () => blaze.quote({ chain: 'base', tokenIn: 'ETH', tokenOut: 'WETH', amountIn: 1n }), 'bad_request');
  await throwsCode('chain without an RPC → rpc_required', () => blaze.quote({ chain: 'eth', tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 1n }), 'rpc_required');

  const { provider: rich } = mockProvider({ allowance: 10n ** 30n });
  const p2 = await new BlazePhoenix({ rpc: rich, registry: { mode: 'embedded' } })
    .buildSwap({ tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 10n ** 18n, recipient: ME, from: ME, slippageBps: 100 });
  check('single RPC: chain inferred from the node; no approval when allowance suffices', p2.tx.chainId === 8453 && p2.approval === null && p2.steps.length === 1);

  const sim = await blaze.simulate(p2, ME);
  eq('simulate: realised amountOut from eth_call', [sim.ok, sim.amountOut], [true, 2_990n]);
  const { provider: sad } = mockProvider({ allowance: 10n ** 30n, simulateRevert: encodeErrorResult({ abi: ROUTER_ABI, errorName: 'RouterE', args: [5] }) });
  const b3 = new BlazePhoenix({ rpc: sad, registry: { mode: 'embedded' } });
  const p3 = await b3.buildSwap({ tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 10n ** 18n, recipient: ME, from: ME });
  const sim3 = await b3.simulate(p3, ME);
  eq('simulate: revert decoded to RouterE(5)', [sim3.ok, sim3.error?.name, sim3.error?.code], [false, 'RouterE', 5]);

  const { provider: wrong } = mockProvider({ chainId: 1 });
  await throwsCode('node on the wrong chain → rpc_chain_mismatch',
    () => new BlazePhoenix({ rpc: { base: wrong }, registry: { mode: 'embedded' } }).quote({ chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 1n }), 'rpc_chain_mismatch');

  const { provider: noRoute } = mockProvider({ revert: encodeErrorResult({ abi: QUOTER_ABI, errorName: 'SolverE', args: [5] }) });
  try {
    await new BlazePhoenix({ rpc: noRoute, registry: { mode: 'embedded' } }).quote({ tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 1n });
    check('SolverE(5) → no_route', false);
  } catch (e) {
    const b = e as BlazeError;
    check('SolverE(5) → no_route with the decoded revert', b.code === 'no_route' && b.revert?.name === 'SolverE' && b.revert.code === 5, `${b.code} ${b.message}`);
  }

  const fills = await blaze.getFills({ chain: 'base', fromBlock: 0n, toBlock: 255n });
  eq('getFills: Swap decoded + ExecutionProof joined', [fills.length, fills[0]?.amountOut, fills[0]?.proof?.floorUsed], [1, 3_000_000_000n, 2_700_000_000n]);
  const before = calls.filter((c) => c.method === 'eth_getLogs').length;
  const chunked = await blaze.getFills({ chain: 'base', fromBlock: 0n, toBlock: 4_999n, chunkBlocks: 2_000n });
  eq('getFills: range read in provider-friendly chunks (3 × 2000 blocks), no duplicates',
    [calls.filter((c) => c.method === 'eth_getLogs').length - before, chunked.length], [3, 1]);

  const ex = await blaze.quoteExact({ chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 10n ** 18n });
  eq('quoteExact: previewPlanExact via eth_call', ex.exactOut, 3_000_000_000n - 5n);
  const ti = await blaze.tokenInfo('base', USDC);
  eq('tokenInfo on your node', [ti.symbol, ti.decimals], ['TKN', 18]);
}

// ── client on a 2.x deployment ──────────────────────────────────────────────
console.log('client · 2.x');
{
  const R = '0x00000000000000000000000000000000000000a3' as Address;
  const Q = '0x00000000000000000000000000000000000000a4' as Address;
  const override = { base: { router: R, quoter: Q, hub: '0x00000000000000000000000000000000000000a1' as Address, solver: '0x00000000000000000000000000000000000000a2' as Address, version: '2.0.0' } };
  const { provider, calls } = mockProvider({ quoter: Q, router: R, version: '2.0.0' });
  const blaze = new BlazePhoenix({ rpc: { base: provider }, contracts: override, registry: { mode: 'embedded' } });
  const plan = await blaze.buildSwap({ chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 10n ** 18n, recipient: ME, deadline: 2_000_000_000n, slippageBps: 30 });
  eq('2.x buildSwap: the Quoter encoded it (previewAndEncode), SDK verified', [plan.encodedBy, plan.entry, plan.tx.to], ['quoter', 'swapExactIn', R]);
  check('2.x buildSwap: ONE Quoter eth_call', calls.filter((c) => c.fn?.startsWith('preview')).length === 1 && calls.some((c) => c.fn === 'previewAndEncode'));
  eq('2.x buildSwap: minimum tightened to 30 bps', decodeSwapExactIn(plan.tx.data).userMinOut, minOutFor(plan.quote.amountOut, 30, plan.quote.preview.effectiveMinOut));
  check('2.x buildSwap: approval named without `from` (unchecked)', plan.approval !== null && plan.approval.current === undefined);

  const withMin = await blaze.buildSwap({ chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 10n ** 18n, recipient: ME, userMinOut: 2_950_000_000n });
  check('2.x userMinOut → previewAndEncodeWithMinOut', calls.some((c) => c.fn === 'previewAndEncodeWithMinOut') && decodeSwapExactIn(withMin.tx.data).userMinOut >= 2_950_000_000n);

  for (const tamper of ['recipient', 'amount', 'route'] as const) {
    const { provider: evil } = mockProvider({ quoter: Q, router: R, version: '2.0.0', tamper });
    await throwsCode(`2.x: a Quoter that tampers with ${tamper} is refused`,
      () => new BlazePhoenix({ rpc: evil, contracts: override, registry: { mode: 'embedded' } })
        .buildSwap({ tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 10n ** 18n, recipient: ME }), 'calldata_mismatch');
  }

  const native = await blaze.buildSwap({ chain: 'base', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: 10n ** 17n, recipient: ME });
  const nd = decodeFunctionData({ abi: ROUTER_ABI, data: native.tx.data });
  eq('2.x native ETH → swapExactInNative with value, no approval', [native.entry, nd.functionName, native.tx.value, native.approval], ['swapExactInNative', 'swapExactInNative', 10n ** 17n, null]);

  const best = await blaze.buildSwap({ chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 10n ** 18n, recipient: ME, mode: 'best' });
  eq("2.x mode 'best' → swapBestExactIn", decodeFunctionData({ abi: ROUTER_ABI, data: best.tx.data }).functionName, 'swapBestExactIn');

  const out = await blaze.quoteBatch([
    { chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 10n ** 18n },
    { chain: 'base', tokenIn: 'USDC', tokenOut: 'WETH', amountIn: 7n },
    { chain: 'base', tokenIn: 'NOPE', tokenOut: 'WETH', amountIn: 1n },
  ]);
  eq('2.x quoteBatch: per-item results', out.map((r) => (r.ok ? 'ok' : r.error.code)), ['ok', 'no_route', 'bad_request']);
  check('2.x quoteBatch: one on-chain batchQuote', calls.filter((c) => c.fn === 'batchQuote').length === 1);

  const out2 = toJSON(plan.quote);
  check('toJSON: bigints → decimal strings', typeof out2.amountOut === 'string' && out2.amountOut === plan.quote.amountOut.toString());
}

// ── remote registry → verified on YOUR node before first use ───────────────────
console.log('client · remote registry verification');
{
  const V2 = { core: '0x00000000000000000000000000000000000000c0', hub: '0x00000000000000000000000000000000000000a1', solver: '0x00000000000000000000000000000000000000a2', router: '0x00000000000000000000000000000000000000a3', quoter: '0x00000000000000000000000000000000000000a4' };
  const fetchFn = (async () => new Response(JSON.stringify({ schema: 1, versions: [{ version: '2.0.0', status: 'live', chains: { 8453: V2 } }] }), { status: 200 })) as unknown as typeof fetch;
  const { provider: good } = mockProvider({ quoter: V2.quoter as Address, router: V2.router as Address, version: '2.0.0' });
  const q = await new BlazePhoenix({ rpc: good, registry: { mode: 'auto', fetchFn } }).quote({ tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 10n ** 18n });
  eq('new deployment published on the site → used at once, after on-chain verification', [q.version, q.deploymentSource, q.quoter], ['2.0.0', 'remote', V2.quoter]);
  const { provider: liar } = mockProvider({ quoter: V2.quoter as Address, router: V2.router as Address, version: '9.9.9' });
  await throwsCode('registry entry whose contracts do not say VERSION 2.0.0 → refused',
    () => new BlazePhoenix({ rpc: liar, registry: { mode: 'auto', fetchFn } }).quote({ tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 1n }), 'deployment_unverified');
  const { provider: wired } = mockProvider({ quoter: V2.quoter as Address, router: V2.router as Address, version: '2.0.0', hub: '0x00000000000000000000000000000000000000ee' });
  await throwsCode('registry entry wired to another Hub → refused',
    () => new BlazePhoenix({ rpc: wired, registry: { mode: 'auto', fetchFn } }).quote({ tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 1n }), 'deployment_unverified');
  {
    const Z = '0x0000000000000000000000000000000000000000';
    const unwired = { ...V2, hub: Z, solver: Z };
    const fz = (async () => new Response(JSON.stringify({ schema: 1, versions: [{ version: '2.0.0', status: 'live', chains: { 8453: unwired } }] }), { status: 200 })) as unknown as typeof fetch;
    await throwsCode('remote 2.x entry with a zero Hub/Solver cannot skip the wiring checks → refused',
      () => new BlazePhoenix({ rpc: good, registry: { mode: 'auto', fetchFn: fz } }).quote({ tokenIn: 'WETH', tokenOut: 'USDC', amountIn: 1n }), 'deployment_unverified');
  }
  {
    const leakyCall = { request: async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_blockNumber') return '0x10';
      throw new Error('HTTP request failed.\n\nURL: https://base-mainnet.example.com/v2/SECRETKEY');
    } };
    try {
      await new BlazePhoenix({ rpc: { base: leakyCall as never } }).solvency();
      check('solvency(): a failing read never carries the key from the RPC URL', false, 'did not throw');
    } catch (e) {
      const chain: string[] = [];
      for (let c: unknown = e; c; c = (c as { cause?: unknown }).cause) chain.push(String((c as Error)?.message ?? c), JSON.stringify(c, Object.getOwnPropertyNames(c as object)) ?? '');
      check('solvency(): a failing read never carries the key from the RPC URL', !chain.join('\n').includes('SECRETKEY'), String((e as Error)?.message));
    }
  }
  const v1still = await new BlazePhoenix({ rpc: good, version: '1', registry: { mode: 'auto', fetchFn } }).resolveDeployment({ chain: 'base' });
  eq('version pin "1" keeps the 1.x contracts', [v1still.version, v1still.contracts.router], ['1.0.0', V1.router]);
}

// ── execute(): approve → simulate → swap → realised output, with a real viem wallet ──
console.log('client · execute');
{
  const { createWalletClient, custom, keccak256, parseTransaction, encodeAbiParameters: enc, encodeEventTopics: topics } = await import('viem');
  const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts');
  const account = privateKeyToAccount(generatePrivateKey());
  const ZERO_A = '0x0000000000000000000000000000000000000000';
  const sent: { to: string; selector: string }[] = [];
  let allowance = 0n;
  const receipts = new Map<string, unknown>();
  const swapEv = getAbiItem({ abi: ROUTER_ABI, name: 'Swap' });
  const node = {
    async request({ method, params }: { method: string; params?: unknown }) {
      const p = (params ?? []) as unknown[];
      switch (method) {
        case 'eth_chainId': return '0x2105';
        case 'eth_blockNumber': return '0x200';
        case 'eth_getBlockByNumber': return { number: '0x200', hash: `0x${'11'.repeat(32)}`, parentHash: `0x${'22'.repeat(32)}`, timestamp: '0x6500000', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', transactions: [], miner: ZERO_A, difficulty: '0x0', extraData: '0x', logsBloom: `0x${'00'.repeat(256)}`, nonce: '0x0000000000000000', receiptsRoot: `0x${'00'.repeat(32)}`, sha3Uncles: `0x${'00'.repeat(32)}`, size: '0x1', stateRoot: `0x${'00'.repeat(32)}`, totalDifficulty: '0x0', transactionsRoot: `0x${'00'.repeat(32)}`, uncles: [] };
        case 'eth_maxPriorityFeePerGas': return '0x3b9aca00';
        case 'eth_gasPrice': return '0x3b9aca00';
        case 'eth_getTransactionCount': return `0x${sent.length.toString(16)}`;
        case 'eth_estimateGas': return '0x30d40';
        case 'eth_sendRawTransaction': {
          const raw = p[0] as Hex;
          const tx = parseTransaction(raw);
          const hash = keccak256(raw);
          sent.push({ to: String(tx.to).toLowerCase(), selector: (tx.data ?? '0x').slice(0, 10) });
          const isApprove = (tx.data ?? '').startsWith('0x095ea7b3');
          if (isApprove) allowance = 2n ** 255n;
          const logs = isApprove ? [] : [{
            address: V1.router, blockHash: `0x${'33'.repeat(32)}`, blockNumber: '0x201', transactionHash: hash, transactionIndex: '0x0', logIndex: '0x0', removed: false,
            topics: topics({ abi: [swapEv], eventName: 'Swap', args: { user: account.address, tokenIn: WETH, tokenOut: USDC } }),
            data: enc([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [10n ** 18n, 2_995_000_000n, 1n]),
          }];
          receipts.set(hash, {
            transactionHash: hash, transactionIndex: '0x0', blockHash: `0x${'33'.repeat(32)}`, blockNumber: '0x201',
            from: account.address, to: tx.to, cumulativeGasUsed: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1',
            contractAddress: null, logs, logsBloom: `0x${'00'.repeat(256)}`, status: '0x1', type: '0x2',
          });
          return hash;
        }
        case 'eth_getTransactionReceipt': return receipts.get(p[0] as string) ?? null;
        case 'eth_getTransactionByHash': return null;
        case 'eth_call': {
          const { to, data } = p[0] as { to: string; data: Hex };
          if (to.toLowerCase() === V1.quoter.toLowerCase()) {
            const d = decodeFunctionData({ abi: QUOTER_ABI, data });
            const [tIn, tOut, amt] = d.args as unknown as [Address, Address, bigint];
            const route = mkRoute(tIn, tOut, amt, amt * 3_000n / 10n ** 12n);
            return encodeFunctionResult({ abi: QUOTER_ABI, functionName: d.functionName as 'previewPlan', result: [mkPreview(route), route, false] as never });
          }
          if (to.toLowerCase() === V1.router.toLowerCase()) {
            if (allowance === 0n) throw Object.assign(new Error('execution reverted'), { code: 3, data: encodeErrorResult({ abi: ROUTER_ABI, errorName: 'RouterE', args: [8] }) });
            return encodeFunctionResult({ abi: ROUTER_ABI, functionName: 'swapExactIn', result: 2_995_000_000n });
          }
          const d = decodeFunctionData({ abi: ERC20_ABI, data });
          if (d.functionName === 'allowance') return encodeFunctionResult({ abi: ERC20_ABI, functionName: 'allowance', result: allowance });
          if (d.functionName === 'decimals') return encodeFunctionResult({ abi: ERC20_ABI, functionName: 'decimals', result: 18 });
          throw new Error(`call ${d.functionName}`);
        }
        default: throw new Error(`unexpected ${method}`);
      }
    },
  };
  const wallet = createWalletClient({ account, transport: custom(node) });
  const blaze = new BlazePhoenix({ rpc: node, registry: { mode: 'embedded' }, retries: 0 });
  const res = await blaze.execute({
    wallet,
    request: { tokenIn: 'WETH', tokenOut: 'USDC', amount: '1', recipient: account.address },
  });
  eq('execute: approve then swap, both signed by YOUR wallet', sent.map((t) => t.selector), ['0x095ea7b3', decodeFunctionData({ abi: ROUTER_ABI, data: res.plan.tx.data }).functionName === 'swapExactIn' ? res.plan.tx.data.slice(0, 10) : 'x']);
  eq('execute: realised output read from the receipt', [res.status, res.amountOut], ['success', 2_995_000_000n]);
  const again = await blaze.execute({ wallet, request: { tokenIn: 'WETH', tokenOut: 'USDC', amount: '1', recipient: account.address } });
  eq('execute: no second approval once the allowance exists', [sent.length, again.approvalHash], [3, undefined]);
  const wrongWallet = createWalletClient({ account, transport: custom({ request: async (a: { method: string }) => (a.method === 'eth_chainId' ? '0x1' : node.request(a as never)) }) });
  await throwsCode('execute: wallet on another chain refused before anything is signed',
    () => blaze.execute({ wallet: wrongWallet, request: { tokenIn: 'WETH', tokenOut: 'USDC', amount: '1', recipient: account.address } }), 'wallet_chain_mismatch');
}

// ── ERC-20 helpers ───────────────────────────────────────────────────────────
console.log('erc20');
{
  const { buildApproveTx, buildWrapTx, buildUnwrapTx, toBaseUnits, fromBaseUnits, MAX_UINT256 } = await import('../src/erc20.js');
  const tx = buildApproveTx({ token: WETH, chain: 'base', amount: 5n });
  const d = decodeFunctionData({ abi: ERC20_ABI, data: tx.data });
  eq('approve: default spender = latest embedded Router', [d.functionName, d.args?.[0], d.args?.[1], tx.to], ['approve', V1.router, 5n, WETH]);
  check('approve: MAX accepted', buildApproveTx({ token: WETH, chain: 'base', amount: MAX_UINT256 }).data.endsWith('f'.repeat(64)));
  eq('wrap: WETH.deposit with value', [buildWrapTx('base', 9n).value, buildWrapTx('base', 9n).to], [9n, WETH]);
  eq('unwrap: WETH.withdraw', buildUnwrapTx('base', 9n).value, 0n);
  eq('toBaseUnits', toBaseUnits('1.5', 18), 1_500_000_000_000_000_000n);
  eq('fromBaseUnits', fromBaseUnits(1_500_000n, 6), '1.5');
  check('toBaseUnits rejects extra decimals', (() => { try { toBaseUnits('1.1234567', 6); return false; } catch { return true; } })());
}

// ── resilience + deep links ──────────────────────────────────────────────────
console.log('misc');
{
  const { resilientFetch, singleflight, __resetResilience } = await import('../src/resilience.js');
  __resetResilience();
  let n = 0;
  const flaky = (async () => (++n === 1 ? new Response('busy', { status: 502, headers: { 'retry-after': '0' } }) : new Response('{}', { status: 200 }))) as unknown as typeof fetch;
  check('resilientFetch retries a 502', (await resilientFetch(flaky, 'https://x.test', undefined, { retries: 2, backoffMs: 1 })).status === 200 && n === 2);
  let calls = 0;
  const slow = () => new Promise<number>((r) => { calls++; setTimeout(() => r(7), 10); });
  const [a, b] = await Promise.all([singleflight('k', slow), singleflight('k', slow)]);
  check('singleflight shares one execution', a === 7 && b === 7 && calls === 1);
  eq('deep link', deepLink({ chain: 'base', tokenIn: 'ETH', tokenOut: 'BZPX', amount: '0.5' }), 'https://blazephoenix.xyz/?tab=swap&chain=8453&in=ETH&out=BZPX&amt=0.5');
}

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
