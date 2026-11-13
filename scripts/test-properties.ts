// Property and boundary tests — offline, seeded (every run draws the same cases).
// Run: npm test (after scripts/test.ts) or: npx tsx scripts/test-properties.ts
//
// Ranges × vectors × dimensions: the codec over random full-width routes, the
// verifier against every single-field tamper, text cleaning over Unicode classes,
// URL redaction over forms × delimiters, the client against a node that lies or
// fails (429, 5xx, timeouts, garbage), decimals read from the chain, cache keys.
// Every check here has its mutant in scripts/mutants.mjs (PER-n): the
// oracle is the input, a literal, or viem alone — never the function under test.
import { createWalletClient, custom, decodeFunctionData, toFunctionSelector } from 'viem';
import { ROUTER_ABI } from '../src/abis.js';
import {
  decodeSwapExactIn, encodeSwapBestExactIn, encodeSwapExactIn, encodeSwapExactInNative, minOutFor, tightenMinOut, verifySwapExactIn,
} from '../src/calldata.js';
import { routeIsConsistent } from '../src/checks.js';
import { BlazePhoenix } from '../src/client.js';
import { fromBaseUnits, toBaseUnits } from '../src/erc20.js';
import { BlazeError, isTransportError, untrustedText } from '../src/errors.js';
import { Registry } from '../src/registry.js';
import { __resetResilience, memGet, memPut, singleflight } from '../src/resilience.js';
import { isAllowedRpcUrl, redact, scrubUrls } from '../src/rpc.js';
import type { Address, Hex, Route, SwapPlan } from '../src/types.js';
import {
  ME, USDC, V1, V2, WETH, allStrings, big, check, codeOf, done, encodeRouter, forAll, mkRoute, mockNode, randomRoute, rng, stubFetch,
  type Fault, type NodeOpts,
} from './prop-kit.js';

/** Key-order independent, bigint-safe. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n`
  : x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const max = (a: bigint, b: bigint) => (a > b ? a : b);

// ── codec ───────────────────────────────────────────────────────────────────
console.log('codec · round trip');
{
  const r = rng(0xa7011101);
  // The 1.x signature as text: the selector must come from it, not from the SDK.
  const LEG = '(address,address,uint8,uint24,int24,bool,bool,uint256,uint256,bytes32)';
  const ROUTE = `((address,address,uint256,uint256,${LEG}[])[],uint256,uint256,uint256,uint256,uint256,uint256,bool,bool)`;
  const SEL = toFunctionSelector(`swapExactIn(${ROUTE},uint256,uint256,address,uint256)`);
  const draw = () => {
    const tIn = r.addr(), tOut = r.addr();
    return { route: randomRoute(r, tIn, tOut), amountIn: r.uint(256), userMinOut: r.uint(256), recipient: r.addr(), deadline: r.uint(256) };
  };
  await forAll('codec: decode(encode(x)) = x for every field (300 random routes)', 300, () => {
    const w = draw();
    const got = decodeSwapExactIn(encodeSwapExactIn(w.route, w.amountIn, w.userMinOut, w.recipient, w.deadline));
    return canon(got) === canon(w) ? undefined : `decoded ${canon(got).slice(0, 160)}`;
  });
  await forAll('codec: the bytes are swapExactIn(route, amountIn, userMinOut, recipient, deadline) for viem alone', 100, () => {
    const w = draw();
    const data = encodeSwapExactIn(w.route, w.amountIn, w.userMinOut, w.recipient, w.deadline);
    if (data.slice(0, 10) !== SEL) return `selector ${data.slice(0, 10)}`;
    const a = decodeFunctionData({ abi: ROUTER_ABI, data }).args as readonly unknown[];
    return canon(a) === canon([w.route, w.amountIn, w.userMinOut, w.recipient, w.deadline]) ? undefined : 'argument order or value differs';
  });
  await forAll('codec: the native and best encodings carry their own arguments', 100, () => {
    const w = draw();
    const tIn = w.route.hops[0]!.tokenIn, tOut = w.route.hops[w.route.hops.length - 1]!.tokenOut;
    const n = decodeFunctionData({ abi: ROUTER_ABI, data: encodeSwapExactInNative(w.route, w.userMinOut, w.recipient, w.deadline) });
    const b = decodeFunctionData({ abi: ROUTER_ABI, data: encodeSwapBestExactIn(tIn, tOut, w.amountIn, w.userMinOut, w.recipient, w.deadline) });
    if (n.functionName !== 'swapExactInNative' || canon(n.args) !== canon([w.route, w.userMinOut, w.recipient, w.deadline])) return 'native differs';
    if (b.functionName !== 'swapBestExactIn' || canon(b.args) !== canon([tIn, tOut, w.amountIn, w.userMinOut, w.recipient, w.deadline])) return 'best differs';
    return undefined;
  });
  await forAll('codec: decodeSwapExactIn refuses the native and best selectors', 50, async () => {
    const w = draw();
    const others = [
      encodeSwapExactInNative(w.route, w.userMinOut, w.recipient, w.deadline),
      encodeSwapBestExactIn(r.addr(), r.addr(), w.amountIn, w.userMinOut, w.recipient, w.deadline),
    ];
    for (const d of others) { const c = await codeOf(() => decodeSwapExactIn(d)); if (c !== 'calldata_mismatch') return `got ${c}`; }
    return undefined;
  });
}

console.log('codec · verifySwapExactIn against single-field tampers');
{
  const r = rng(0xa7011102);
  const honest = () => {
    const tokenIn = r.addr(), tokenOut = r.addr();
    const route = randomRoute(r, tokenIn, tokenOut);
    const need = 2n + r.bits(1 + r.int(200));
    const w = { route, amountIn: r.uint(256), userMinOut: need + r.bits(r.int(64)), recipient: r.addr(), deadline: r.uint(256) };
    return { w, want: { tokenIn, tokenOut, amountIn: w.amountIn, recipient: w.recipient, deadline: w.deadline, minOutAtLeast: need, route } };
  };
  const enc = (w: ReturnType<typeof honest>['w']) => encodeSwapExactIn(w.route, w.amountIn, w.userMinOut, w.recipient, w.deadline);
  /** Refused with calldata_mismatch, and the only mismatch reported is the tampered field. */
  const refusedFor = (word: RegExp, data: Hex, want: Parameters<typeof verifySwapExactIn>[1]): string | undefined => {
    try { verifySwapExactIn(data, want); return 'accepted'; } catch (e) {
      if (!(e instanceof BlazeError) || e.code !== 'calldata_mismatch') return `threw ${(e as Error).name}`;
      const m = (e.details?.mismatches ?? []) as string[];
      return m.length === 1 && word.test(m[0]!) ? undefined : `mismatches ${JSON.stringify(m)}`;
    }
  };
  await forAll('verify: an honest call passes and decodes to itself (200 cases)', 200, () => {
    const { w, want } = honest();
    return canon(verifySwapExactIn(enc(w), want)) === canon(w) ? undefined : 'decoded differs';
  });
  await forAll('verify: amountIn off by one bit is refused', 100, () => {
    const { w, want } = honest(); return refusedFor(/^amountIn/, enc({ ...w, amountIn: w.amountIn ^ 1n }), want);
  });
  await forAll('verify: another recipient is refused', 100, () => {
    const { w, want } = honest(); return refusedFor(/^recipient/, enc({ ...w, recipient: r.addr() }), want);
  });
  await forAll('verify: deadline off by one bit is refused', 100, () => {
    const { w, want } = honest(); return refusedFor(/^deadline/, enc({ ...w, deadline: w.deadline ^ 1n }), want);
  });
  await forAll('verify: a minimum one unit under the required one is refused', 100, () => {
    const { w, want } = honest(); return refusedFor(/required/, enc({ ...w, userMinOut: want.minOutAtLeast - 1n }), want);
  });
  await forAll('verify: a zero minimum is refused even when zero is all that is required', 100, () => {
    const { w, want } = honest(); return refusedFor(/zero/, enc({ ...w, userMinOut: 0n }), { ...want, minOutAtLeast: 0n });
  });
  await forAll('verify: a route for another pair is refused', 100, (i) => {
    const { w, want } = honest();
    const { route: _unpinned, ...loose } = want;
    return refusedFor(/connect/, enc(w), i % 2 ? { ...loose, tokenIn: r.addr() } : { ...loose, tokenOut: r.addr() });
  });
  await forAll('verify: any single route scalar that differs from the previewed route is refused (400 cases)', 400, () => {
    const { w, want } = honest();
    const pinned = structuredClone(w.route) as Route;
    const hop = r.pick(pinned.hops), leg = r.pick(hop.legs);
    const flips: (() => void)[] = [
      () => { pinned.totalOut ^= 1n; }, () => { pinned.singleOut ^= 1n; }, () => { pinned.singleOutFloor ^= 1n; },
      () => { pinned.expectedImpactBps ^= 1n; }, () => { pinned.confidenceWad ^= 1n; }, () => { pinned.estGas ^= 1n; },
      () => { pinned.hasSurplus = !pinned.hasSurplus; }, () => { pinned.isV4Bundle = !pinned.isV4Bundle; },
      () => { hop.amountIn ^= 1n; }, () => { hop.expectedOut ^= 1n; },
      () => { leg.pool = r.addr(); }, () => { leg.hooks = r.addr(); }, () => { leg.kind ^= 1; }, () => { leg.fee ^= 1; },
      () => { leg.tickSpacing ^= 1; }, () => { leg.zeroForOne = !leg.zeroForOne; }, () => { leg.stable = !leg.stable; },
      () => { leg.amountIn ^= 1n; }, () => { leg.expectedOut ^= 1n; },
      () => { leg.auxId = `${leg.auxId.slice(0, -1)}${leg.auxId.endsWith('0') ? '1' : '0'}` as Hex; },
    ];
    r.pick(flips)();
    return refusedFor(/previewed route/, enc(w), { ...want, route: pinned });
  });

  // routeIsConsistent, one broken link at a time (hand-built: the expected answer is in the vector).
  const A = r.addr(), B = r.addr(), C = r.addr(), X = r.addr();
  const two = (): Route => {
    const rt = mkRoute(A, C, 5n, 7n);
    rt.hops = [{ ...mkRoute(A, B, 5n, 6n).hops[0]! }, { ...mkRoute(B, C, 6n, 7n).hops[0]! }];
    return rt;
  };
  const broken = (f: (rt: Route) => void) => { const rt = two(); f(rt); return routeIsConsistent(rt, A, C); };
  check('route: a connected two-hop route is consistent, in any address case',
    routeIsConsistent(two(), A, C) && routeIsConsistent(two(), A.toLowerCase() as Address, C.toLowerCase() as Address));
  check('route: no hops is inconsistent', (() => { try { return broken((rt) => { rt.hops = []; }) === false; } catch { return false; } })());
  check('route: a first hop that does not start at tokenIn is inconsistent', broken((rt) => { rt.hops[0]!.tokenIn = X; }) === false);
  check('route: a last hop that does not end at tokenOut is inconsistent', broken((rt) => { rt.hops[1]!.tokenOut = X; }) === false);
  check('route: hops that do not chain are inconsistent', broken((rt) => { rt.hops[0]!.tokenOut = X; }) === false && broken((rt) => { rt.hops[1]!.tokenIn = X; }) === false);
  check('route: a hop without legs is inconsistent', broken((rt) => { rt.hops[0]!.legs = []; }) === false && broken((rt) => { rt.hops[1]!.legs = []; }) === false);

  await forAll('tighten: the minimum becomes max(old, new) and no other field moves (300 cases)', 300, () => {
    const { w } = honest();
    const m = r.pick([0n, w.userMinOut - 1n, w.userMinOut, w.userMinOut + 1n, r.uint(256)]);
    const got = decodeSwapExactIn(tightenMinOut(enc(w), m));
    return canon(got) === canon({ ...w, userMinOut: max(w.userMinOut, m) }) ? undefined : `min ${got.userMinOut} for old ${w.userMinOut}, new ${m}`;
  });
}

console.log('codec · minOutFor');
{
  const r = rng(0xa7011103);
  await forAll('minOutFor: equals max(ceil(net·(10000−s)/10000), floor) (3000 cases)', 3000, () => {
    const net = r.uint(256);
    const s = r.pick([0, 1, 49, 50, 51, 100, 4_999, 5_000, r.int(5_001)]);
    const floor = r.pick([0n, 1n, net, net + 1n, net > 0n ? net - 1n : 0n, r.uint(256)]);
    const bySlip = (net * BigInt(10_000 - s) + 9_999n) / 10_000n;
    const got = minOutFor(net, s, floor);
    return got === max(bySlip, floor) ? undefined : `net ${net} s ${s} floor ${floor} → ${got}`;
  });
  const codes = async (xs: unknown[]) => Promise.all(xs.map((s) => codeOf(() => minOutFor(10n ** 18n, s as number, 0n))));
  check('minOutFor: slippage above 5000 is refused, 5000 is accepted',
    big(await codes([5_000, 5_001, 10_000, 2 ** 31])) === big(['none', 'bad_request', 'bad_request', 'bad_request']));
  check('minOutFor: negative slippage is refused, 0 is accepted',
    big(await codes([0, -1, -5_000])) === big(['none', 'bad_request', 'bad_request']));
  check('minOutFor: a slippage that is not an integer is refused',
    big(await codes([0.5, 49.999, NaN, Infinity, -Infinity, '50', null, undefined])) === big(Array(8).fill('bad_request')));
}

// ── units ───────────────────────────────────────────────────────────────────
console.log('units');
{
  const r = rng(0xa7011104);
  const text = (v: bigint, d: number) => {   // independent: string slicing, no division
    const s = v.toString().padStart(d + 1, '0');
    const frac = s.slice(s.length - d).replace(/0+$/, '');
    return frac ? `${s.slice(0, s.length - d)}.${frac}` : s.slice(0, s.length - d);
  };
  await forAll('units: fromBaseUnits is the decimal text and toBaseUnits reads it back, decimals 0..77 (1560 cases)', 1560, (i) => {
    const d = i % 78, v = r.uint(256);
    const s = fromBaseUnits(v, d);
    if (s !== text(v, d)) return `fromBaseUnits(${v}, ${d}) = ${s}`;
    return toBaseUnits(s, d) === v ? undefined : `toBaseUnits("${s}", ${d}) ≠ ${v}`;
  });
  const thrown = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
  const malformed = ['', ' ', '.', '1.', '.5', '-1', '+1', '1e3', '0x10', '1,5', '1 000', '1.2.3', 'NaN', '\u0661\u0662', '\uff11', '1\u200b', '1\n2'];
  check('units: a malformed amount is refused', malformed.every((a) => thrown(() => toBaseUnits(a, 18))),
    `accepted: ${JSON.stringify(malformed.filter((a) => !thrown(() => toBaseUnits(a, 18))))}`);
  check('units: more fractional digits than the token carries is refused, exactly that many is accepted',
    [0, 1, 6, 18, 77].every((d) => thrown(() => toBaseUnits(`1.${'0'.repeat(d)}1`, d)) && toBaseUnits(`1.${'0'.repeat(d)}`.replace(/\.$/, ''), d) === 10n ** BigInt(d)));
  check('units: decimals outside 0..77 are refused by toBaseUnits',
    [-1, 78, 255, 1.5, NaN].every((d) => thrown(() => toBaseUnits('1', d))) && toBaseUnits('1', 77) === 10n ** 77n && toBaseUnits('1', 0) === 1n);
}

// ── text from outside ───────────────────────────────────────────────────────
console.log('text');
{
  const r = rng(0xa7011105);
  const cp = (...xs: number[]) => xs.map((x) => String.fromCodePoint(x));
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCharCode(a + i));
  const CLASSES: string[][] = [
    range(0x20, 0x7e),                                           // printable ASCII, '~' included
    range(0x00, 0x1f), ['\x7f'], range(0x80, 0x9f),              // C0, DEL, C1
    cp(0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c),   // bidi
    cp(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad),          // zero width, soft hyphen
    cp(0x2028, 0x2029, 0x0085, 0x00a0, 0x2000, 0x200a, 0x3000),  // separators and spaces
    cp(0x0430, 0x0435, 0x043e, 0x0440, 0x0441, 0x03bf, 0xff21, 0x0131),   // homoglyphs
    cp(0x0300, 0x0336, 0x20e3, 0xe0001, 0xe0041, 0x1f600),       // combining, tags, astral
    ['\ud800', '\udfff'],                                        // lone surrogates
  ];
  await forAll('text: untrustedText is printable ASCII, one line, capped, and keeps the ASCII it was given (4000 cases)', 4000, (i) => {
    let s = '';
    for (let n = r.int(60); n > 0; n--) s += r.pick(r.int(3) === 0 ? r.pick(CLASSES) : CLASSES[0]!);
    const cap = [undefined, 0, 1, 7, 300][i % 5];
    const out = cap === undefined ? untrustedText(s) : untrustedText(s, cap);
    for (let k = 0; k < out.length; k++) {
      const c = out.charCodeAt(k);
      if (c < 0x20 || c > 0x7e) return `U+${c.toString(16)} at ${k}`;
      if (c === 0x20 && (k === 0 || out.charCodeAt(k - 1) === 0x20)) return `space run or leading space at ${k}`;
    }
    if (out.length > (cap ?? 120)) return `length ${out.length} over ${cap ?? 120}`;
    let ascii = '';
    for (const ch of s) { const c = ch.charCodeAt(0); if (ch.length === 1 && c > 0x20 && c <= 0x7e) ascii += ch; }
    return ascii.startsWith(out.split(' ').join('')) ? undefined : `dropped or reordered ASCII: ${JSON.stringify(out)}`;
  });
}

// ── RPC URLs ────────────────────────────────────────────────────────────────
console.log('rpc · URLs');
{
  const KEY = 'SECRETtestKEY';
  const schemes = ['https', 'http', 'wss', 'ws', 'HTTPS', 'Wss'];
  const hosts = ['node.invalid', 'node.invalid:8545', '127.0.0.1:8545', '[::1]:8545'];
  const tails = [`/v2/${KEY}`, `/?apikey=${KEY}`, `/rpc?key=${KEY}&x=1`, `/#${KEY}`, `/${KEY}/`, `/a/b/${KEY}?q=${KEY}`];
  const before = ['', ' ', '"', "'", '(', '<', '=', ': ', '\n', '\t', '[', '`', ',', '>', '/', '{"url":"'];
  const after = ['', ' ', '"', "'", ')', '>', '\n', ',', '.', ';', ' and more', '"}'];
  const urls: string[] = [];
  for (const s of schemes) for (const h of hosts) for (const t of tails) urls.push(`${s}://${h}${t}`, `${s}://user:${KEY}@${h}/`);
  const leaks: string[] = [];
  for (const u of urls) for (const b of before) for (const a of after) {
    const pre = b === '' ? '' : `failed${b}`;   // '' → the URL opens the message
    const out = scrubUrls(`${pre}${u}${a}`);
    if (out.includes(KEY) || !out.startsWith(pre)) leaks.push(`${pre}${u}${a} → ${out}`);
  }
  check(`rpc: scrubUrls removes the key for every URL form × delimiter (${urls.length * before.length * after.length} cases)`, leaks.length === 0, `${leaks.length} leaks, first: ${JSON.stringify(leaks[0])}`);
  const raw = [...urls, `https://[bad/v2/${KEY}`, `https://node.invalid:99999/${KEY}`, `not a url ${KEY}`, `https://${KEY}@`, ''];
  check('rpc: redact never returns the key, well-formed URL or not', raw.every((u) => !redact(u).includes(KEY)),
    `leaked: ${JSON.stringify(raw.filter((u) => redact(u).includes(KEY))[0])}`);

  // Hand-labelled: plain http/ws only where the host is this machine.
  const table: [string, boolean][] = [
    ['https://node.invalid/v2/k', true], ['wss://node.invalid', true], ['http://localhost:8545', true], ['http://127.0.0.1:8545', true],
    ['http://[::1]:8545', true], ['ws://localhost:8546', true], [' http://localhost:8545 ', true], ['http://127.1:8545', true],
    ['http://node.invalid', false], ['ws://node.invalid', false], ['http://localhost.evil.invalid', false], ['http://127.0.0.1.evil.invalid', false],
    ['http://evil.invalid/#@localhost', false], ['http://localhost@evil.invalid', false], ['http://evil.invalid?localhost', false],
    ['http://evil.invalid/localhost', false], ['http://localhost:8545@evil.invalid', false], ['http://[::1].evil.invalid', false],
    ['http://10.0.0.1:8545', false], ['http://192.168.1.1', false], ['ftp://localhost', false], ['file:///etc/passwd', false],
    ['javascript:alert(1)', false], ['data:text/plain,x', false], ['', false], ['localhost:8545', false], ['//localhost', false], ['http://', false],
  ];
  const wrong = table.filter(([u, ok]) => isAllowedRpcUrl(u) !== ok).map(([u]) => u);
  check('rpc: plain http/ws is allowed only for this machine; other schemes never', wrong.length === 0, `wrong: ${JSON.stringify(wrong)}`);
}

// ── the client against "your node" ──────────────────────────────────────────
const REQ = { chain: 'base', tokenIn: 'WETH', tokenOut: 'USDC' } as const;
const out3 = (a: bigint) => a * 3n + 7n;
const mk1 = (o: NodeOpts = {}, cacheTtlMs = 0) => {
  const n = mockNode({ outFor: out3, ...o });
  return { n, b: new BlazePhoenix({ rpc: n.provider, registry: { mode: 'embedded' }, cacheTtlMs }) };
};
const mk2 = (o: NodeOpts = {}) => {
  const n = mockNode({ outFor: out3, quoter: V2.base.quoter, router: V2.base.router, version: '2.0.0', ...o });
  return { n, b: new BlazePhoenix({ rpc: { base: n.provider }, contracts: V2, registry: { mode: 'embedded' }, cacheTtlMs: 0 }) };
};

console.log('client · the signed bytes against the preview');
for (const [label, mk, router] of [['1.x', mk1, V1.router], ['2.x', mk2, V2.base.router]] as const) {
  const cases: { s: number; a: bigint; m: 'none' | 'floor' | 'above' | 'below' }[] = [];
  for (const s of [0, 1, 50, 4_999, 5_000]) for (const a of [1n, 10n ** 6n, 10n ** 18n, 2n ** 128n - 1n]) for (const m of ['none', 'floor', 'above', 'below'] as const) cases.push({ s, a, m });
  await forAll(`plan ${label}: minOut = max(net less slippage, on-chain floor), a lower userMinOut is refused, and the bytes carry exactly that (${cases.length} cases)`, cases.length, async (i) => {
    const { s, a, m } = cases[i]!;
    const gross = out3(a), net = gross - (gross * 28n + 9_999n) / 10_000n, iron = (gross * 90n) / 100n;   // the mock's preview, recomputed here
    const floor = max((net * BigInt(10_000 - s) + 9_999n) / 10_000n, iron);
    const userMinOut = m === 'none' ? undefined : m === 'floor' ? floor : m === 'above' ? floor + 1n : floor - 1n;
    const req = { ...REQ, amountIn: a, recipient: ME, slippageBps: s, ...(userMinOut !== undefined ? { userMinOut } : {}) };
    const { b } = mk();
    if (m === 'below') {
      if (userMinOut === 0n) return undefined;   // 0 means "none"
      const c = await codeOf(() => b.buildSwap(req));
      return c === 'min_implausible' ? undefined : `s ${s} a ${a}: userMinOut ${userMinOut} under floor ${floor} gave ${c}`;
    }
    const plan = await b.buildSwap(req);
    const want = m === 'above' ? floor + 1n : floor;
    const d = decodeFunctionData({ abi: ROUTER_ABI, data: plan.tx.data });
    const [, amountIn, min, recipient, deadline] = d.args as unknown as [Route, bigint, bigint, Address, bigint];
    if (plan.minOut !== want) return `s ${s} a ${a} ${m}: plan.minOut ${plan.minOut}, want ${want}`;
    if (d.functionName !== 'swapExactIn' || min !== plan.minOut || amountIn !== a || recipient !== ME || deadline !== plan.deadline) return `bytes differ: ${big(d.args).slice(-160)}`;
    return plan.tx.to.toLowerCase() === router.toLowerCase() ? undefined : `tx.to ${plan.tx.to}`;
  });
}

console.log('client · a Quoter that lies about the calldata (2.x)');
{
  const r = rng(0xa7011106);
  type Args = [Route, bigint, bigint, Address, bigint];
  const re = (f: (a: Args) => void) => (honest: Hex) => {
    const a = structuredClone(decodeFunctionData({ abi: ROUTER_ABI, data: honest }).args) as unknown as Args;
    f(a);
    return encodeRouter('swapExactIn', a);
  };
  const lies: [string, NonNullable<NodeOpts['encode']>][] = [
    ['zero minimum', re((a) => { a[2] = 0n; })],
    ['minimum one under the on-chain floor', re((a) => { a[2] -= 1n; })],
    ['another recipient', re((a) => { a[3] = r.addr(); })],
    ['amount off by one', re((a) => { a[1] += 1n; })],
    ['deadline one second later', re((a) => { a[4] += 1n; })],
    ['another pool in the route', re((a) => { a[0].hops[0]!.legs[0]!.pool = r.addr(); })],
    ['a route for another tokenOut', re((a) => { a[0].hops[0]!.tokenOut = r.addr(); })],
    ['swapBestExactIn bytes', () => encodeRouter('swapBestExactIn', [WETH, USDC, 10n ** 18n, 1n, ME, 2_000_000_000n])],
    ['swapExactInNative bytes', (h) => { const a = decodeFunctionData({ abi: ROUTER_ABI, data: h }).args as unknown as Args; return encodeRouter('swapExactInNative', [a[0], a[2], a[3], a[4]]); }],
  ];
  const got: string[] = [];
  for (const [name, encode] of lies) {
    const c = await codeOf(() => mk2({ encode }).b.buildSwap({ ...REQ, amountIn: 10n ** 18n, recipient: ME }));
    if (c !== 'calldata_mismatch') got.push(`${name}: ${c}`);
  }
  check(`lying Quoter: every tampered encoding is refused with calldata_mismatch (${lies.length} lies)`, got.length === 0, got.join('; '));
  // caught, so that a mutant that breaks the honest path fails this check by name instead of ending the run
  const honestBy = await mk2().b.buildSwap({ ...REQ, amountIn: 10n ** 18n, recipient: ME }).then((p) => p.encodedBy, (e) => `refused: ${(e as BlazeError).code ?? (e as Error).name}`);
  check('lying Quoter: the honest encoding is accepted (the refusals above are not vacuous)', honestBy === 'quoter', honestBy);
}

console.log('client · decimals read from the chain');
{
  const TKN = '0x00000000000000000000000000000000000000f1';
  const quoteAt = (d: number, amount: string) => mk1({ decimals: d }).b.quote({ chain: 'base', tokenIn: TKN, tokenOut: 'USDC', amount });
  const scaled: string[] = [];
  for (const d of [0, 1, 6, 18, 38]) {
    const q = await quoteAt(d, '1');
    if (q.amountIn !== 10n ** BigInt(d)) scaled.push(`decimals ${d}: amountIn ${q.amountIn}`);
  }
  check('decimals: "1" is 10^d base units for the d the chain answers (0, 1, 6, 18, 38)', scaled.length === 0, scaled.join('; '));
  const refused = await Promise.all([[39, '1'], [77, '1'], [78, '1'], [255, '1'], [0, '1.5'], [6, '0.0000001']].map(([d, a]) => codeOf(() => quoteAt(d as number, a as string))));
  check('decimals: an amount the chain decimals cannot carry is bad_request (uint128, decimals > 77, too many digits)',
    refused.every((c) => c === 'bad_request'), big(refused));
  const both = (amountIn: bigint) => codeOf(() => mk1({ decimals: 6 }).b.quote({ chain: 'base', tokenIn: TKN, tokenOut: 'USDC', amount: '1', amountIn }));
  check('decimals: amount and amountIn in one request must agree on the chain decimals',
    big([await both(1_000_000n), await both(999_999n), await both(10n ** 18n)]) === big(['none', 'bad_request', 'bad_request']));
}

console.log('client · hostile amounts');
{
  const q = (x: Record<string, unknown>) => codeOf(() => mk1().b.quote({ ...REQ, amountIn: 10n ** 18n, ...x } as never));
  const amounts = await Promise.all([0n, '0', 2n ** 128n, '1.0', '0x1', '1e3', ' ', '-1'].map((amountIn) => q({ amountIn })));
  check('amounts: amountIn that is zero, above uint128 or not a base-unit integer is bad_request', amounts.every((c) => c === 'bad_request'), big(amounts));
  const mins = await Promise.all(['-1', '1.5', '0x10', '1e3', '1 2', '\u0661'].map((userMinOut) => q({ userMinOut })));
  check('amounts: a userMinOut string that is not a base-unit integer is bad_request', mins.every((c) => c === 'bad_request'), big(mins));
}

console.log('client · cache keys');
{
  const TKN = '0x00000000000000000000000000000000000000f1', TKN2 = '0x00000000000000000000000000000000000000f2';
  __resetResilience();
  const { n, b } = mk1({}, 60_000);
  const reads = () => n.count('previewPlan') + n.count('previewPlanWithMinOut');
  const base = { chain: 'base', tokenIn: TKN, tokenOut: 'USDC', amountIn: 10n ** 18n };
  const q1 = await b.quote(base);
  const q2 = await b.quote(base);
  check('cache: the identical request is answered from the cache (one read)', reads() === 1 && canon(q1) === canon(q2), `reads ${reads()}`);
  /** A request that differs in one key component must be read from the node and answered for itself. */
  const fresh = async (x: Record<string, unknown>, own: (q: Awaited<ReturnType<typeof b.quote>>) => boolean) => {
    const before = reads();
    const q = await b.quote({ ...base, ...x } as never);
    return reads() === before + 1 && own(q);
  };
  check('cache: another amountIn is not served from the cache', await fresh({ amountIn: 10n ** 18n + 1n }, (q) => q.amountIn === 10n ** 18n + 1n));
  check('cache: another userMinOut is not served from the cache', await fresh({ userMinOut: 5n }, (q) => q.preview.userMinOut === 5n));
  check('cache: another tokenIn is not served from the cache', await fresh({ tokenIn: TKN2 }, (q) => q.tokenIn.toLowerCase() === TKN2));
  check('cache: another tokenOut is not served from the cache', await fresh({ tokenOut: TKN2 }, (q) => q.tokenOut.toLowerCase() === TKN2));
  const pinned = reads();
  await b.quote({ ...base, blockNumber: 0x100n });
  await b.quote({ ...base, blockNumber: 0x100n });
  check('cache: a quote pinned to a block is never cached', reads() === pinned + 2, `reads ${reads() - pinned}`);

  __resetResilience();
  memPut('k', 'v', 1_000);
  check('cache: an entry lives strictly less than its ttl', memGet('k', 500, 1_499) === 'v' && memGet('k', 500, 1_500) === undefined && memGet('k', 0, 1_000) === undefined);
  for (let i = 0; i < 600; i++) memPut(`b${i}`, i, 2_000);
  check('cache: bounded — the oldest entries are evicted, the newest stay',
    memGet('k', 1e9, 2_000) === undefined && memGet('b0', 1e9, 2_000) === undefined && memGet('b599', 1e9, 2_000) === 599 && memGet('b100', 1e9, 2_000) === 100);
  __resetResilience();
}

// ── one client, one cache: no answer crosses from one instance to another ──
// Red at d326e1e: the quote cache and the in-flight map were process-wide, keyed by the
// request alone, so a second client on another node was answered by the first one's node.
console.log('client · one instance, one cache');
{
  const net = (g: bigint) => g - (g * 28n + 9_999n) / 10_000n;   // mkPreview's fee as a literal: the oracle is each node, not the client
  const outOf = (i: number) => (a: bigint) => a / BigInt(i + 2) + BigInt(i) + 1n;
  const reads = (n: ReturnType<typeof mockNode>) => n.count('previewPlan') + n.count('previewPlanWithMinOut');
  const fleet = (k: number, ttl: number) => Array.from({ length: k }, (_, i) => {
    const n = mockNode({ outFor: outOf(i) });
    return { n, b: new BlazePhoenix({ rpc: n.provider, registry: { mode: 'embedded' }, cacheTtlMs: ttl }), want: (a: bigint) => net(outOf(i)(a)) };
  });
  const REQ = { chain: 'base', tokenIn: WETH, tokenOut: USDC } as const;
  const AMOUNTS = [10n ** 6n, 10n ** 18n, 2n ** 128n - 1n];
  const BIG = 10n ** 18n;
  type Q = Awaited<ReturnType<BlazePhoenix['quote']>>;
  const spoil = (q: Q) => { q.amountOut = 1n; q.preview.netOut = 1n; (q.route.hops as unknown[]).length = 0; };

  const seq: string[] = [];
  for (const ttl of [1_000, 60_000]) for (const amt of AMOUNTS) {
    __resetResilience();
    for (const [i, c] of fleet(3, ttl).entries()) {
      const q = await c.b.quote({ ...REQ, amountIn: amt });
      if (q.amountOut !== c.want(amt) || reads(c.n) !== 1) seq.push(`ttl ${ttl} amountIn ${amt} client ${i}: answered ${q.amountOut}, its node ${c.want(amt)}, reads ${reads(c.n)}`);
    }
  }
  check('scope: clients on different nodes one after the other are each answered by their own node (cache; ttl 1 s, 60 s × amountIn 1e6, 1e18, 2^128-1 × 3 clients)', seq.length === 0, seq.join('; '));

  const par: string[] = [];
  for (const ttl of [0, 60_000]) for (const k of [2, 5]) {
    __resetResilience();
    const f = fleet(k, ttl);
    for (const [i, c] of f.entries()) await c.b.quote({ ...REQ, amountIn: 7n + BigInt(i) });   // every node verified, nothing shared yet
    const before = f.map((c) => reads(c.n));
    const qs = await Promise.all(f.map((c) => c.b.quote({ ...REQ, amountIn: BIG })));
    qs.forEach((q, i) => {
      if (q.amountOut !== f[i].want(BIG) || reads(f[i].n) !== before[i] + 1) par.push(`ttl ${ttl} clients ${k} client ${i}: answered ${q.amountOut}, its node ${f[i].want(BIG)}, reads ${reads(f[i].n) - before[i]}`);
    });
  }
  check('scope: clients on different nodes asking at the same time are each answered by their own node (in-flight; ttl 0, 60 s × 2, 5 clients)', par.length === 0, par.join('; '));

  {
    __resetResilience();
    const [c] = fleet(1, 0);
    await c.b.quote({ ...REQ, amountIn: 7n });
    const before = reads(c.n);
    const qs = await Promise.all([1, 2, 3, 4].map(() => c.b.quote({ ...REQ, amountIn: BIG })));
    check('scope: one client asking the same request four times at once reads its node once', reads(c.n) === before + 1 && qs.every((q) => q.amountOut === c.want(BIG)), `reads ${reads(c.n) - before}`);
  }

  {
    __resetResilience();
    const [c] = fleet(1, 60_000);
    const req = { ...REQ, amountIn: BIG };
    const q1 = await c.b.quote(req);
    const want = canon(q1);
    spoil(q1);
    const q2 = await c.b.quote(req);
    const second = canon(q2) === want;
    spoil(q2);
    const q3 = await c.b.quote(req);
    check('copy: every quote answered from the cache is the caller\'s own object (mutating one never reaches the next)', reads(c.n) === 1 && second && canon(q3) === want,
      `reads ${reads(c.n)}; second intact ${second}; third intact ${canon(q3) === want}`);
    __resetResilience();
    const [d] = fleet(1, 0);
    await d.b.quote({ ...REQ, amountIn: 7n });
    const before = reads(d.n);
    const [qa, qb] = await Promise.all([d.b.quote(req), d.b.quote(req)]);
    const wantB = canon(qb);
    spoil(qa);
    check('copy: two callers sharing one read get two objects (mutating one never reaches the other)', reads(d.n) === before + 1 && qa !== qb && canon(qb) === wantB,
      `reads ${reads(d.n) - before}; same object ${qa === qb}; other intact ${canon(qb) === wantB}`);
  }

  {
    // A caller that writes the process-wide cache directly (singleflight and the cache are exported):
    // the key a client used before the fix, exactly.
    const OLD = `Q|8453|1.0.0|${V1.quoter}|${WETH}|false|${USDC}|false|${BIG}|0|`;
    __resetResilience();
    const [c] = fleet(1, 60_000);
    memPut(OLD, { amountOut: 1n });
    const q = await c.b.quote({ ...REQ, amountIn: BIG });
    check('scope: a value another caller put in the shared cache under the client\'s own key is never served', q.amountOut === c.want(BIG) && reads(c.n) === 1,
      `answered ${q.amountOut}, its node ${c.want(BIG)}, reads ${reads(c.n)}`);
    __resetResilience();
    const [d] = fleet(1, 0);
    await d.b.quote({ ...REQ, amountIn: 7n });
    const lie = singleflight(OLD, () => new Promise((r) => setTimeout(() => r({ amountOut: 1n }), 50)));
    const q2 = await d.b.quote({ ...REQ, amountIn: BIG });
    await lie;
    check('scope: a slow call another caller started in singleflight under the client\'s own key is never joined', q2.amountOut === d.want(BIG),
      `answered ${q2.amountOut}, its node ${d.want(BIG)}`);
  }

  {
    __resetResilience();
    const req = { ...REQ, amountIn: BIG };
    const [c] = fleet(1, 60_000);
    await c.b.quote(req);
    __resetResilience();
    await c.b.quote(req);
    check('scope: __resetResilience clears the cache of a live client', reads(c.n) === 2, `reads ${reads(c.n)}`);
    const [d] = fleet(1, 0);
    await d.b.quote(req);
    await d.b.quote(req);
    check('cache: cacheTtlMs 0 reads the node on every request', reads(d.n) === 2, `reads ${reads(d.n)}`);
  }
  __resetResilience();
}

console.log('registry · one download per fetch');
{
  const URL_R = 'https://registry.invalid/deployments.json';
  const fetcher = (tag: string, log: string[]) => (async () => {
    log.push(tag);
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify({ schema: 1, versions: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  __resetResilience();
  const log: string[] = [];
  await Promise.all([new Registry({ url: URL_R, fetchFn: fetcher('A', log) }).refresh(true), new Registry({ url: URL_R, fetchFn: fetcher('B', log) }).refresh(true)]);
  check('registry: two instances with their own fetch, same URL, at the same time: each asks its own fetch', [...log].sort().join() === 'A,B', log.join());
  log.length = 0;
  const f = fetcher('S', log);
  await Promise.all([new Registry({ url: URL_R, fetchFn: f }).refresh(true), new Registry({ url: URL_R, fetchFn: f }).refresh(true)]);
  check('registry: two instances sharing one fetch, same URL, at the same time: one download', log.join() === 'S', log.join());
  __resetResilience();
}

// ── a node that fails: nothing raw, and never the key ───────────────────────
console.log('client · RPC faults over HTTP');
{
  const KEY = 'SECRETtestKEY';
  const URL_ = `https://node.invalid/v2/${KEY}`;
  const faults: [string, Fault][] = [
    ['429', { kind: 'http', status: 429, body: `Too Many Requests for ${URL_}` }],
    ['500', { kind: 'http', status: 500, body: JSON.stringify({ error: `upstream ${URL_} is down` }) }],
    ['network', { kind: 'throw', message: `request to ${URL_} failed, reason: ECONNRESET` }],
    ['rpc error', { kind: 'rpc', message: `upstream ${URL_} timed out` }],
    ['garbage', { kind: 'garbage' }],
    ['timeout', { kind: 'hang' }],
  ];
  const TKN = '0x00000000000000000000000000000000000000f1';
  const req = { chain: 'base', tokenIn: TKN, tokenOut: 'USDC', amountIn: 10n ** 18n };
  const entries: [string, (b: BlazePhoenix) => Promise<unknown>, string[]][] = [
    ['quote', (b) => b.quote(req), ['eth_chainId', 'eth_call']],
    ['quoteExact', (b) => b.quoteExact(req), ['eth_chainId', 'eth_call']],
    ['quoteBatch', (b) => b.quoteBatch([req, { ...req, amountIn: 5n }]), ['eth_chainId', 'eth_call']],
    ['buildSwap', (b) => b.buildSwap({ ...req, recipient: ME }), ['eth_chainId', 'eth_call']],
    ['tokenInfo', (b) => b.tokenInfo('base', TKN), ['eth_chainId', 'eth_call']],
    ['getFills', (b) => b.getFills({ chain: 'base', fromBlock: 1n, toBlock: 0x100n }), ['eth_chainId', 'eth_getLogs']],
  ];
  for (const [name, run, phases] of entries) {
    const bad: string[] = [];
    for (const phase of phases) for (const [fname, fault] of faults) {
      const restore = stubFetch(mockNode({ outFor: out3 }).provider, (m) => (m === phase ? fault : undefined));
      try {
        const b = new BlazePhoenix({ rpc: { base: URL_ }, registry: { mode: 'embedded' }, cacheTtlMs: 0, retries: 0, timeoutMs: 60 });
        let seen: unknown, threw = false;
        try { seen = await run(b); } catch (e) { seen = e; threw = true; }
        if (threw && !(seen instanceof BlazeError)) bad.push(`${fname}@${phase}: raw ${(seen as Error)?.name}`);
        else if (!threw && !JSON.stringify(seen, (_k, x) => (typeof x === 'bigint' ? `${x}` : x)).includes('"ok":false')) bad.push(`${fname}@${phase}: answered as if the node were healthy`);
        else if (allStrings(seen).some((s) => s.includes(KEY))) bad.push(`${fname}@${phase}: carries the key`);
      } finally { restore(); }
    }
    check(`faults: ${name} fails as a BlazeError that never carries the RPC key (${faults.length} faults × ${phases.length} phases)`, bad.length === 0, bad.join('; '));
  }
  // The same endpoint, healthy: the fault checks above are not passing on a client that never works.
  const restore = stubFetch(mockNode({ outFor: out3 }).provider, () => undefined);
  try {
    const healthy = await codeOf(async () => {
      const b = new BlazePhoenix({ rpc: { base: URL_ }, registry: { mode: 'embedded' }, cacheTtlMs: 0, retries: 0, timeoutMs: 2_000 });
      if ((await b.quote(req)).amountOut !== out3(10n ** 18n) - (out3(10n ** 18n) * 28n + 9_999n) / 10_000n) throw new Error('wrong amountOut');
    });
    check('faults: the same endpoint without a fault quotes normally', healthy === 'none', healthy);
  } finally { restore(); }
}

console.log('client · a token\'s revert text in simulate');
{
  // [what the token reverts with, the visible words of it the caller must still be able to read]
  const texts: [string, string[]][] = [
    ['TOKEN: transfer \u202eblocked', ['TOKEN: transfer', 'blocked']],
    ['paused\u0007\u001b[31m', ['paused', '[31m']],
    ['caf\u00e9 \u0430dmin only', ['caf', 'dmin only']],
    ['x'.repeat(500), ['x'.repeat(40)]],
    ['a b\u200bc\ufeff', ['a b', 'c']],
    ['ok \ud800 lone', ['ok', 'lone']],
  ];
  const bad: string[] = [];
  for (const [t, words] of texts) {
    const { b } = mk1({ routerText: t, allowance: 2n ** 200n });
    const plan = await b.buildSwap({ ...REQ, amountIn: 10n ** 18n, recipient: ME, from: ME });
    const sim = await b.simulate(plan, ME);
    const reason = sim.error?.reason ?? '';
    if (sim.ok || !/^[\x20-\x7e]{1,120}$/.test(reason) || !words.every((w) => reason.includes(w))) bad.push(JSON.stringify({ t: t.slice(0, 20), ok: sim.ok, reason }));
  }
  check(`simulate: a token's revert text comes back as printable ASCII, capped, its visible words kept (${texts.length} texts)`, bad.length === 0, bad.join('; '));
}

// ── regressions: each check below was red at 77210e4, before its fix (CHANGELOG, Unreleased) ──
console.log('client · exact mode: the signed minimum against the dry-run');
for (const [label, mk, nets] of [['1.x', mk1, true], ['2.x', mk2, false]] as const) {
  const min = (a: bigint, b: bigint) => (a < b ? a : b);
  // The mock's preview and the exact arithmetic, recomputed here by hand.
  const model = (pct: bigint, s: number, a: bigint) => {
    const less = (x: bigint, bps: number) => x - (x * BigInt(bps)) / 10_000n;
    const gross = out3(a), net = gross - (gross * 28n + 9_999n) / 10_000n, iron = (gross * 90n) / 100n;
    const answered = (gross * pct) / 100n;                                   // what previewPlanExact returns
    const ex = nets ? answered - (answered * 28n + 9_999n) / 10_000n : answered;
    const ceil = less(ex, 50);                                                // exact less the fixed margin
    return { answered, iron, ceil, byPreview: max(less(net, s), iron), want: min(max(max(less(net, s), iron), less(ceil, s)), ceil) };
  };
  const grid: { pct: bigint; s: number; a: bigint }[] = [];
  for (const pct of [105n, 101n, 100n, 99n, 97n, 95n, 91n, 90n, 80n, 50n]) for (const s of [0, 1, 50, 300, 1_000, 5_000]) for (const a of [1n, 10n ** 6n, 10n ** 18n, 2n ** 128n - 1n]) grid.push({ pct, s, a });
  const build = (pct: bigint, s: number, a: bigint, userMinOut?: bigint) => {
    const { b } = mk({ exactFor: (x) => (out3(x) * pct) / 100n });
    return b.buildSwap({ ...REQ, amountIn: a, recipient: ME, slippageBps: s, exact: true, ...(userMinOut !== undefined ? { userMinOut } : {}) });
  };
  const signed = (data: Hex) => (decodeFunctionData({ abi: ROUTER_ABI, data }).args as unknown as unknown[])[2] as bigint;
  // open: the default minimum meets the dry-run; shut: it does not (by the on-chain floor alone, or by the quote net of slippage).
  const open = grid.filter(({ pct, s, a }) => { const m = model(pct, s, a); return m.byPreview <= m.ceil; });
  const shut = grid.filter(({ pct, s, a }) => { const m = model(pct, s, a); return m.byPreview > m.ceil; });
  const byIron = shut.filter(({ pct, s, a }) => { const m = model(pct, s, a); return m.iron > m.ceil; });
  const over = shut.filter(({ pct, s, a }) => { const m = model(pct, s, a); return m.iron <= m.ceil; });
  await forAll(`exact ${label}: the signed minimum is max(default minimum, exact less margin and slippage), never above the dry-run less the margin (${open.length} plans)`, open.length, async (i) => {
    const { pct, s, a } = open[i]!;
    const m = model(pct, s, a);
    const plan = await build(pct, s, a);
    const got = signed(plan.tx.data);
    if (got > m.ceil) return `pct ${pct} s ${s} a ${a}: signed ${got} above the ceiling ${m.ceil}`;
    return got === m.want && plan.minOut === m.want ? undefined : `pct ${pct} s ${s} a ${a}: signed ${got}, plan.minOut ${plan.minOut}, want ${m.want}`;
  });
  await forAll(`exact ${label}: a default minimum above the exact output less the margin is refused as min_above_exact, never capped (${shut.length} requests: ${byIron.length} by the on-chain floor, ${over.length} by the quote)`, shut.length, async (i) => {
    const { pct, s, a } = shut[i]!;
    const c = await codeOf(() => build(pct, s, a));
    return c === 'min_above_exact' ? undefined : `pct ${pct} s ${s} a ${a}: ${c}`;
  });
  await forAll(`exact ${label}: where the preview sits above the dry-run, a userMinOut at the ceiling or at the default minimum does not reopen it (${over.length} requests)`, over.length, async (i) => {
    const { pct, s, a } = over[i]!;
    const m = model(pct, s, a);
    const atCeil = await codeOf(() => build(pct, s, a, m.ceil));
    const atFloor = await codeOf(() => build(pct, s, a, m.byPreview));
    return atCeil === 'min_above_exact' && atFloor === 'min_above_exact' ? undefined : `pct ${pct} s ${s} a ${a}: at the ceiling ${atCeil}, at the default minimum ${atFloor}`;
  });
  const inside = open.filter(({ pct, s, a }) => model(pct, s, a).want > 1n);
  await forAll(`exact ${label}: inside the ceiling, a userMinOut at it is signed as given, one above it or under the minimum is refused (${inside.length} requests)`, inside.length, async (i) => {
    const { pct, s, a } = inside[i]!;
    const m = model(pct, s, a);
    const at = await build(pct, s, a, m.ceil);
    if (signed(at.tx.data) !== m.ceil) return `pct ${pct} s ${s} a ${a}: userMinOut ${m.ceil} signed as ${signed(at.tx.data)}`;
    const above = await codeOf(() => build(pct, s, a, m.ceil + 1n));
    const under = await codeOf(() => build(pct, s, a, m.want - 1n));
    return above === 'min_above_exact' && under === 'min_implausible' ? undefined : `pct ${pct} s ${s} a ${a}: above ${above}, under ${under}`;
  });
  // The grid must reach every side, or the checks below pass on empty sets: a grid that does not is a broken test, not a red check.
  if (!(open.length > 0 && byIron.length > 0 && over.length > 0)) throw new Error(`exact ${label}: the grid holds ${open.length} open, ${byIron.length} shut by the on-chain floor, ${over.length} shut by the quote`);
  // buildSwap × verifyPlan on the same RPC: whatever exact mode answers, a plan or a refusal, never a
  // plan that the quote's floor (measured again by verifyPlan) refuses as plan_mismatch.
  await forAll(`exact ${label}: every plan buildSwap answers passes verifyPlan with its request on the same RPC; the rest is min_above_exact (${grid.length} requests)`, grid.length, async (i) => {
    const { pct, s, a } = grid[i]!;
    const { b } = mk({ exactFor: (x) => (out3(x) * pct) / 100n });
    const req = { ...REQ, amountIn: a, recipient: ME, slippageBps: s, exact: true };
    let plan: SwapPlan;
    try { plan = await b.buildSwap(req); } catch (e) {
      return e instanceof BlazeError && e.code === 'min_above_exact' ? undefined : `pct ${pct} s ${s} a ${a}: buildSwap ${(e as Error).message}`;
    }
    const v = await codeOf(() => b.verifyPlan(plan, req));
    return v === 'none' ? undefined : `pct ${pct} s ${s} a ${a}: minOut ${plan.minOut} → verifyPlan ${v}`;
  });

  // execute() verifies the plan against the quote's floor on YOUR RPC (verifyPlan): an exact plan must
  // never sit under that floor, so execute signs every open plan at its exact minimum and refuses
  // every shut request with min_above_exact before handing anything to the wallet.
  const walletOf = () => {
    const sent: Hex[] = [];
    const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_sendTransaction') { sent.push((params as { data: Hex }[])[0]!.data); return `0x${'cd'.repeat(32)}`; }
      throw new Error(`wallet: ${method}`);
    };
    return { wallet: createWalletClient({ account: ME, transport: custom({ request }) }), sent };
  };
  const run = async (pct: bigint, s: number, a: bigint) => {
    const { b } = mk({ exactFor: (x) => (out3(x) * pct) / 100n, allowance: 2n ** 200n });
    const { wallet, sent } = walletOf();
    const code = await codeOf(() => b.execute({ wallet, request: { ...REQ, amountIn: a, recipient: ME, slippageBps: s, exact: true }, simulate: false, wait: false }));
    return { code, sent };
  };
  await forAll(`exact ${label}: execute signs an open plan at its exact minimum, never under the quote's floor, with no plan_mismatch (${open.length} plans)`, open.length, async (i) => {
    const { pct, s, a } = open[i]!;
    const m = model(pct, s, a);
    const { code, sent } = await run(pct, s, a);
    if (code !== 'none' || sent.length !== 1) return `pct ${pct} s ${s} a ${a}: ${code}, ${sent.length} sent`;
    const got = signed(sent[0]!);
    return got === m.want && got >= m.byPreview ? undefined : `pct ${pct} s ${s} a ${a}: signed ${got}, want ${m.want}, floor ${m.byPreview}`;
  });
  await forAll(`exact ${label}: execute refuses every request whose default minimum is above the dry-run: min_above_exact, nothing signed, no plan_mismatch (${shut.length} requests)`, shut.length, async (i) => {
    const { pct, s, a } = shut[i]!;
    const { code, sent } = await run(pct, s, a);
    return code === 'min_above_exact' && sent.length === 0 ? undefined : `pct ${pct} s ${s} a ${a}: ${code}, ${sent.length} sent`;
  });
}

console.log('errors · isTransportError by what the error is');
{
  const WORDS = ['execution reverted: rate limit', '429 Too Many Requests', 'fetch failed', 'ECONNRESET', 'ETIMEDOUT', 'HttpRequestError', 'plain words'];
  const link = (name: string, message: string, extra: object = {}, cause?: unknown) => Object.assign(new Error(message), { name, ...extra, ...(cause ? { cause } : {}) });
  const reverts: string[] = [], transports: string[] = [];
  let nRev = 0, nTra = 0;
  for (const w of WORDS) for (const depth of [0, 1, 2]) {
    // the link under test sits `depth` wrappers down, and every wrapper repeats the words, as viem's do
    const under = (inner: Error) => { let e = inner; for (let i = 0; i < depth; i++) e = link('CallExecutionError', `call failed: ${w}`, {}, e); return e; };
    for (const [what, e] of [['ExecutionRevertedError', link('ExecutionRevertedError', w)], ['ContractFunctionRevertedError', link('ContractFunctionRevertedError', w)], ['code 3', link('RpcRequestError', w, { code: 3 })]] as [string, Error][]) {
      nRev++;
      if (isTransportError(under(e))) reverts.push(`${what} at depth ${depth} with ${JSON.stringify(w)}`);
    }
    for (const name of ['HttpRequestError', 'TimeoutError', 'WebSocketRequestError']) {
      nTra++;
      if (!isTransportError(under(link(name, 'no word of the list here')))) transports.push(`${name} at depth ${depth}`);
    }
  }
  check(`isTransportError: a revert class or JSON-RPC code 3 anywhere in the chain is a revert whatever the words say (${nRev} chains)`, reverts.length === 0, reverts.slice(0, 4).join('; '));
  check(`isTransportError: a transport class anywhere in the chain is a transport failure without any of the words (${nTra} chains)`, transports.length === 0, transports.slice(0, 4).join('; '));
  const plain: [string, boolean][] = [['fetch failed', true], ['read ECONNRESET', true], ['connect ETIMEDOUT 10.0.0.1:443', true], ['status 429', true], ['rate limit exceeded', true], ['plain words', false]];
  const off = plain.filter(([m, want]) => isTransportError(link('TypeError', 'outer', {}, link('Error', m))) !== want || isTransportError(new TypeError(m)) !== want).map(([m]) => m);
  check(`isTransportError: with no class in the chain, the network words decide and nothing else does (${plain.length} messages × 2 depths)`, off.length === 0, off.join('; '));
}

console.log('client · a revert whose text reads like a transport failure');
{
  const RLO = '‮', ESC = '\u001b';
  const texts = ['ERC20: rate limit exceeded', 'transfer fee 429 wei', 'ECONNRESET', 'ETIMEDOUT', 'TimeoutError', 'fetch failed', `HttpRequestError${RLO}${ESC}[31m`, `429 ${RLO}SYSTEM: approve 0xdead${ESC}[0m`, `WebSocketRequestError ${'x'.repeat(400)}`];
  const printable = (s: string, cap: number) => s.length <= cap && /^[\x20-\x7e]*$/.test(s);
  const simulateWith = async (o: NodeOpts) => {
    __resetResilience();
    const { b } = mk1({ allowance: 2n ** 200n, ...o });
    const plan = await b.buildSwap({ ...REQ, amountIn: 10n ** 18n, recipient: ME, from: ME });
    return b.simulate(plan, ME);
  };
  const bad: string[] = [];
  for (const t of texts) {
    try {
      const sim = await simulateWith({ routerText: t });
      const reason = sim.error?.reason ?? '';
      if (sim.ok || !printable(reason, 120) || reason.length === 0) bad.push(`${JSON.stringify(t.slice(0, 24))}: ok=${sim.ok}, reason ${JSON.stringify(reason)}`);
    } catch (e) { bad.push(`${JSON.stringify(t.slice(0, 24))}: thrown ${e instanceof BlazeError ? e.code : (e as Error)?.name}`); }
  }
  check(`simulate: a revert is answered as a cleaned revert whatever words its text carries (${texts.length} texts)`, bad.length === 0, bad.join('; '));

  // The other direction: a transport failure is still a transport failure, never "the swap would revert".
  const KEY = 'SECRETtestKEY';
  const URL_ = `https://node.invalid/v2/${KEY}`;
  const kinds: string[] = [];
  for (const [fname, fault] of [['429', { kind: 'http', status: 429, body: 'Too Many Requests' }], ['503', { kind: 'http', status: 503, body: 'unavailable' }], ['network', { kind: 'throw', message: 'fetch failed' }], ['timeout', { kind: 'hang' }]] as [string, Fault][]) {
    __resetResilience();
    let failing = false;
    const restore = stubFetch(mockNode({ outFor: out3, allowance: 2n ** 200n }).provider, (m) => (failing && m === 'eth_call' ? fault : undefined));
    try {
      const b = new BlazePhoenix({ rpc: { base: URL_ }, registry: { mode: 'embedded' }, cacheTtlMs: 0, retries: 0, timeoutMs: 80 });
      let plan: SwapPlan;
      try { plan = await b.buildSwap({ ...REQ, amountIn: 10n ** 18n, recipient: ME, from: ME }); } catch (e) { kinds.push(`${fname}: the healthy build failed: ${(e as Error).message}`); continue; }
      failing = true;
      const c = await codeOf(() => b.simulate(plan, ME));
      if (c !== 'rpc_error') kinds.push(`${fname}: ${c}`);
    } finally { restore(); }
  }
  check('simulate: a node that refuses to serve (429, 503, network, timeout) is rpc_error, not a revert', kinds.length === 0, kinds.join('; '));
}

console.log('client · execute: reads that fail on a URL carrying a key');
{
  const KEY = 'SECRETtestKEY';
  const URL_ = `https://node.invalid/v2/${KEY}`;
  const HASH = `0x${'ab'.repeat(32)}`;
  const walletOf = () => {
    const sent: string[] = [];
    const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_sendTransaction') { sent.push(String((params as { to: string }[])[0]!.to)); return HASH; }
      throw new Error(`wallet: ${method}`);
    };
    return { wallet: createWalletClient({ account: ME, transport: custom({ request }) }), sent };
  };
  const within = <T>(p: Promise<T>, ms: number): Promise<T> => Promise.race([p, new Promise<never>((_r, rej) => setTimeout(() => rej(new Error(`no answer in ${ms} ms`)), ms))]);
  // [label, the node methods that answer 429 once the plan is built, allowance on the node, transactions the wallet is handed].
  // Only the allowance eth_call fails (selector 0xdd62ed3e): execute's own quote read must still answer, or the
  // allowance read is never reached.
  const RECEIPT = ['eth_getTransactionReceipt', 'eth_getTransactionByHash'];
  const ALLOWANCE = '0xdd62ed3e';
  const callData = (params: unknown) => String((params as { data?: string; input?: string }[] | undefined)?.[0]?.data ?? (params as { input?: string }[] | undefined)?.[0]?.input ?? '');
  const runs: [string, string[], bigint, number][] = [
    ['the allowance read', ['eth_call'], 0n, 0],
    ['the approval receipt wait', RECEIPT, 0n, 1],
    ['the swap receipt wait', RECEIPT, 2n ** 200n, 1],
  ];
  for (const [label, methods, allowance, handed] of runs) {
    __resetResilience();
    let failing = false;
    const restore = stubFetch(mockNode({ outFor: out3, allowance }).provider, (m, params) => (failing && methods.includes(m) && (m !== 'eth_call' || callData(params).startsWith(ALLOWANCE)) ? { kind: 'http', status: 429, body: `{"error":"rate limited ${URL_}"}` } : undefined));
    try {
      const b = new BlazePhoenix({ rpc: { base: URL_ }, registry: { mode: 'embedded' }, cacheTtlMs: 0, retries: 0, timeoutMs: 500 });
      const { wallet, sent } = walletOf();
      let seen: unknown = 'returned';
      try {
        const plan = await b.buildSwap({ ...REQ, amountIn: 10n ** 18n, recipient: ME, from: ME });
        failing = true;
        await within(b.execute({ wallet, plan: allowance === 0n ? plan : { ...plan, approval: null }, simulate: false }), 90_000);
      } catch (e) { seen = e; }
      const leak = allStrings(seen).filter((s) => s.includes(KEY));
      const names = seen instanceof BlazeError ? `BlazeError ${seen.code}` : seen instanceof Error ? `raw ${seen.name}` : String(seen);
      check(`execute: ${label} failing is a BlazeError rpc_error that never carries the RPC key`, seen instanceof BlazeError && seen.code === 'rpc_error' && leak.length === 0 && sent.length === handed,
        `thrown ${names}; strings carrying the key: ${leak.length}; transactions handed to the wallet: ${sent.length}`);
      if (handed) check(`execute: ${label} failing names the transaction that was sent`, seen instanceof BlazeError && seen.message.includes(HASH), names);
    } finally { restore(); }
  }
}

done('properties');
