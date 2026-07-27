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

import { Bot, InlineKeyboard } from 'grammy';
import {
  BlazePhoenix, deepLink, watchFills, toBaseUnits, fromBaseUnits,
} from '@blazephoenix/sdk';

const bot = new Bot(process.env.BOT_TOKEN!);
const blaze = new BlazePhoenix(); // retries + micro-cache built in (v0.3.0)

const CHAIN = 'base';
const fmt = (v: string, dp = 6) => fromBaseUnits(v, 6, dp); // USDC-style display


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
};

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
const floorLine = (q?: { effectiveMinOut?: string; ironFloor?: string }, dp = 4) => {
  if (!q?.effectiveMinOut) return '';
  return `\nguaranteed minimum <b>${fromBaseUnits(q.effectiveMinOut, 18, dp)}</b>`
    + ` — the Router reverts below this, whatever the market does`;
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
const swapBtn = (tokenIn: string, tokenOut: string, amount?: string) => {
  const link = deepLink({ chain: CHAIN, tokenIn, tokenOut, amount });
  return new InlineKeyboard()
    .webApp('⚡ Open & connect wallet (in Telegram)', link).row()
    .url('🌐 Open in my wallet browser', link);
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

async function market(addressOrSymbol: string): Promise<Market | null> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(addressOrSymbol)}`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!res.ok) return null;
    const json = await res.json() as { pairs?: Array<Record<string, any>> };
    // Deepest pool on OUR chain — the one an execution would actually touch.
    const best = (json.pairs ?? [])
      .filter((p) => p.chainId === CHAIN)
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
    + '<code>/scan</code> TOKEN — is the advertised liquidity really there?\n'
    + '<code>/watch</code> — real fills, with 🐋 alerts on the big ones\n'
    + '<code>/stop</code> — stop the stream\n'
    + '<code>/connect</code> — open the app and connect your wallet\n\n'
    + 'I never hold keys. Every swap executes in <b>YOUR</b> wallet.',
  ),
  parse_mode: 'HTML',
  reply_markup: new InlineKeyboard().webApp('⚡ Open BlazePhoenix', BRAND.site),
}));

bot.command('price', async (ctx) => {
  const sym = (ctx.match || 'BZPX').trim().toUpperCase();
  try {
    const q = await blaze.quote({
      chain: CHAIN, tokenIn: 'WETH', tokenOut: sym, amountIn: 10n ** 18n,
    });
    const addr = q.resolved?.tokenOut?.address ?? sym;
    const m = await market(addr);
    await ctx.reply(
      card(
        `${esc(sym, 16)} · price`,
        `⚡ <b>1 WETH → ${q.amountOut} ${esc(sym, 16)}</b>\n`
        + `${impactLine(q.quote?.impactBps)}\n`
        + `est gas ${q.quote?.estGas ?? '?'}`
        + marketLine(m),
        '⚡ on-chain execution (reproducible) · 📊 DexScreener market reading',
      ),
      { ...HTML, reply_markup: swapBtn('ETH', sym) },
    );
  } catch (e) {
    await ctx.reply(`no route for ${esc(sym, 16)} right now`);
  }
});

bot.command('quote', async (ctx) => {
  const [amt, tIn, tOut] = (ctx.match || '').trim().split(/\s+/);
  if (!amt || !tIn || !tOut) return ctx.reply('usage: /quote 0.5 ETH USDC');
  try {
    const q = await blaze.quote({
      chain: CHAIN,
      tokenIn: tIn.toUpperCase(),
      tokenOut: tOut.toUpperCase(),
      amountIn: toBaseUnits(amt, 18), // adjust decimals for non-18dp inputs
    });
    await ctx.reply(
      card(
        'Quote',
        `<b>${esc(amt, 24)} ${esc(tIn.toUpperCase(), 16)} → ${q.amountOut} ${esc(tOut.toUpperCase(), 16)}</b>\n`
        + `${impactLine(q.quote?.impactBps)}\n`
        + `route: ${q.quote?.hops} hop(s), ${q.quote?.legs} leg(s) · fee ${(q.quote?.feeBps ?? 28) / 100}%\n`
        + `surplus expected: ${q.quote?.hasSurplus ? 'yes → goes to <b>YOU</b>' : 'no'}`
        + floorLine(q.quote),
        'Impact is the cost you cause; the floor is your protection against the market moving.',
      ),
      { ...HTML, reply_markup: swapBtn(tIn.toUpperCase(), tOut.toUpperCase(), amt) },
    );
  } catch (e) {
    await ctx.reply(`quote failed: ${esc((e as Error).message, 120)}`);
  }
});

// ── /connect — open the app, connect there, sign there ─────────────────────
bot.command('connect', (ctx) => {
  const link = deepLink({ chain: CHAIN, tab: 'swap' });
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
      .url('🌐 Open in my wallet browser', link),
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
  try {
    const res = await fetch(
      `https://blazephoenix.xyz/api/xray?chain=${CHAIN}&token=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(12_000) },
    );
    const j = await res.json() as any;
    if (!j?.ok) return ctx.reply(`scan failed: ${esc(j?.error ?? 'unknown', 120)}`);
    const s = j.summary ?? {};
    await ctx.reply(
      card(
        `${esc(j.token?.symbol ?? token, 24)} · pool X-Ray`,
        `advertised <b>${usd(s.reportedLiquidityUsd)}</b> · real <b>${usd(s.realLiquidityUsd)}</b>\n`
        + `phantom <b>${s.phantomPct ?? '?'}%</b> · max safe trade ${usd(s.maxSafeTradeUsd)}\n`
        + `reading: <code>${esc(s.verdict ?? 'insufficient_data', 24)}</code>`,
        'Not a verdict on the project — the arithmetic, so you can decide.',
      ),
      {
        ...HTML,
        reply_markup: new InlineKeyboard()
          .webApp('🔍 Full scan', `${BRAND.site}/?tab=xray&chain=${CHAIN}&token=${token}`),
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
  const unwatch = await watchFills({
    chain: CHAIN,
    rpcUrl: process.env.RPC_URL, // optional — public endpoints when unset
    onFill: async (f) => {
      // Price the fill in dollars so "big" means something. The market read is
      // best-effort: if the indexer is unreachable the fill still reports, just
      // without the 🐋 — we never invent a number to make an alert fire.
      const m = await market(f.tokenOut ?? '');
      const outUsd = m?.priceUsd
        ? Number(fromBaseUnits(f.amountOut.toString(), 18, 6)) * m.priceUsd
        : undefined;
      const whale = outUsd !== undefined && outUsd >= WHALE_MIN_USD;
      void ctx.reply(
        (whale ? `🐋 WHALE FILL — ${usd(outUsd)}\n` : '🟦 fill: ')
        + `${fmt(f.amountIn.toString(), 4)} → ${fmt(f.amountOut.toString(), 4)}`
        + ` (${f.legs} legs)`
        + (outUsd !== undefined && !whale ? ` ≈ ${usd(outUsd)}` : '')
        + `\nhttps://basescan.org/tx/${f.txHash}`,
      );
    },
  });
  watchers.set(ctx.chat.id, unwatch);
  await ctx.reply(
    `👁 watching every BlazePhoenix fill on Base — 🐋 alerts above ${usd(WHALE_MIN_USD)}.\n`
    + 'These are real on-chain events read straight from the Router, not a feed we curate. /stop to end',
  );
});

bot.command('stop', (ctx) => {
  watchers.get(ctx.chat.id)?.();
  watchers.delete(ctx.chat.id);
  return ctx.reply('stream stopped');
});

bot.start();
console.log('🔥 Phoenix Bot up — zero keys held, all truth on-chain.');
