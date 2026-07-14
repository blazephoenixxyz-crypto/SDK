// Minimal Telegram price bot (grammY). npm i grammy && npx tsx examples/telegram-bot.ts
import { Bot } from 'grammy';
import { BlazePhoenix, deepLink } from '@blazephoenix/sdk';

const bot = new Bot(process.env.BOT_TOKEN!);
const blaze = new BlazePhoenix();

bot.command('price', async (ctx) => {
  try {
    const q = await blaze.quote({
      chain: 'base', tokenIn: 'WETH', tokenOut: 'BZPX', amountIn: 10n ** 18n,
    });
    await ctx.reply(
      `1 WETH → ${q.amountOut} BZPX (impact ${q.quote?.impactBps} bps)`,
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
    await ctx.reply(`no route right now (${String(e)})`);
  }
});

bot.start();
