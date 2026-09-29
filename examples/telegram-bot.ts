// Minimal Telegram price bot (grammY), quoting on YOUR node.
// npm i grammy viem @blazephoenix/sdk
// BOT_TOKEN=... BASE_RPC_URL=https://your-base-node npx tsx examples/telegram-bot.ts
import { Bot } from 'grammy';
import { BlazePhoenix, deepLink, fromBaseUnits } from '@blazephoenix/sdk';

const bot = new Bot(process.env.BOT_TOKEN!);
const blaze = new BlazePhoenix({ rpc: { base: process.env.BASE_RPC_URL! } });

bot.command('price', async (ctx) => {
  try {
    const q = await blaze.quote({ chain: 'base', tokenIn: 'WETH', tokenOut: 'BZPX', amount: '1' });
    await ctx.reply(
      `1 WETH → ${fromBaseUnits(q.amountOut, 18, 2)} BZPX (impact ${q.checks.priceImpact.bps} bps · ${q.checks.verdict})`,
      {
        reply_markup: {
          inline_keyboard: [[{
            text: '⚡ Swap on BlazePhoenix',
            url: deepLink({ chain: 'base', tokenIn: 'ETH', tokenOut: 'BZPX' }),
          }]],
        },
      },
    );
  } catch (e) {
    await ctx.reply(`no route right now (${(e as Error).message})`);
  }
});

bot.start();
