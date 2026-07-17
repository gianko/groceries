import { Bot, type BotConfig, type Context } from "grammy";
import type { Config } from "./config.js";

export function createBot(
  config: Config,
  botConfig?: BotConfig<Context>,
): Bot {
  const bot = new Bot(config.telegramBotToken, botConfig);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const isAllowedUser =
      userId !== undefined && config.allowedUserIds.includes(userId);
    const isAllowedChat = chatId !== undefined && chatId === config.groupChatId;

    if (!isAllowedUser || !isAllowedChat) {
      return;
    }

    await next();
  });

  bot.command("ping", async (ctx) => {
    await ctx.reply("pong");
  });

  return bot;
}
