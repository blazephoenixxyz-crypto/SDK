// =============================================================================
//  🔥 PHOENIX BOT — a Telegram bot with a difference: ZERO CUSTODY.
//
//  The famous trading bots hold your private keys on their servers. This one
//  never touches a key: it quotes on-chain truth, streams real fills, and
//  executes by DEEP-LINKING you into your own wallet. Compute, don't trust —
//  as a bot.
//
//  Commands:
//    /price [SYM]            → 1 WETH → SYM quote (default BZPX)
//    /quote AMT IN OUT       → full quote: output, impact, gas + swap button
//    /watch                  → stream every BlazePhoenix fill on Base (needs RPC_URL)
//    /stop                   → stop the stream
//
//  Run:
//    npm i grammy viem && npm i github:blazephoenixxyz-crypto/SDK
//    BOT_TOKEN=... RPC_URL=https://your-base-rpc npx tsx examples/phoenix-bot.ts
// =============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { Bot, InlineKeyboard, InlineQueryResultBuilder } from 'grammy';
import {
  BlazePhoenix, deepLink, watchFills, toBaseUnits, fromBaseUnits,
  type QuoteChecks,
} from '@blazephoenix/sdk';

const bot = new Bot(process.env.BOT_TOKEN!);
const blaze = new BlazePhoenix(); // retries + micro-cache built in (v0.3.0)

const fmt = (v: string, dp = 6) => fromBaseUnits(v, 6, dp); // USDC-style display

// ── Usage metrics — self-tracked, because Telegram exposes none ─────────────
// BotFather/the Bot API give you NO usage analytics, so the only honest source
// of "how is it used" is the bot counting its own traffic. This is fully local:
// unique users, per-command counts and quotes served, kept in memory and — if
// METRICS_FILE is set — flushed to a JSON file so a restart doesn't zero it.
// Nothing personal is stored beyond numeric Telegram ids (needed to count uniques
// and to gate /stats to the owner). No third party, no key, no cost.
const METRICS_FILE = process.env.METRICS_FILE || '';
const ADMIN_ID = Number(process.env.ADMIN_ID || 0); // who may read /stats (0 = anyone)
interface Metrics { startedAt: number; commands: number; inline: number; perCommand: Record<string, number>; users: number[]; }
const metrics: Metrics = { startedAt: Date.now(), commands: 0, inline: 0, perCommand: {}, users: [] };
const userSet = new Set<number>();
if (METRICS_FILE) {
  try {
    const saved = JSON.parse(readFileSync(METRICS_FILE, 'utf8')) as Partial<Metrics>;
    Object.assign(metrics, saved);
    metrics.startedAt = saved.startedAt ?? Date.now(); // keep first-ever start
    (saved.users ?? []).forEach((u) => userSet.add(u));
  } catch { /* first run, or unreadable — start fresh, never crash */ }
}
const flushMetrics = () => {
  if (!METRICS_FILE) return;
  metrics.users = [...userSet];
  try { writeFileSync(METRICS_FILE, JSON.stringify(metrics)); } catch { /* disk full etc — metrics are best-effort */ }
};
if (METRICS_FILE) setInterval(flushMetrics, 30_000).unref();

// Runs before every handler (registered first), so it sees and counts them all.
bot.use(async (ctx, next) => {
  if (ctx.from?.id) userSet.add(ctx.from.id);
  const txt = ctx.message?.text;
  if (txt?.startsWith('/')) {
    const cmd = txt.slice(1).split(/[\s@]/)[0].toLowerCase();
    metrics.commands++;
    metrics.perCommand[cmd] = (metrics.perCommand[cmd] ?? 0) + 1;
  }
  if (ctx.inlineQuery) metrics.inline++;
  await next();
});

// ── Which chain am I quoting on? (per-chat, switchable with /chain) ──────────
// The bot quotes across every chain BlazePhoenix serves, not just Base. The SDK
// takes the id or the name; DexScreener keys its market data by its OWN slug,
// which differs for Ethereum ("ethereum", not "eth"), so both are carried here.
const CHAINS: Record<string, { sdk: string; dex: string; label: string; explorer: string }> = {
  base:      { sdk: 'base',      dex: 'base',      label: 'Base',      explorer: 'https://basescan.org/tx/' },
  ethereum:  { sdk: 'eth',       dex: 'ethereum',  label: 'Ethereum',  explorer: 'https://etherscan.io/tx/' },
  optimism:  { sdk: 'optimism',  dex: 'optimism',  label: 'Optimism',  explorer: 'https://optimistic.etherscan.io/tx/' },
  arbitrum:  { sdk: 'arbitrum',  dex: 'arbitrum',  label: 'Arbitrum',  explorer: 'https://arbiscan.io/tx/' },
  robinhood: { sdk: 'robinhood', dex: 'robinhood', label: 'Robinhood', explorer: '' },
};
// Everything a human might type maps to one canonical key.
const CHAIN_ALIAS: Record<string, string> = {
  base: 'base', '8453': 'base',
  eth: 'ethereum', ethereum: 'ethereum', mainnet: 'ethereum', '1': 'ethereum',
  op: 'optimism', optimism: 'optimism', '10': 'optimism',
  arb: 'arbitrum', arbitrum: 'arbitrum', '42161': 'arbitrum',
  robinhood: 'robinhood', rbn: 'robinhood', '4663': 'robinhood',
};
// Per-chat selection. Telegram is stateless between messages, so we remember it.
// (In-memory: a restart resets everyone to Base — fine for a demo bot; swap this
//  Map for a KV store if you run it for real.)
const chatChain = new Map<number, string>();
const chainKeyOf = (ctx: any): string => chatChain.get(ctx.chat?.id) ?? 'base';
const chainOf = (ctx: any) => CHAINS[chainKeyOf(ctx)];

// ── Human-readable amounts ──────────────────────────────────────────────────
// The API returns every amount in the token's base units (a wei-style integer),
// and the response does NOT carry the token's decimals — so we infer them from
// the symbol: dollar-stables settle in 6, wrapped-BTC in 8, everything else in
// the EVM default of 18. Then the integer part is grouped with separators so a
// price reads like a price (1,866.83) instead of a raw ledger figure.
const DECIMALS: Record<string, number> = {
  USDC: 6, USDT: 6, USDG: 6, USDBC: 6, EURC: 6, WBTC: 8, CBBTC: 8, TBTC: 18,
};
const decimalsOf = (sym: string) => DECIMALS[sym.toUpperCase()] ?? 18;

const fmtAmount = (raw: string, dec: number) => {
  const s = fromBaseUnits(raw, dec, dec >= 8 ? 8 : 6);
  const n = Number(s);
  if (!Number.isFinite(n)) return s; // never invent a number — show what we have
  const dp = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
  return n.toLocaleString('en-US', { maximumFractionDigits: dp });
};
const amountOf = (raw: string, sym: string) => fmtAmount(raw, decimalsOf(sym));


// ── Brand layer ──────────────────────────────────────────────────────────────
// What Telegram DOES let you control: the bot's avatar, the name in the header,
// message formatting (HTML), images, and the buttons. What it does NOT let you
// control: fonts, colours, bubble shapes — those belong to the user's client
// and no bot can override them. So the identity is carried by the three things
// we do own: a consistent structure, our own images, and the Mini App, which is
// the real site rendered inside Telegram — that one IS our design, pixel for
// pixel.
//
// The avatar is set once in @BotFather (/setuserpic) with public/brand/logo.png.
const BRAND = {
  name: 'BlazePhoenix',
  site: 'https://blazephoenix.xyz',
  logo: 'https://blazephoenix.xyz/brand/logo.png',
  card: 'https://blazephoenix.xyz/brand/og.png',
  tagline: 'Compute, don\'t trust.',
  x: 'https://x.com/blazephoenyx',
  telegram: 'https://t.me/Blue_PhoenixOfficial',
};

/** The three official places, as buttons. Reused on /start, /connect and /links
 *  so the same real links ride under our name everywhere — and nowhere else. */
const linksRow = () => new InlineKeyboard()
  .url('🌐 Website', BRAND.site).row()
  .url('𝕏 Twitter / X', BRAND.x)
  .url('✈️ Telegram', BRAND.telegram);

/** A one-line footer of the same links, for text replies that already carry a
 *  different keyboard (a swap button), so the links never disappear. */
const linksFooter = `🌐 <a href="${BRAND.site}">blazephoenix.xyz</a>`
  + ` · 𝕏 <a href="${BRAND.x}">@blazephoenyx</a>`
  + ` · ✈️ <a href="${BRAND.telegram}">Telegram</a>`;

/** Every reply shares one shape: a titled block, the body, and a quiet footer.
 *  Repetition is the whole mechanism — after three messages a reader recognises
 *  the format before they read the words. */
const card = (title: string, body: string, footer = BRAND.tagline) =>
  `<b>🔥 ${title}</b>\n\n${body}\n\n<i>${footer}</i>`;

const HTML = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };


// ── Slippage and price impact, in the words a trader actually needs ─────────
// Two different things that get conflated constantly:
//
//   PRICE IMPACT is the cost you cause YOURSELF by trading against a finite
//   pool. It is knowable before you sign, it grows faster than linearly with
//   size, and on a thin pool it dwarfs every fee.
//
//   SLIPPAGE is the cost of the market MOVING between your quote and your
//   inclusion. You cannot predict it; you cap it, with a minimum-output floor.
//
// The bot prints impact as a percentage with a plain-language band, and prints
// the enforced floor — the number the Router will not settle below — so a
// reader sees both the cost they are choosing and the worst case they are
// protected to. Bands mirror the site: under 5% ordinary, 5-15% expensive,
// above 15% the site itself demands an explicit unlock.
const impactLine = (bps?: number) => {
  if (bps === undefined) return 'price impact: unknown';
  const pct = bps / 100;
  const band = bps >= 1500 ? '🔴 severe — the pool is too thin for this size'
    : bps >= 500 ? '🟠 expensive — consider splitting the trade'
    : bps >= 100 ? '🟡 noticeable'
    : '🟢 ordinary';
  return `price impact <b>${pct.toFixed(2)}%</b> ${band}`;
};

/** The floor the Router enforces on-chain — your protection against the market
 *  moving after you sign. It is derived by the contract, not by this bot. */
const floorLine = (minOut: string | undefined, outSym: string) => {
  if (!minOut) return '';
  return `\nguaranteed minimum <b>${amountOf(minOut, outSym)} ${esc(outSym.toUpperCase(), 16)}</b>`
    + ` — the Router reverts below this, whatever the market does`;
};

// ── Per-chat slippage cap (switchable with /slippage) ───────────────────────
// Unset means "use the protocol's own on-chain floor" (effectiveMinOut) — the
// safest default, and what the API applies when we send no slippageBps. A user
// who wants a looser or tighter cap sets it here, in percent, and every quote
// from then on carries it.
const chatSlip = new Map<number, number>();
const slipOf = (ctx: any): number | undefined => chatSlip.get(ctx.chat?.id);
const slipLine = (bps?: number) =>
  bps === undefined
    ? '\nslippage cap: <b>protocol floor</b> (on-chain minimum)'
    : `\nslippage cap: <b>${(bps / 100).toFixed(2)}%</b>`;

// ── Phoenix Check — the piece no other trading bot has ──────────────────────
// The API returns a deterministic, NON-LLM verdict for every quote: the exact
// same invariants the site's swap panel enforces (one brain, two doors). It
// fails CLOSED — the headline verdict is never greener than its weakest check —
// so an agent, or a human, gets a safe/unsafe reading grounded in arithmetic
// instead of a vibe. We render it verbatim; we never soften or invent it.
const CHECK_ICON: Record<QuoteChecks['verdict'], string> = {
  ok: '🟢', caution: '🟡', danger: '🟠', blocked: '🔴',
};
const checksLine = (c?: QuoteChecks) => {
  if (!c) return '';
  return `\n\n🛡 <b>Phoenix Check — ${CHECK_ICON[c.verdict]} ${esc(c.verdict.toUpperCase(), 12)}</b>`
    + `\n• price impact ${CHECK_ICON[c.priceImpact.verdict]} ${(c.priceImpact.bps / 100).toFixed(2)}%`
    + ` (hard line ${(c.priceImpact.hardLineBps / 100).toFixed(0)}%)`
    + `\n• iron floor ${c.ironFloor.armed ? '✅ armed on-chain — Router reverts below it' : '— not armed'}`
    + `\n• cross-check ${c.crossCheck.reproducible ? '✅ reproducible against the chain' : '— unavailable'}`;
};

// ── Connecting a wallet, without the bot ever touching one ──────────────────
// There is no such thing as "connecting a wallet TO a Telegram bot", and any
// bot that claims otherwise is asking for a key or a seed phrase. What actually
// works is opening the dApp where the wallet already lives:
//
//   • WEB APP button — opens the site INSIDE Telegram (Mini App). The normal
//     wallet connection runs there: WalletConnect and every injected wallet,
//     300+ of them. The connection is between the user and their wallet; the
//     bot is not a party to it and never sees a key or a signature.
//   • URL button — the same page in the system browser or a wallet's own
//     in-app browser, for clients where the Mini App is unavailable.
//
// Both land on a page with the trade PRE-FILLED, so "connect" and "review the
// exact swap I was just quoted" are the same step.
// The keyless signing path. There is no way to sign a transaction "in a bot"
// without the bot holding a key — so instead the WebApp button opens the real
// site as a Telegram Mini App, INSIDE Telegram, with this exact trade pre-filled.
// The user connects their own wallet there and signs there; the signature never
// passes through the bot, which is why it can be trustless. "Sign in Telegram"
// is literally true — the Mini App is Telegram — and still zero-custody.
const swapBtn = (
  sdkChain: string, tokenIn: string, tokenOut: string,
  amount?: string, presets = false,
) => {
  const link = deepLink({ chain: sdkChain, tokenIn, tokenOut, amount });
  const kb = new InlineKeyboard();
  // The pro-bot "quick buy" pattern — but every preset just PRE-FILLS the Mini
  // App at that size; you still sign in your own wallet. Convenience, not custody.
  if (presets) {
    for (const a of ['0.05', '0.1', '0.5', '1']) {
      kb.webApp(`⚡ ${a} ETH`, deepLink({ chain: sdkChain, tokenIn: 'ETH', tokenOut, amount: a }));
    }
    kb.row();
  }
  return kb
    .webApp('⚡ Review & sign in Telegram', link).row()
    .url('🌐 Open in my wallet browser', link).row()
    .url('𝕏 Twitter / X', BRAND.x)
    .url('✈️ Telegram', BRAND.telegram);
};

// Inline-message variant: keyboards on messages sent via inline mode land in
// OTHER people's chats, where Telegram forbids web_app buttons — so this uses
// URL buttons only. The link still opens the trade in the user's own wallet.
const swapUrlBtn = (sdkChain: string, tokenIn: string, tokenOut: string, amount?: string) => {
  const link = deepLink({ chain: sdkChain, tokenIn, tokenOut, amount });
  return new InlineKeyboard()
    .url('⚡ Open & sign in your wallet', link).row()
    .url('𝕏 Twitter / X', BRAND.x)
    .url('✈️ Telegram', BRAND.telegram);
};



// ── SECURITY: escaping untrusted text before it enters an HTML message ──────
// The replies use parse_mode HTML, and two kinds of text reach them that we do
// not control: what a user typed after a command, and what an indexer returned
// (symbols, dex names — ultimately written by whoever deployed the token).
//
// Without escaping, anyone in a group could send
//   /scan <a href="https://evil.example">Claim your airdrop</a>
// and the bot would render a clickable phishing link INSIDE a message wearing
// our name and logo. That is worse than an ordinary scam post, because the
// brand is doing the vouching. Unbalanced tags are the milder version: the
// message simply fails to send.
//
// So every interpolated value that did not originate in this file goes through
// esc(). Telegram's HTML mode needs three characters escaped; length is capped
// too, so a wall of text cannot push the real content off the screen.
const esc = (v: unknown, max = 64) =>
  String(v ?? '')
    .slice(0, max)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// ── Market context (DexScreener) ─────────────────────────────────────────────
// Our own quote is the on-chain truth about EXECUTION — what you would actually
// receive. It deliberately says nothing about the market around it: volume, the
// 24h move, how deep the pools are, how old the pair is. Those live with the
// indexers, so the bot reads them from DexScreener's free public API and prints
// both side by side.
//
// Keeping them SEPARATE and labelled is the whole point: the execution number
// is reproducible against the chain, the market context is a third party's
// reading, and a user is entitled to know which is which.
interface Market {
  priceUsd?: number; liqUsd?: number; vol24?: number; chg24?: number;
  dex?: string; url?: string; ageDays?: number;
}

async function market(addressOrSymbol: string, dexChain: string): Promise<Market | null> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(addressOrSymbol)}`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!res.ok) return null;
    const json = await res.json() as { pairs?: Array<Record<string, any>> };
    // Deepest pool on the SELECTED chain — the one an execution would touch.
    const best = (json.pairs ?? [])
      .filter((p) => p.chainId === dexChain)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (!best) return null;
    return {
      priceUsd: Number(best.priceUsd) || undefined,
      liqUsd: best.liquidity?.usd,
      vol24: best.volume?.h24,
      chg24: best.priceChange?.h24,
      dex: best.dexId,
      url: typeof best.url === 'string' && best.url.startsWith('https://dexscreener.com/') ? best.url : undefined,
      ageDays: best.pairCreatedAt ? Math.floor((Date.now() - Number(best.pairCreatedAt)) / 86_400_000) : undefined,
    };
  } catch { return null; }   // market context is a bonus, never a dependency
}

const usd = (n?: number) =>
  n === undefined ? '?'
    : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M`
    : n >= 1e3 ? `$${Math.round(n / 1e3)}K`
    : `$${n < 1 ? n.toPrecision(3) : n.toFixed(2)}`;

function marketLine(m: Market | null): string {
  if (!m) return '';
  const move = m.chg24 === undefined ? '' : ` ${m.chg24 >= 0 ? '▲' : '▼'}${Math.abs(m.chg24).toFixed(1)}% 24h`;
  const age = m.ageDays === undefined ? '' : ` · pool ${m.ageDays}d old`;
  return `\n📊 ${usd(m.priceUsd)}${move}\n   ${usd(m.liqUsd)} liq · ${usd(m.vol24)} 24h vol · ${esc(m.dex ?? '?', 24)}${age}`;
}

// ── Whale alerts ─────────────────────────────────────────────────────────────
// A fill only becomes news above a size, and "big" is a matter of taste, so it
// is a knob rather than a hard-coded number. Set WHALE_MIN_USD to the size that
// would make YOU look up. Below it the fill still streams; it just does not
// shout.
const WHALE_MIN_USD = Number(process.env.WHALE_MIN_USD ?? 10_000);

bot.command('start', (ctx) => ctx.replyWithPhoto(BRAND.card, {
  caption: card(
    'Phoenix Bot — on-chain quotes, zero custody',
    '<code>/price</code> [SYM] — execution price + live market data\n'
    + '<code>/quote</code> AMT IN OUT — e.g. <code>/quote 0.5 ETH USDC</code>\n'
    + '<code>/chain</code> [NAME] — switch chain (Base · Ethereum · Optimism · Arbitrum · Robinhood)\n'
    + '<code>/slippage</code> [%] — set your slippage cap (or <code>auto</code>)\n'
    + '<code>/scan</code> TOKEN — is the advertised liquidity really there?\n'
    + '<code>/watch</code> — real fills, with 🐋 alerts on the big ones\n'
    + '<code>/stop</code> — stop the stream\n'
    + '<code>/connect</code> — open the app and connect your wallet\n'
    + '<code>/links</code> — website · X · Telegram\n\n'
    + 'I never hold keys. Every swap executes in <b>YOUR</b> wallet.',
  ),
  parse_mode: 'HTML',
  reply_markup: new InlineKeyboard()
    .webApp('⚡ Open BlazePhoenix', BRAND.site).row()
    .url('𝕏 Twitter / X', BRAND.x)
    .url('✈️ Telegram', BRAND.telegram),
}));

// ── /links — the three official places, nothing else ships under our name ────
bot.command('links', (ctx) => ctx.reply(
  card('BlazePhoenix — official links',
    'These are the ONLY official channels. Anything else using our name is not us.\n\n'
    + linksFooter,
    'Nobody here will ever DM you first or ask for a seed phrase.'),
  { ...HTML, reply_markup: linksRow() },
));

// ── /chain — switch which chain every quote runs on ─────────────────────────
// Both a typed path (`/chain arbitrum`) and a tappable one (buttons below) —
// same state either way. The current chain wears a ✅.
const chainKeyboard = (current: string) => {
  const kb = new InlineKeyboard();
  Object.keys(CHAINS).forEach((k, i) => {
    kb.text(`${k === current ? '✅ ' : ''}${CHAINS[k].label}`, `chain:${k}`);
    if (i % 2 === 1) kb.row();
  });
  return kb;
};

bot.command('chain', (ctx) => {
  const arg = (ctx.match || '').trim().toLowerCase();
  if (arg) {
    const key = CHAIN_ALIAS[arg];
    if (!key) return ctx.reply(`unknown chain "${esc(arg, 24)}" — try base, ethereum, optimism, arbitrum or robinhood`);
    chatChain.set(ctx.chat.id, key);
  }
  const cur = chainKeyOf(ctx);
  return ctx.reply(
    card('Chain', `quoting on <b>${CHAINS[cur].label}</b> — tap to switch:`),
    { ...HTML, reply_markup: chainKeyboard(cur) },
  );
});

bot.callbackQuery(/^chain:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  if (!CHAINS[key] || !ctx.chat) return void ctx.answerCallbackQuery('unknown chain');
  chatChain.set(ctx.chat.id, key);
  await ctx.answerCallbackQuery(`now on ${CHAINS[key].label}`);
  await ctx.editMessageText(
    card('Chain', `quoting on <b>${CHAINS[key].label}</b> — tap to switch:`),
    { ...HTML, reply_markup: chainKeyboard(key) },
  ).catch(() => {});
});

// ── /slippage — set the cap the Router enforces on your behalf ───────────────
const SLIP_OPTS: Array<[string, string, number | undefined]> = [
  ['0.1%', 'slip:10', 10], ['0.5%', 'slip:50', 50],
  ['1%', 'slip:100', 100], ['3%', 'slip:300', 300],
  ['Auto (on-chain floor)', 'slip:auto', undefined],
];
const slipKeyboard = (cur?: number) => {
  const kb = new InlineKeyboard();
  SLIP_OPTS.forEach(([label, data, bps], i) => {
    kb.text(`${bps === cur ? '✅ ' : ''}${label}`, data);
    if (i % 2 === 1) kb.row();
  });
  return kb;
};

bot.command('slippage', (ctx) => {
  const arg = (ctx.match || '').trim().toLowerCase();
  if (arg) {
    if (arg === 'auto' || arg === 'off') chatSlip.delete(ctx.chat.id);
    else {
      const pct = Number(arg.replace('%', ''));
      if (!Number.isFinite(pct) || pct < 0 || pct > 50) {
        return ctx.reply('give a percent between 0 and 50, e.g. /slippage 0.5  (or /slippage auto)');
      }
      chatSlip.set(ctx.chat.id, Math.round(pct * 100)); // percent → bps
    }
  }
  const cur = slipOf(ctx);
  return ctx.reply(
    card('Slippage', `${slipLine(cur).trim()} — tap to change:`),
    { ...HTML, reply_markup: slipKeyboard(cur) },
  );
});

bot.callbackQuery(/^slip:(.+)$/, async (ctx) => {
  if (!ctx.chat) return void ctx.answerCallbackQuery();
  const v = ctx.match[1];
  let bps: number | undefined;
  if (v === 'auto') chatSlip.delete(ctx.chat.id);
  else { bps = Number(v); chatSlip.set(ctx.chat.id, bps); }
  await ctx.answerCallbackQuery(bps === undefined ? 'protocol floor' : `${bps / 100}%`);
  await ctx.editMessageText(
    card('Slippage', `${slipLine(bps).trim()} — tap to change:`),
    { ...HTML, reply_markup: slipKeyboard(bps) },
  ).catch(() => {});
});

bot.command('price', async (ctx) => {
  const sym = (ctx.match || 'BZPX').trim().toUpperCase();
  const ch = chainOf(ctx);
  try {
    const q = await blaze.quote({
      chain: ch.sdk, tokenIn: 'WETH', tokenOut: sym, amountIn: 10n ** 18n,
      slippageBps: slipOf(ctx),
    });
    const addr = q.resolved?.tokenOut?.address ?? sym;
    const m = await market(addr, ch.dex);
    await ctx.reply(
      card(
        `${esc(sym, 16)} · price · ${ch.label}`,
        `⚡ <b>1 WETH → ${amountOf(q.amountOut, sym)} ${esc(sym, 16)}</b>\n`
        + `${impactLine(q.quote?.impactBps)}\n`
        + `est gas ${q.quote?.estGas ?? '?'}`
        + marketLine(m)
        + checksLine(q.checks)
        + `\n\n${linksFooter}`,
        '⚡ on-chain execution (reproducible) · 📊 DexScreener market reading',
      ),
      { ...HTML, reply_markup: swapBtn(ch.sdk, 'ETH', sym, undefined, true) },
    );
  } catch (e) {
    await ctx.reply(`no route for ${esc(sym, 16)} on ${ch.label} right now`);
  }
});

// ── /token (alias /call) — a shareable "token call" card for a group ────────
// The "group call" meta-pattern of the custodial bots, done honestly: ONE card
// that fuses the on-chain price + Phoenix Check + Pool X-Ray safety + market
// context. Buttons are URL-only (Telegram forbids web_app buttons in groups),
// so the card works posted anywhere, and every quick-buy still opens the trade
// in the READER's own wallet. A "Share" button forwards it via inline mode.
async function xrayOf(sdkChain: string, token: string): Promise<any | null> {
  try {
    const res = await fetch(
      `https://blazephoenix.xyz/api/xray?chain=${sdkChain}&token=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(12_000) },
    );
    const j = await res.json() as any;
    return j?.ok ? j : null;
  } catch { return null; }
}

async function sendTokenCall(ctx: any, sym: string, chainKey?: string) {
  const ch = chainKey && CHAINS[chainKey] ? CHAINS[chainKey] : chainOf(ctx);
  let q;
  try {
    q = await blaze.quote({
      chain: ch.sdk, tokenIn: 'WETH', tokenOut: sym, amountIn: 10n ** 18n,
      slippageBps: slipOf(ctx),
    });
  } catch { return ctx.reply(`no route for ${esc(sym, 16)} on ${ch.label} right now`); }

  const addr = q.resolved?.tokenOut?.address ?? sym;
  const [m, xray] = await Promise.all([market(addr, ch.dex), xrayOf(ch.sdk, addr)]);
  const s = xray?.summary;
  const xrayLine = s
    ? `\n\n🔬 <b>Pool X-Ray</b>: advertised ${usd(s.reportedLiquidityUsd)} · real ${usd(s.realLiquidityUsd)}`
      + ` · phantom <b>${s.phantomPct ?? '?'}%</b> · <code>${esc(s.verdict ?? 'insufficient_data', 24)}</code>`
    : '';

  const kb = new InlineKeyboard();
  for (const a of ['0.1', '0.5', '1']) {
    kb.url(`⚡ ${a} ETH`, deepLink({ chain: ch.sdk, tokenIn: 'ETH', tokenOut: sym, amount: a }));
  }
  kb.row()
    .url('🌐 Open & sign in wallet', deepLink({ chain: ch.sdk, tokenIn: 'ETH', tokenOut: sym })).row()
    .switchInline('📢 Share to a group', `1 ETH ${sym}`).row()
    .url('𝕏 Twitter / X', BRAND.x).url('✈️ Telegram', BRAND.telegram);

  await ctx.reply(
    card(
      `${esc(sym, 16)} · call · ${ch.label}`,
      `⚡ <b>1 WETH → ${amountOf(q.amountOut, sym)} ${esc(sym, 16)}</b>\n`
      + `${impactLine(q.quote?.impactBps)}`
      + marketLine(m)
      + checksLine(q.checks)
      + xrayLine
      + `\n\n${linksFooter}`,
      'On-chain price + safety, in one card. Zero custody — sign in your own wallet.',
    ),
    { ...HTML, reply_markup: kb },
  );
}

bot.command(['token', 'call'], (ctx) => {
  const sym = (ctx.match || '').trim().toUpperCase();
  if (!sym) return ctx.reply('usage: /token BZPX  — a shareable card about a token');
  return sendTokenCall(ctx, sym);
});

// Tap a token in the /hot board → its full call card, on the token's OWN chain.
bot.callbackQuery(/^call:([a-z]+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery(`loading ${ctx.match[2]}…`);
  const key = CHAINS[ctx.match[1]] ? ctx.match[1] : undefined;
  await sendTokenCall(ctx, ctx.match[2].toUpperCase(), key);
});

// ── /hot (alias /radar, /trending) — the hottest, most-traded tokens ────────
// Straight from the SAME feed the site's /radar publishes: DexScreener trending,
// gated to REAL liquidity on a chain we support. We serve the site's radar.json
// verbatim (one source of truth) and rank by 24h volume — "os mais traded". We
// publish reproducible facts, never a "safe/scam" verdict; tap a row for its
// full call card (price + Phoenix Check + Pool X-Ray).
async function fetchRadar(): Promise<any[]> {
  try {
    const res = await fetch('https://blazephoenix.xyz/radar.json', { signal: AbortSignal.timeout(8000) });
    const j = await res.json() as { tokens?: any[] };
    return Array.isArray(j?.tokens) ? j.tokens : [];
  } catch { return []; }
}
const RANK = (i: number) => ['🥇', '🥈', '🥉'][i] ?? `<b>${i + 1}.</b>`;

bot.command(['hot', 'radar', 'trending'], async (ctx) => {
  const tokens = await fetchRadar();
  if (!tokens.length) {
    return ctx.reply(
      card('Radar warming up',
        'The trending board is regenerating right now. Try again in a bit, or '
        + 'browse it on the site.', 'Reproducible facts, never a verdict.'),
      { ...HTML, reply_markup: new InlineKeyboard().webApp('📡 Open Radar', `${BRAND.site}/radar`) },
    );
  }
  // Most-traded first; unknown volume (e.g. the anchor before a live read) last.
  const top = tokens
    .slice()
    .sort((a, b) => (b.volume24Usd ?? -1) - (a.volume24Usd ?? -1))
    .slice(0, 8);

  // The signal no other board shows: how much of each token's advertised depth
  // is PHANTOM. One X-Ray per token, in parallel, best-effort — a token with hot
  // volume AND high phantom liquidity is exactly the trap this warns you about.
  const xrays = await Promise.all(top.map((t) =>
    xrayOf(CHAINS[CHAIN_ALIAS[t.chain] ?? 'base']?.sdk ?? 'base', t.address)));
  const phantomBadge = (p?: number) => p == null ? ''
    : p >= 50 ? `🔴 phantom ${p}%` : p >= 25 ? `🟠 phantom ${p}%`
    : p >= 10 ? `🟡 phantom ${p}%` : `🟢 phantom ${p}%`;

  const body = top.map((t, i) => {
    const chLabel = CHAINS[CHAIN_ALIAS[t.chain] ?? 'base']?.label ?? t.chain;
    const price = t.priceUsd != null ? usd(t.priceUsd) : '—';
    const liq = t.liquidityUsd != null ? `${usd(t.liquidityUsd)} liq` : 'liq —';
    const vol = t.volume24Usd != null ? `${usd(t.volume24Usd)} 24h` : (t.anchor ? 'home token' : 'vol —');
    const ph = phantomBadge(xrays[i]?.summary?.phantomPct);
    return `${RANK(i)} <b>${esc(t.symbol, 12)}</b> · ${esc(chLabel, 12)}\n`
      + `     ${price} · ${liq} · ${vol}`
      + (ph ? `\n     ${ph}` : '');
  }).join('\n');

  // One tappable button per token (rows of 2) → full call card on its own chain.
  const kb = new InlineKeyboard();
  top.forEach((t, i) => {
    const key = CHAIN_ALIAS[t.chain] ?? 'base';
    kb.text(`${['🥇', '🥈', '🥉'][i] ?? '•'} ${t.symbol}`.slice(0, 20), `call:${key}:${t.symbol}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().webApp('📡 Full Radar', `${BRAND.site}/radar`).switchInline('📢 Share', 'BZPX');

  await ctx.reply(
    card('🔥 Hot tokens · most traded',
      `<i>live from the BlazePhoenix Radar · real-liquidity gated</i>\n\n${body}\n\n${linksFooter}`,
      'Tap a token for its price + Phoenix Check + Pool X-Ray.'),
    { ...HTML, reply_markup: kb },
  );
});

bot.command('quote', async (ctx) => {
  const [amt, tIn, tOut] = (ctx.match || '').trim().split(/\s+/);
  if (!amt || !tIn || !tOut) return ctx.reply('usage: /quote 0.5 ETH USDC');
  const ch = chainOf(ctx);
  const inSym = tIn.toUpperCase();
  const outSym = tOut.toUpperCase();
  try {
    const q = await blaze.quote({
      chain: ch.sdk,
      tokenIn: inSym,
      tokenOut: outSym,
      amountIn: toBaseUnits(amt, decimalsOf(inSym)), // match the input token's decimals
      slippageBps: slipOf(ctx),
    });
    await ctx.reply(
      card(
        `Quote · ${ch.label}`,
        `<b>${esc(amt, 24)} ${esc(inSym, 16)} → ${amountOf(q.amountOut, outSym)} ${esc(outSym, 16)}</b>\n`
        + `${impactLine(q.quote?.impactBps)}`
        + `${slipLine(slipOf(ctx))}\n`
        + `route: ${q.quote?.hops} hop(s), ${q.quote?.legs} leg(s) · fee ${(q.quote?.feeBps ?? 28) / 100}%\n`
        + `surplus expected: ${q.quote?.hasSurplus ? 'yes → goes to <b>YOU</b>' : 'no'}`
        + floorLine(q.quote?.effectiveMinOut, outSym)
        + checksLine(q.checks)
        + `\n\n${linksFooter}`,
        'Phoenix Check is deterministic (no AI) and fails closed. Verify it against the chain.',
      ),
      { ...HTML, reply_markup: swapBtn(ch.sdk, inSym, outSym, amt) },
    );
  } catch (e) {
    await ctx.reply(`quote failed: ${esc((e as Error).message, 120)}`);
  }
});

// ── /connect — open the app, connect there, sign there ─────────────────────
bot.command('connect', (ctx) => {
  const link = deepLink({ chain: chainOf(ctx).sdk, tab: 'swap' });
  return ctx.replyWithPhoto(BRAND.logo, {
    caption: card(
      'Connect your wallet',
      'Connect it <b>in the app</b>, not to this bot.\n\n'
      + 'The button below opens BlazePhoenix inside Telegram. Connect there with '
      + 'MetaMask, Coinbase Wallet, Rabby, WalletConnect — 300+ wallets. Every '
      + 'transaction is signed by <b>YOU</b>, in your own wallet.\n\n'
      + '🔒 This bot holds no keys and never will. It cannot move your funds '
      + 'because it never touches them.',
      'Nobody here will ever ask for a seed phrase — anyone who does is not us.',
    ),
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard()
      .webApp('⚡ Open BlazePhoenix (in Telegram)', link).row()
      .url('🌐 Open in my wallet browser', link).row()
      .url('𝕏 Twitter / X', BRAND.x)
      .url('✈️ Telegram', BRAND.telegram),
  });
});

// ── /scan — is the advertised liquidity actually in the pools? ──────────────
// The check no contract scanner performs: compare the depth the market
// ADVERTISES against the balances the pool contracts actually hold. A token can
// pass every honeypot test and still be impossible to exit at size.
bot.command('scan', async (ctx) => {
  const token = (ctx.match || '').trim();
  if (!token) return ctx.reply('usage: /scan 0xTOKEN  (or a symbol)');
  // The value also lands in a URL we hand back as a button. Accept only what a
  // token reference can look like — an address or a ticker — so nothing can be
  // smuggled into the link we put our name on.
  if (!/^(0x[0-9a-fA-F]{40}|[A-Za-z0-9._-]{2,24})$/.test(token)) {
    return ctx.reply('that does not look like a token address or symbol');
  }
  const ch = chainOf(ctx);
  try {
    const res = await fetch(
      `https://blazephoenix.xyz/api/xray?chain=${ch.sdk}&token=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(12_000) },
    );
    const j = await res.json() as any;
    if (!j?.ok) return ctx.reply(`scan failed: ${esc(j?.error ?? 'unknown', 120)}`);
    const s = j.summary ?? {};
    await ctx.reply(
      card(
        `${esc(j.token?.symbol ?? token, 24)} · pool X-Ray · ${ch.label}`,
        `advertised <b>${usd(s.reportedLiquidityUsd)}</b> · real <b>${usd(s.realLiquidityUsd)}</b>\n`
        + `phantom <b>${s.phantomPct ?? '?'}%</b> · max safe trade ${usd(s.maxSafeTradeUsd)}\n`
        + `reading: <code>${esc(s.verdict ?? 'insufficient_data', 24)}</code>`
        + `\n\n${linksFooter}`,
        'Not a verdict on the project — the arithmetic, so you can decide.',
      ),
      {
        ...HTML,
        reply_markup: new InlineKeyboard()
          .webApp('🔍 Full scan', `${BRAND.site}/?tab=xray&chain=${ch.sdk}&token=${token}`),
      },
    );
  } catch (e) {
    await ctx.reply(`scan unavailable: ${esc((e as Error).message, 120)}`);
  }
});

// ── live fill stream (on-chain events, no backend) ──────────────────────────
const watchers = new Map<number, () => void>();

bot.command('watch', async (ctx) => {
  if (watchers.has(ctx.chat.id)) return ctx.reply('already watching — /stop to end');
  const ch = chainOf(ctx);
  const unwatch = await watchFills({
    chain: ch.sdk,
    rpcUrl: process.env.RPC_URL, // optional — public endpoints when unset
    onFill: async (f) => {
      // Price the fill in dollars so "big" means something. The market read is
      // best-effort: if the indexer is unreachable the fill still reports, just
      // without the 🐋 — we never invent a number to make an alert fire.
      const m = await market(f.tokenOut ?? '', ch.dex);
      const outUsd = m?.priceUsd
        ? Number(fromBaseUnits(f.amountOut.toString(), 18, 6)) * m.priceUsd
        : undefined;
      const whale = outUsd !== undefined && outUsd >= WHALE_MIN_USD;
      const txLink = ch.explorer ? `\n${ch.explorer}${f.txHash}` : `\ntx ${f.txHash}`;
      void ctx.reply(
        (whale ? `🐋 WHALE FILL — ${usd(outUsd)}\n` : '🟦 fill: ')
        + `${fmt(f.amountIn.toString(), 4)} → ${fmt(f.amountOut.toString(), 4)}`
        + ` (${f.legs} legs)`
        + (outUsd !== undefined && !whale ? ` ≈ ${usd(outUsd)}` : '')
        + txLink,
      );
    },
  });
  watchers.set(ctx.chat.id, unwatch);
  await ctx.reply(
    `👁 watching every BlazePhoenix fill on ${ch.label} — 🐋 alerts above ${usd(WHALE_MIN_USD)}.\n`
    + 'These are real on-chain events read straight from the Router, not a feed we curate. /stop to end',
  );
});

bot.command('stop', (ctx) => {
  watchers.get(ctx.chat.id)?.();
  watchers.delete(ctx.chat.id);
  return ctx.reply('stream stopped');
});

// ── /help & /menu — everything, one tap, for someone who knows no commands ──
// The simplest surface a bot can have: a single hub where every option is a
// button. A newcomer never has to learn a command; they tap. Settings that fit
// a keyboard (chain, slippage, connect, links) switch in place; the ones that
// need a value (price, quote, scan) show their one-line usage.
const HELP = card(
  'Phoenix Bot — all options',
  '<b>Prices &amp; trades</b>\n'
  + '<code>/price SYM</code> — 1 WETH → SYM, with market data + Phoenix Check\n'
  + '<code>/quote AMT IN OUT</code> — full quote (e.g. <code>/quote 0.5 ETH USDC</code>)\n'
  + '<code>/token SYM</code> — shareable call card (price + safety) for a group\n'
  + '<code>/hot</code> — hottest, most-traded tokens + 🫧 phantom-liquidity flags\n'
  + 'or type <code>@thisbot 0.5 ETH USDC</code> in ANY chat (inline)\n\n'
  + '<b>Settings</b> (tap, no typing)\n'
  + '<code>/chain</code> — Base · Ethereum · Optimism · Arbitrum · Robinhood\n'
  + '<code>/slippage</code> — 0.1% … 3% or the on-chain floor\n\n'
  + '<b>Safety &amp; live data</b>\n'
  + '<code>/scan TOKEN</code> — real vs advertised liquidity (Pool X-Ray)\n'
  + '<code>/watch</code> · <code>/stop</code> — stream real fills, 🐋 whale alerts\n\n'
  + '<b>About the project</b>\n'
  + '<code>/about</code> — what BlazePhoenix is\n'
  + '<code>/ask …</code> — Q&amp;A about the project (curated, no-AI, no guessing)\n\n'
  + '<b>Wallet</b>\n'
  + '<code>/connect</code> — connect &amp; sign in your OWN wallet\n'
  + '<code>/links</code> — website · X · Telegram\n\n'
  + '🔒 I never hold keys. Every swap is signed by <b>YOU</b>.',
  'Compute, don\'t trust.',
);
const menuKeyboard = (ctx: any) => new InlineKeyboard()
  .webApp('⚡ Open & swap', deepLink({ chain: chainOf(ctx).sdk, tab: 'swap' })).row()
  .text('⛓ Chain', 'menu:chain').text('🎚 Slippage', 'menu:slippage').row()
  .text('🔒 Connect', 'menu:connect').text('🔗 Links', 'menu:links').row()
  .url('𝕏 Twitter / X', BRAND.x).url('✈️ Telegram', BRAND.telegram);

// /help — the full text (kept out of a photo caption so it can never exceed
// Telegram's 1024-char caption limit). /menu — the logo + the same button hub,
// so the brand shows on the one screen a newcomer taps around.
bot.command('help', (ctx) => ctx.reply(HELP, { ...HTML, reply_markup: menuKeyboard(ctx) }));
bot.command('menu', (ctx) => ctx.replyWithPhoto(BRAND.logo, {
  caption: card('Phoenix Bot — all options',
    'Everything is a tap below. <code>/help</code> for the full guide.\n\n'
    + '🔒 Zero custody — every swap is signed by <b>YOU</b>.'),
  parse_mode: 'HTML',
  reply_markup: menuKeyboard(ctx),
}));

bot.callbackQuery('menu:chain', async (ctx) => {
  await ctx.answerCallbackQuery();
  const cur = chainKeyOf(ctx);
  await ctx.reply(card('Chain', `quoting on <b>${CHAINS[cur].label}</b> — tap to switch:`),
    { ...HTML, reply_markup: chainKeyboard(cur) });
});
bot.callbackQuery('menu:slippage', async (ctx) => {
  await ctx.answerCallbackQuery();
  const cur = slipOf(ctx);
  await ctx.reply(card('Slippage', `${slipLine(cur).trim()} — tap to change:`),
    { ...HTML, reply_markup: slipKeyboard(cur) });
});
bot.callbackQuery('menu:links', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(card('BlazePhoenix — official links',
    `These are the ONLY official channels.\n\n${linksFooter}`,
    'Nobody here will DM you first or ask for a seed phrase.'),
    { ...HTML, reply_markup: linksRow() });
});
bot.callbackQuery('menu:connect', async (ctx) => {
  await ctx.answerCallbackQuery();
  const link = deepLink({ chain: chainOf(ctx).sdk, tab: 'swap' });
  await ctx.reply(card('Connect your wallet',
    'Connect <b>in the app</b>, not to this bot. The button opens BlazePhoenix '
    + 'inside Telegram; you connect and sign there, in your own wallet. This bot '
    + 'holds no keys and never will.',
    'Nobody here will ever ask for a seed phrase.'),
    { ...HTML, reply_markup: new InlineKeyboard()
        .webApp('⚡ Open BlazePhoenix (in Telegram)', link).row()
        .url('🌐 Open in my wallet browser', link) });
});

// ── /about — what the project is ────────────────────────────────────────────
const ABOUT = card(
  'What is BlazePhoenix?',
  'An <b>on-chain DEX aggregator</b> on Base · Ethereum · Optimism · Arbitrum · '
  + 'Robinhood Chain. Every number it serves is computed on-chain by the Quoter '
  + 'contract — the quote you see is the price that executes.\n\n'
  + '• <b>Zero custody</b> — it never holds your keys or funds. You sign in your own wallet.\n'
  + '• <b>Phoenix Check</b> — a deterministic (no-AI) safety verdict on every quote, fails closed.\n'
  + '• <b>Pool X-Ray</b> — real vs advertised liquidity, so phantom depth can\'t trap you.\n'
  + '• <b>Fee 0.28%</b> on quoted output; execution surplus is fee-exempt → goes to <b>you</b>.\n'
  + '• <b>BZPX</b> — the protocol token on Base; staking backs a live on-chain <code>isSolvent()</code> proof.\n\n'
  + 'Ask me anything: <code>/ask is it safe?</code>',
  'Compute, don\'t trust.',
);
bot.command('about', (ctx) => ctx.replyWithPhoto(BRAND.logo, {
  caption: ABOUT,
  parse_mode: 'HTML',
  reply_markup: new InlineKeyboard()
    .webApp('⚡ Open BlazePhoenix', BRAND.site).row()
    .url('📚 Learn', `${BRAND.site}/learn`).url('🔎 Verify', `${BRAND.site}/verify`).row()
    .url('𝕏 Twitter / X', BRAND.x).url('✈️ Telegram', BRAND.telegram),
}));

// ── /ask — a mini knowledge engine about the project (NO LLM, NO key) ────────
// Faithful to the whole thesis: this is NOT a black-box model that could
// hallucinate — and it needs no API key, so it stays free and keyless like the
// rest of the bot. It matches your question against a FIXED, curated knowledge
// base by keyword overlap and answers with a link to verify. If nothing scores
// well enough it SAYS SO and points to the docs; it never invents an answer.
// For open-ended AI, the site publishes llms.txt so any agent can read it all.
interface QA { keys: string[]; a: string; more?: string; }
const KB: QA[] = [
  { keys: ['what', 'blazephoenix', 'project', 'phoenix', 'about'],
    a: 'BlazePhoenix is an on-chain DEX aggregator on 5 chains. Every quote is computed on-chain by the Quoter contract, so the price you see is the price that executes.',
    more: `${BRAND.site}/?tab=api` },
  { keys: ['custody', 'keys', 'seed', 'safe', 'custodial', 'hold', 'funds'],
    a: 'Zero custody. The bot never holds your keys or funds — it deep-links you into your OWN wallet, where you sign. It cannot lose what it never touches. Nobody here will ever ask for a seed phrase.' },
  { keys: ['fee', 'fees', 'cost', 'commission'],
    a: 'The protocol fee is 0.28% on quoted output. Any execution surplus (positive slippage) is fee-exempt and goes back to you.' },
  { keys: ['chain', 'chains', 'networks', 'base', 'ethereum', 'optimism', 'arbitrum', 'robinhood'],
    a: 'Five chains: Base, Ethereum, Optimism, Arbitrum and Robinhood Chain. Switch with /chain.' },
  { keys: ['check', 'phoenixcheck', 'verdict', 'safety', 'invariant'],
    a: 'Phoenix Check is a deterministic, non-LLM verdict on every quote (price impact, iron floor, cross-check). It fails closed — the headline is never greener than its weakest check.',
    more: `${BRAND.site}/learn` },
  { keys: ['xray', 'liquidity', 'phantom', 'depth', 'honeypot', 'scan'],
    a: 'Pool X-Ray compares the liquidity a token ADVERTISES against what the pools actually hold, and reports the phantom %. Run it with /scan TOKEN.',
    more: `${BRAND.site}/?tab=xray` },
  { keys: ['iron', 'law', 'floor', 'slippage', 'minimum', 'minout'],
    a: 'The Iron Law is the on-chain minimum-output floor the Router enforces: it reverts the trade rather than settle below it, whatever the market does. Set your cap with /slippage.',
    more: `${BRAND.site}/learn/what-is-slippage` },
  { keys: ['impact', 'priceimpact', 'move'],
    a: 'Price impact is the cost you cause yourself by trading against a finite pool — knowable before you sign. Slippage is the market moving after you sign, which the floor caps.',
    more: `${BRAND.site}/learn/price-impact-explained` },
  { keys: ['bzpx', 'token', 'tokenomics', 'supply'],
    a: 'BZPX is the protocol token, deployed on Base. Staking it backs a live on-chain isSolvent() proof you can read yourself.',
    more: `${BRAND.site}/solvency` },
  { keys: ['stake', 'staking', 'rewards', 'apr', 'yield'],
    a: 'Staking backs the protocol\'s solvency proof; the staking contract exposes isSolvent() on Base so anyone can verify it on-chain.',
    more: `${BRAND.site}/solvency` },
  { keys: ['kyc', 'signup', 'account', 'register', 'permission'],
    a: 'No KYC, no signup, no account. It is self-custodial and permissionless — you connect a wallet and trade.' },
  { keys: ['audit', 'audited', 'verify', 'trust', 'proof', 'reproduce'],
    a: 'Verify, don\'t trust: contracts are verified on the explorers, the quote is reproducible against the chain, and every Learn article ends with a command to reproduce its claims.',
    more: `${BRAND.site}/verify` },
  { keys: ['swap', 'trade', 'buy', 'sell', 'how', 'exchange'],
    a: 'Get a quote with /price SYM or /quote AMT IN OUT, then tap the button to open the trade in your own wallet and sign there. The bot never signs for you.' },
  { keys: ['api', 'sdk', 'developer', 'integrate', 'bot', 'agent', 'mcp'],
    a: 'There is a free, keyless Quote API + a TypeScript SDK (@blazephoenix/sdk) + an MCP server for agents. Same on-chain truth the bot and site read.',
    more: `${BRAND.site}/?tab=api` },
];
const answerQuestion = (text: string): QA | null => {
  const words = new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  if (!words.size) return null;
  let best: QA | null = null; let bestScore = 0;
  for (const qa of KB) {
    const score = qa.keys.reduce((s, k) => s + (words.has(k) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = qa; }
  }
  return bestScore >= 1 ? best : null; // below threshold → we don't guess
};
const replyAsk = (ctx: any, question: string) => {
  const hit = answerQuestion(question);
  if (!hit) {
    return ctx.reply(
      card('I don\'t want to guess',
        'I answer from a fixed, curated knowledge base and won\'t invent an answer. '
        + 'Try keywords like <i>custody, fee, chains, Phoenix Check, X-Ray, slippage, '
        + 'BZPX, KYC, audit, swap, API</i> — or read the full docs.',
        'Compute, don\'t trust — including me.'),
      { ...HTML, reply_markup: new InlineKeyboard()
          .url('📚 Docs', `${BRAND.site}/learn`).url('🤖 llms.txt', `${BRAND.site}/llms.txt`) },
    );
  }
  const kb = new InlineKeyboard();
  if (hit.more) kb.url('🔎 Read more', hit.more);
  return ctx.reply(card('BlazePhoenix', `${hit.a}\n\n${linksFooter}`),
    { ...HTML, reply_markup: kb });
};
bot.command('ask', (ctx) => {
  const q = (ctx.match || '').trim();
  if (!q) return ctx.reply('ask me about the project, e.g. /ask is it safe?  ·  /ask what is the fee?');
  return replyAsk(ctx, q);
});
// In private chats, a plain message (no command) is treated as a question too —
// so a newcomer can just type. In groups we stay quiet unless /ask is used.
bot.on('message:text', (ctx, next) => {
  if (ctx.chat.type !== 'private' || ctx.message.text.startsWith('/')) return next();
  return replyAsk(ctx, ctx.message.text);
});

// ── Inline mode — a quote in ANY chat, without adding the bot ───────────────
// The viral meta-pattern the custodial bots use for "group calls" — but ours
// carries no custody. Type "@thisbot 0.5 ETH USDC" anywhere; the result card
// drops the on-chain quote + a button that opens the trade in YOUR wallet.
// Inline queries have no per-chat state, so they run on Base with the floor.
bot.on('inline_query', async (ctx) => {
  const parts = ctx.inlineQuery.query.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return ctx.answerInlineQuery([], {
      cache_time: 5,
      button: { text: '⚡ Open BlazePhoenix', start_parameter: 'inline' },
    });
  }
  // "AMT IN OUT" or "IN OUT" (1 unit default).
  const hasAmt = /^\d*\.?\d+$/.test(parts[0]);
  const amt = hasAmt ? parts[0] : '1';
  const inSym = (hasAmt ? parts[1] : parts[0]).toUpperCase();
  const outSym = (hasAmt ? parts[2] : parts[1])?.toUpperCase();
  if (!outSym) return ctx.answerInlineQuery([], { cache_time: 5 });
  try {
    const q = await blaze.quote({
      chain: 'base', tokenIn: inSym, tokenOut: outSym,
      amountIn: toBaseUnits(amt, decimalsOf(inSym)),
    });
    const title = `${amt} ${inSym} → ${amountOf(q.amountOut, outSym)} ${outSym}`;
    const body = card(`${esc(inSym, 16)} → ${esc(outSym, 16)} · Base`,
      `<b>${esc(amt, 24)} ${esc(inSym, 16)} → ${amountOf(q.amountOut, outSym)} ${esc(outSym, 16)}</b>\n`
      + `${impactLine(q.quote?.impactBps)}`
      + checksLine(q.checks)
      + `\n\n${linksFooter}`,
      'On-chain quote · zero custody · sign in your own wallet.');
    const result = InlineQueryResultBuilder
      .article('q', `⚡ ${title}`, { description: 'On-chain quote · tap to share', reply_markup: swapUrlBtn('base', inSym, outSym, amt) })
      .text(body, HTML);
    await ctx.answerInlineQuery([result], { cache_time: 10 });
  } catch {
    await ctx.answerInlineQuery([
      InlineQueryResultBuilder
        .article('none', 'no route', { description: `no executable route for ${inSym} → ${outSym} on Base` })
        .text(`no route for ${esc(inSym, 16)} → ${esc(outSym, 16)} on Base`),
    ], { cache_time: 5 });
  }
});

// ── /stats — usage, for the owner ───────────────────────────────────────────
// Gated to ADMIN_ID (set it to your own Telegram id). If you leave ADMIN_ID
// unset it is open — fine while testing, lock it before you go public. Numbers
// are exactly what the bot measured; nothing is estimated or embellished.
const uptimeStr = (ms: number) => {
  const s = Math.floor(ms / 1000); const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
bot.command('stats', (ctx) => {
  if (ADMIN_ID && ctx.from?.id !== ADMIN_ID) return; // silent for non-owners
  const top = Object.entries(metrics.perCommand)
    .sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([c, n]) => `  /${esc(c, 16)} × ${n}`).join('\n') || '  (none yet)';
  return ctx.reply(
    card('📈 Bot stats',
      `uptime <b>${uptimeStr(Date.now() - metrics.startedAt)}</b>\n`
      + `unique users <b>${userSet.size}</b>\n`
      + `commands handled <b>${metrics.commands}</b>\n`
      + `inline queries <b>${metrics.inline}</b>\n\n`
      + `<b>by command</b>\n${top}`,
      METRICS_FILE ? 'Persisted across restarts.' : 'In-memory (set METRICS_FILE to persist).'),
    HTML,
  );
});

// The blue "Menu" button in every chat — the simplest possible discovery: tap
// it and Telegram lists every command with a description. Set once at startup.
async function registerCommands() {
  await bot.api.setMyCommands([
    { command: 'price', description: '1 WETH → SYM + market data + Phoenix Check' },
    { command: 'quote', description: 'full quote — /quote 0.5 ETH USDC' },
    { command: 'token', description: 'shareable token call card (for groups)' },
    { command: 'hot', description: 'hottest, most-traded tokens + phantom-liquidity flags' },
    { command: 'chain', description: 'switch chain (Base/Ethereum/Optimism/Arbitrum/Robinhood)' },
    { command: 'slippage', description: 'set your slippage cap' },
    { command: 'scan', description: 'Pool X-Ray — real vs advertised liquidity' },
    { command: 'watch', description: 'stream real fills with whale alerts' },
    { command: 'stop', description: 'stop the fill stream' },
    { command: 'connect', description: 'connect & sign in your own wallet' },
    { command: 'about', description: 'what BlazePhoenix is' },
    { command: 'ask', description: 'ask about the project (no-AI knowledge base)' },
    { command: 'links', description: 'website · X · Telegram' },
    { command: 'menu', description: 'all options, one tap' },
    { command: 'help', description: 'how everything works' },
  ]).catch(() => {}); // never let a transient API hiccup stop the bot from starting
}

registerCommands();
bot.start();
console.log('🔥 Phoenix Bot up — zero keys held, all truth on-chain.');
