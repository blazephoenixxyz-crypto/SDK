#!/usr/bin/env node
// Mutation catalogue for scripts/test-properties.ts — every check there names the
// mutant that must turn it red. A check that stays green on its mutant proves nothing.
//
//   node scripts/mutants.mjs            run all (one at a time; never alongside `npm test`)
//   node scripts/mutants.mjs 7 12       run PER-7 and PER-12
//
// Verdict is by the NAME of the paired check, not by the exit code:
//   KILLED        every paired check printed ✗
//   SURVIVED      the suite reached its summary line and a paired check stayed green
//   INCONCLUSIVE  the suite crashed or timed out before the summary (not counted as killed)
//   STALE         `old` does not occur exactly once in the file (the source moved)
// The source file is restored after every run; the script fails if src/ is left dirty.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const SUITE = ['npx', 'tsx', 'scripts/test-properties.ts'];
const F = { cal: 'src/calldata.ts', chk: 'src/checks.ts', erc: 'src/erc20.ts', err: 'src/errors.ts', rpc: 'src/rpc.ts', cli: 'src/client.ts', res: 'src/resilience.ts', reg: 'src/registry.ts' };
const CACHE = ((t) => t.slice(t.indexOf('memGet(key, this.cacheTtlMs, undefined, this)'), t.indexOf('memPut(key, q, undefined, this)') + 31))(readFileSync(F.cli, 'utf8'));
const RAISE = 'floor = maxBig(floor, minOutFor(ceil, slippageBps, 0n));';
const EXACT = ((t) => t.slice(t.indexOf('if (floor > ceil) {'), t.indexOf(RAISE) + RAISE.length))(readFileSync(F.cli, 'utf8'));
const guard = (cond) => [`if (${cond}) bad.push`, 'if (false) bad.push'];
const FAULTS = ['quote', 'quoteExact', 'buildSwap', 'tokenInfo', 'getFills'].map((e) => `faults: ${e} fails as a BlazeError`);

/** [file, old, new, paired check name prefix(es), opt?] — the id is the position, 1-based.
 *  opt.also: further [file, old, new] changes made in the same mutant; opt.expectSurvive: a control. */
const M = [
  [F.cal, 'args: [route as never, amountIn, userMinOut, recipient, deadline],', 'args: [route as never, userMinOut, amountIn, recipient, deadline],', 'codec: the bytes are swapExactIn('],
  [F.cal, 'const [route, amountIn, userMinOut, recipient, deadline] = d.args', 'const [route, userMinOut, amountIn, recipient, deadline] = d.args', ['codec: decode(encode(x)) = x', 'verify: an honest call passes']],
  [F.cal, 'args: [route as never, userMinOut, recipient, deadline],', 'args: [route as never, 0n, recipient, deadline],', 'codec: the native and best encodings'],
  [F.cal, "if (d.functionName !== 'swapExactIn') {", 'if (false) {', 'codec: decodeSwapExactIn refuses the native and best selectors'],
  [F.cal, ...guard('got.amountIn !== want.amountIn'), 'verify: amountIn off by one bit'],
  [F.cal, ...guard('got.recipient.toLowerCase() !== want.recipient.toLowerCase()'), 'verify: another recipient'],
  [F.cal, ...guard('got.deadline !== want.deadline'), 'verify: deadline off by one bit'],
  [F.cal, ...guard('got.userMinOut < want.minOutAtLeast'), 'verify: a minimum one unit under'],
  [F.cal, ...guard('got.userMinOut === 0n'), 'verify: a zero minimum'],
  [F.cal, ...guard('!routeIsConsistent(got.route, want.tokenIn, want.tokenOut)'), 'verify: a route for another pair'],
  [F.cal, ...guard('want.route && routeFingerprint(got.route) !== routeFingerprint(want.route)'), 'verify: any single route scalar'],
  [F.cal, "typeof v === 'bigint' ? `${v}n`", "typeof v === 'bigint' ? Number(v)", 'verify: any single route scalar'],
  [F.cal, 'if (got.amountIn !== want.amountIn) bad.push(`amountIn', 'if (got.amountIn < want.amountIn) bad.push(`recipient', 'verify: an honest call passes', { expectSurvive: 'control: a mutant the honest-call check cannot see (it never tampers)' }],
  [F.cal, 'if (minOut <= d.userMinOut) return data;', 'if (minOut >= d.userMinOut) return data;', 'tighten: the minimum becomes max(old, new)'],
  [F.cal, 'return bySlip > floor ? bySlip : floor;', 'return bySlip < floor ? bySlip : floor;', 'minOutFor: equals max('],
  [F.cal, '(netOut * BigInt(slippageBps)) / 10_000n', '(netOut * BigInt(slippageBps) + 9_999n) / 10_000n', 'minOutFor: equals max('],
  [F.cal, 'slippageBps > 5_000', 'slippageBps > 5_001', 'minOutFor: slippage above 5000'],
  [F.cal, 'slippageBps < 0 ||', 'slippageBps < -1 ||', 'minOutFor: negative slippage'],
  [F.cal, '!Number.isInteger(slippageBps) || ', '', 'minOutFor: a slippage that is not an integer'],

  [F.chk, 'if (h.length === 0) return false;', '', 'route: no hops is inconsistent'],
  [F.chk, '!same(h[0].tokenIn, tokenIn) || ', '', 'route: a first hop'],
  [F.chk, ' || !same(h[h.length - 1].tokenOut, tokenOut)', '', 'route: a last hop'],
  [F.chk, 'for (let i = 1; i < h.length; i++)', 'for (let i = 2; i < h.length; i++)', 'route: hops that do not chain'],
  [F.chk, 'hop.legs.length > 0', 'hop.legs.length >= 0', 'route: a hop without legs'],
  [F.chk, 'const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();', 'const same = (a: string, b: string) => a === b;', 'route: a connected two-hop route is consistent'],

  [F.erc, "frac.padEnd(decimals, '0')", "frac.padStart(decimals, '0')", 'units: fromBaseUnits is the decimal text'],
  [F.erc, "(abs % base).toString().padStart(decimals, '0')", "(abs % base).toString().padEnd(decimals, '0')", 'units: fromBaseUnits is the decimal text'],
  [F.erc, '/^(\\d+)(?:\\.(\\d+))?$/', '/^(\\d+)(?:\\.(\\d*))?$/', 'units: a malformed amount'],
  [F.erc, 'if (frac.length > decimals) {', 'if (frac.length > decimals + 1) {', 'units: more fractional digits'],
  [F.erc, 'export function toBaseUnits(amount: string, decimals: number): bigint {\n  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {',
    'export function toBaseUnits(amount: string, decimals: number): bigint {\n  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 78) {', 'units: decimals outside 0..77'],

  [F.err, '/[^\\x20-\\x7e]+/g', '/[^\\x20-\\x7f]+/g', 'text: untrustedText is printable ASCII'],
  [F.err, '/[^\\x20-\\x7e]+/g', '/[^\\x20-\\x7d]+/g', 'text: untrustedText is printable ASCII'],
  [F.err, '.trim().slice(0, max)', '.trim()', 'text: untrustedText is printable ASCII'],
  [F.err, ".replace(/\\s+/g, ' ')", '', 'text: untrustedText is printable ASCII'],
  [F.err, 'new Error(scrubUrls(c.message)', 'new Error((c.message)', FAULTS],

  [F.rpc, '[^\\s"\'<>]+/gi', '[^\\s"\'<>?]+/gi', 'rpc: scrubUrls removes the key'],
  [F.rpc, '+/gi, (m) => redact(m)', '+/g, (m) => redact(m)', 'rpc: scrubUrls removes the key'],
  [F.rpc, '${u.protocol}//${u.host}${path}', '${u.protocol}//${u.host}${u.pathname}', 'rpc: redact never returns the key'],
  [F.rpc, "u.hostname === 'localhost' ||", "u.hostname.startsWith('localhost') ||", 'rpc: plain http/ws is allowed only'],
  [F.rpc, "u.hostname === '127.0.0.1' ||", "u.hostname.startsWith('127.0.0.1') ||", 'rpc: plain http/ws is allowed only'],
  [F.rpc, "u.hostname === '[::1]';\n  }\n  return false;", "u.hostname === '[::1]';\n  }\n  return true;", 'rpc: plain http/ws is allowed only'],
  [F.rpc, "if (u.protocol === 'https:' || u.protocol === 'wss:') return true;", "if (u.protocol === 'wss:') return true;", 'faults: the same endpoint without a fault'],
  [F.rpc, 'your RPC did not answer eth_chainId: ${scrubUrls(String((e as Error)?.message ?? e))}', 'your RPC did not answer eth_chainId: ${String((e as Error)?.message ?? e)}', 'faults: quote fails as a BlazeError'],

  [F.cli, 'data = tightenMinOut(call, minOut);', 'data = call;', 'plan 2.x:'],
  [F.cli, 'if (userMinOut < floor) {', 'if (false) {', ['plan 1.x:', 'plan 2.x:']],
  [F.cli, 'let floor = minOutFor(p.netOut, slippageBps, p.ironFloor);', 'let floor = minOutFor(p.netOut, slippageBps, 0n);', 'plan 1.x:'],
  [F.cli, 'data = encodeSwapExactIn(pv.route, amountIn, minOut, recipient, deadline);', 'data = encodeSwapExactIn(pv.route, amountIn, pv.effectiveMinOut, recipient, deadline);', 'plan 1.x:'],
  [F.cli, 'minOutAtLeast: pv.effectiveMinOut, route: pv.route,', 'minOutAtLeast: 0n, route: pv.route,', 'lying Quoter: every tampered encoding'],
  [F.cli, "encodedBy = 'quoter';", "encodedBy = 'sdk';", 'lying Quoter: the honest encoding is accepted'],
  [F.cli, "functionName: 'decimals' }).then(Number);", "functionName: 'decimals' }).then(() => 18);", 'decimals: "1" is 10^d base units'],
  [F.cli, "try { v = toBaseUnits(req.amount, d); } catch (e) { throw new BlazeError('bad_request', (e as Error).message); }", 'v = toBaseUnits(req.amount, d);', 'decimals: an amount the chain decimals cannot carry'],
  [F.cli, 'if (human !== v) {', 'if (false) {', 'decimals: amount and amountIn in one request must agree'],
  [F.cli, 'if (v > UINT128_MAX) throw', 'if (false) throw', 'amounts: amountIn that is zero, above uint128'],
  [F.cli, 'if (v <= 0n) throw', 'if (v < 0n) throw', 'amounts: amountIn that is zero, above uint128'],
  [F.cli, "if (typeof req.userMinOut !== 'bigint' && !INT.test(s)) throw", 'if (false) throw', 'amounts: a userMinOut string'],
  [F.cli, 'if (hit) return structuredClone(hit);', 'if (false) return structuredClone(hit);', 'cache: the identical request is answered from the cache'],
  [F.cli, '|${amountIn}|${userMinOut}|${req.blockNumber', '|${userMinOut}|${req.blockNumber', 'cache: another amountIn'],
  [F.cli, '|${amountIn}|${userMinOut}|${req.blockNumber', '|${amountIn}|${req.blockNumber', 'cache: another userMinOut'],
  [F.cli, '|${tIn.address}|${tIn.native}|${tOut.address}', '|${tIn.native}|${tOut.address}', 'cache: another tokenIn'],
  [F.cli, '|${tOut.address}|${tOut.native}|${amountIn}', '|${tOut.native}|${amountIn}', 'cache: another tokenOut'],
  [F.cli, 'const cacheable = this.cacheTtlMs > 0 && req.blockNumber === undefined;', 'const cacheable = this.cacheTtlMs > 0;', 'cache: a quote pinned to a block'],
  [F.cli, "reason: untrustedText((e as Error)?.message?.split('\\n')[0]) || 'execution reverted'", "reason: ((e as Error)?.message?.split('\\n')[0]) || 'execution reverted'", "simulate: a token's revert text"],
  // quoteBatch scrubs once more what every read below it already scrubbed: a second wall. Alone, its
  // removal is invisible (measured: SURVIVED), so this mutant also takes the first wall down
  // (the change of the eth_chainId mutant above); that one alone leaves quoteBatch green.
  [F.cli, 'message: scrubUrls((e as Error)?.message ?? String(e)) },', 'message: ((e as Error)?.message ?? String(e)) },', 'faults: quoteBatch fails as a BlazeError',
    { also: [[F.rpc, 'your RPC did not answer eth_chainId: ${scrubUrls(String((e as Error)?.message ?? e))}', 'your RPC did not answer eth_chainId: ${String((e as Error)?.message ?? e)}']] }],

  [F.res, 'now - hit.at < ttlMs', 'now - hit.at <= ttlMs', 'cache: an entry lives strictly less'],
  [F.res, 'if (mem.size > 500) {', 'if (mem.size > 5000) {', 'cache: bounded'],
  // The cache and the in-flight sharing are per client; every caller gets its own copy
  // One edit per file: `also` rewrites from the original text, so two edits of one file do not compose.
  [F.cli, CACHE, CACHE.replace('undefined, this)', 'undefined)').replace('undefined, this)', 'undefined)'), ['scope: clients on different nodes one after the other', 'scope: a value another caller put']],
  [F.cli, '    }, this);\n    if (cacheable) memPut', '    });\n    if (cacheable) memPut', ['scope: clients on different nodes asking at the same time', 'scope: a slow call another caller started']],
  [F.cli, 'const q = await singleflight(key, async () => {', 'const q = await ((_k, f, _s) => f())(key, async () => {', 'scope: one client asking the same request four times'],
  [F.cli, 'if (hit) return structuredClone(hit);', 'if (hit) return hit;', 'copy: every quote answered from the cache'],
  [F.cli, 'return structuredClone(q);', 'return q;', ['copy: every quote answered from the cache', 'copy: two callers sharing one read']],
  [F.res, 'function bucket(scope: object = DEFAULT): Bucket {', 'function bucket(_scope: object = DEFAULT, scope = DEFAULT): Bucket {',
    ['scope: clients on different nodes one after the other', 'scope: clients on different nodes asking at the same time', 'scope: a value another caller put', 'scope: a slow call another caller started', 'registry: two instances with their own fetch']],
  [F.res, 'SCOPES = new WeakMap();', 'void SCOPES;', 'scope: __resetResilience clears the cache of a live client'],
  [F.cli, 'const cacheable = this.cacheTtlMs > 0 && req.blockNumber === undefined;\n    if (cacheable) {\n      const hit = memGet(key, this.cacheTtlMs,',
    'const cacheable = req.blockNumber === undefined;\n    if (cacheable) {\n      const hit = memGet(key, 60_000,', 'cache: cacheTtlMs 0 reads the node on every request'],
  [F.reg, '}, this.fetchFn);', '});', 'registry: two instances with their own fetch'],
  [F.reg, 'const raw = await singleflight(`registry ${this.url}`, async () => {', 'const raw = await ((_k, f, _s) => f())(`registry ${this.url}`, async () => {', 'registry: two instances sharing one fetch'],
  // Exact minimum, revert versus transport, execute reads
  // exact minimum: refused, never capped, when the default minimum is above the dry-run less the margin
  [F.cli, EXACT, EXACT.replace('if (floor > ceil) {', 'if (p.ironFloor > ceil) {').replace(RAISE, `${RAISE} if (floor > ceil) floor = ceil;`), ['exact 1.x: a default minimum above', 'exact 2.x: a default minimum above', 'exact 1.x: where the preview sits above the dry-run', 'exact 2.x: where the preview sits above the dry-run', 'exact 1.x: every plan buildSwap answers passes verifyPlan', 'exact 2.x: every plan buildSwap answers passes verifyPlan', 'exact 1.x: execute refuses every request', 'exact 2.x: execute refuses every request']],
  [F.cli, 'if (floor > ceil) {', 'if (false) {', ['exact 1.x: a default minimum above', 'exact 2.x: a default minimum above', 'exact 1.x: execute refuses every request', 'exact 2.x: execute refuses every request']],
  [F.cli, 'if (floor > ceil) {', 'if (floor >= ceil) {', ['exact 1.x: the signed minimum is max(', 'exact 2.x: the signed minimum is max(']],
  [F.cli, RAISE, 'floor = floor;', ['exact 1.x: the signed minimum is max(', 'exact 2.x: the signed minimum is max(', 'exact 1.x: execute signs an open plan', 'exact 2.x: execute signs an open plan']],
  [F.cli, 'if (ceil !== undefined && userMinOut > ceil && userMinOut > floor) {', 'if (ceil !== undefined && userMinOut > ceil + 1n && userMinOut > floor) {', ['exact 1.x: inside the ceiling', 'exact 2.x: inside the ceiling']],
  [F.cli, 'if (userMinOut < floor) {', 'if (userMinOut < floor - 1n) {', ['exact 1.x: inside the ceiling', 'exact 2.x: inside the ceiling']],
  [F.err, "if (name === 'ExecutionRevertedError' || name === 'ContractFunctionRevertedError' || e.code === 3) return false;", '', ['simulate: a revert is answered as a cleaned revert', 'isTransportError: a revert class']],
  [F.err, "name === 'ExecutionRevertedError' || ", '', 'isTransportError: a revert class'],
  [F.err, "name === 'ContractFunctionRevertedError' || ", '', 'isTransportError: a revert class'],
  [F.err, ' || e.code === 3', '', 'isTransportError: a revert class'],
  [F.err, "name === 'HttpRequestError' || ", '', ['isTransportError: a transport class', 'simulate: a node that refuses to serve']],
  [F.err, "name === 'TimeoutError' || ", '', 'isTransportError: a transport class'],
  [F.err, " || name === 'WebSocketRequestError'", '', 'isTransportError: a transport class'],
  [F.err, 'words ||= ', 'words &&= ', 'isTransportError: with no class in the chain'],
  [F.err, '  return words;\n}', '  return true;\n}', 'isTransportError: with no class in the chain'],
  [F.cli, "args: [account.address, plan.approval.spender],\n      }).catch((e: unknown) => this.wrapReadError(e, 'allowance'))", 'args: [account.address, plan.approval.spender],\n      })', 'execute: the allowance read failing is'],
  [F.cli, '.catch((e: unknown) => this.wrapReadError(e, `receipt of the approval ${approvalHash}`))', '', ['execute: the approval receipt wait failing is', 'execute: the approval receipt wait failing names']],
  [F.cli, '.catch((e: unknown) => this.wrapReadError(e, `receipt of the swap ${hash}`))', '', ['execute: the swap receipt wait failing is', 'execute: the swap receipt wait failing names']],
  [F.cli, '`receipt of the approval ${approvalHash}`', "'receipt of the approval'", 'execute: the approval receipt wait failing names'],
  [F.cli, '`receipt of the swap ${hash}`', "'receipt of the swap'", 'execute: the swap receipt wait failing names'],
];

const only = process.argv.slice(2).map(Number);
const rows = [];
const dead = new Set();   // paired name prefixes with a killed mutant
const clean = only.length ? '' : spawnSync(SUITE[0], SUITE.slice(1), { encoding: 'utf8', timeout: 180_000 }).stdout ?? '';
if (!only.length && !/^properties: \d+ passed, 0 failed$/m.test(clean)) { console.error('the suite is not green before any mutant — fix that first'); process.exit(2); }
for (const [i, [file, old, neu, tests, opt]] of M.entries()) {
  const id = `PER-${i + 1}`;
  if (only.length && !only.includes(i + 1)) continue;
  const names = [tests].flat();
  const edits = [[file, old, neu], ...(opt?.also ?? [])];
  const before = new Map(edits.map(([f]) => [f, readFileSync(f, 'utf8')]));
  let verdict, note = '';
  if (edits.some(([f, o]) => before.get(f).split(o).length !== 2)) { verdict = 'STALE'; } else {
    try {
      for (const [f, o, nw] of edits) writeFileSync(f, `// MUTANT ${id}\n${before.get(f).replace(o, () => nw)}`);
      const run = spawnSync(SUITE[0], SUITE.slice(1), { encoding: 'utf8', timeout: 180_000 });
      const text = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
      const red = text.split('\n').filter((l) => l.startsWith('  ✗ ')).map((l) => l.slice(4));
      const reached = /^properties: \d+ passed, \d+ failed$/m.test(text);
      const hit = names.filter((n) => red.some((l) => l.startsWith(n)));
      verdict = !reached ? 'INCONCLUSIVE' : hit.length === names.length ? 'KILLED' : 'SURVIVED';
      if (verdict !== 'KILLED') note = reached ? `green: ${names.filter((n) => !hit.includes(n)).join(' | ')}; red elsewhere: ${red.length}` : `rc ${run.status} ${run.signal ?? ''} ${text.trim().split('\n').pop()?.slice(0, 160)}`;
    } finally { for (const [f, text] of before) writeFileSync(f, text); }
  }
  if (opt?.expectSurvive) { note = `${opt.expectSurvive} — expected SURVIVED, got ${verdict}`; verdict = verdict === 'SURVIVED' ? 'CONTROL-OK' : 'CONTROL-BROKEN'; }
  rows.push({ id, verdict });
  if (verdict === 'KILLED') names.forEach((x) => dead.add(x));
  console.log(`${verdict.padEnd(13)} ${id.padEnd(18)} ${file.padEnd(18)} ${names[0].slice(0, 60)}${names.length > 1 ? ` (+${names.length - 1})` : ''}${note ? `\n              ${note}` : ''}`);
}
const dirty = spawnSync('git', ['status', '--porcelain', '--', 'src'], { encoding: 'utf8' }).stdout.trim();
const marker = spawnSync('grep', ['-rl', '// MUTANT', 'src'], { encoding: 'utf8' }).stdout.trim();
const n = (v) => rows.filter((r) => r.verdict === v).length;
console.log(`\n${rows.length} mutants: ${n('KILLED')} killed, ${n('SURVIVED')} survived, ${n('INCONCLUSIVE')} inconclusive, ${n('STALE')} stale, control ${n('CONTROL-OK')} ok / ${n('CONTROL-BROKEN')} broken`);
// Completeness: every check of the clean run must be the paired check of a killed mutant.
const orphans = clean.split('\n').filter((l) => l.startsWith('  ✓ ')).map((l) => l.slice(4)).filter((c) => ![...dead].some((p) => c.startsWith(p)));
if (!only.length) console.log(`checks without a dead mutant: ${orphans.length}${orphans.map((o) => `\n  - ${o}`).join('')}`);
if (dirty || marker) { console.error(`src/ is not clean after the run:\n${dirty}\n${marker}`); process.exit(2); }
process.exit(rows.every((r) => r.verdict === 'KILLED' || r.verdict === 'CONTROL-OK') && orphans.length === 0 ? 0 : 1);
