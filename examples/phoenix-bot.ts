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

const swapBtn = (tokenIn: string, tokenOut: string, amount?: string) =>
  new InlineKeyboard().url(
    '⚡ Swap in YOUR wallet (self-custodial)',
    deepLink({ chain: CHAIN, tokenIn, tokenOut, amount }),
  );

bot.command('start', (ctx) => ctx.reply(
  '🔥 Phoenix Bot — on-chain quotes, zero custody.\n\n'
  + '/price [SYM] — live price (default BZPX)\n'
  + '/quote AMT IN OUT — e.g. /quote 0.5 ETH USDC\n'
  + '/watch — stream real fills · /stop — stop\n\n'
  + 'I never hold keys. Every swap executes in YOUR wallet.',
));

bot.command('price', async (ctx) => {
  const sym = (ctx.match || 'BZPX').trim().toUpperCase();
  try {
    const q = await blaze.quote({
      chain: CHAIN, tokenIn: 'WETH', tokenOut: sym, amountIn: 10n ** 18n,
    });
    const via = q.resolved?.tokenOut
      ? `\n(resolved: ${q.resolved.tokenOut.address.slice(0, 10)}… · $${Math.round(q.resolved.tokenOut.liquidityUsd).toLocaleString()} liquidity)`
      : '';
    await ctx.reply(
      `1 WETH → ${q.amountOut} ${sym}` +
      `\nimpact ${q.quote?.impactBps ?? '?'} bps · est gas ${q.quote?.estGas ?? '?'}${via}`,
      { reply_markup: swapBtn('ETH', sym) },
    );
  } catch (e) {
    await ctx.reply(`no route for ${sym} right now (${(e as Error).message})`);
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
      `${amt} ${tIn.toUpperCase()} → ${q.amountOut} ${tOut.toUpperCase()}\n`
      + `impact ${q.quote?.impactBps} bps · ${q.quote?.hops} hop(s), ${q.quote?.legs} leg(s)\n`
      + `surplus expected: ${q.quote?.hasSurplus ? 'yes → goes to YOU' : 'no'}`,
      { reply_markup: swapBtn(tIn.toUpperCase(), tOut.toUpperCase(), amt) },
    );
  } catch (e) {
    await ctx.reply(`quote failed: ${(e as Error).message}`);
  }
});

// ── live fill stream (on-chain events, no backend) ──────────────────────────
const watchers = new Map<number, () => void>();

bot.command('watch', async (ctx) => {
  if (!process.env.RPC_URL) return ctx.reply('set RPC_URL to enable fill streaming');
  if (watchers.has(ctx.chat.id)) return ctx.reply('already watching — /stop to end');
  const unwatch = await watchFills({
    chain: CHAIN,
    rpcUrl: process.env.RPC_URL,
    onFill: (f) => {
      void ctx.reply(
        `🟦 fill: ${fmt(f.amountIn.toString(), 4)} → ${fmt(f.amountOut.toString(), 4)}`
        + ` (${f.legs} legs)\nhttps://basescan.org/tx/${f.txHash}`,
      );
    },
  });
  watchers.set(ctx.chat.id, unwatch);
  await ctx.reply('👁 watching every BlazePhoenix fill on Base — /stop to end');
});

bot.command('stop', (ctx) => {
  watchers.get(ctx.chat.id)?.();
  watchers.delete(ctx.chat.id);
  return ctx.reply('stream stopped');
});

bot.start();
console.log('🔥 Phoenix Bot up — zero keys held, all truth on-chain.');
