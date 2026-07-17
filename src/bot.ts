import { Bot, type BotConfig, type Context, GrammyError, InlineKeyboard } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { finishLot } from "./finish.js";
import { fetchInStockLots, renderInventory } from "./inventory.js";

const FINISH_PREFIX = "finish:";
const FINISH_CALLBACK = new RegExp(`^${FINISH_PREFIX}(\\d+)$`);

function finishCallbackData(lotId: number): string {
  return `${FINISH_PREFIX}${lotId}`;
}

export function createBot(config: Config, db: Db, botConfig?: BotConfig<Context>): Bot {
  const bot = new Bot(config.telegramBotToken, botConfig);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const isAllowedUser = userId !== undefined && config.allowedUserIds.includes(userId);
    const isAllowedChat = chatId !== undefined && chatId === config.groupChatId;

    if (!isAllowedUser || !isAllowedChat) {
      return;
    }

    await next();
  });

  bot.command("ping", async (ctx) => {
    await ctx.reply("pong");
  });

  bot.command("inventory", async (ctx) => {
    const lots = fetchInStockLots(db);
    const chunks = renderInventory(lots);

    for (const chunk of chunks) {
      const keyboard = buildFinishKeyboard(chunk.lotIds);
      await ctx.reply(chunk.text, keyboard ? { reply_markup: keyboard } : undefined);
    }
  });

  bot.callbackQuery(FINISH_CALLBACK, async (ctx) => {
    const lotId = Number(ctx.match[1]);
    const didFinish = finishLot(db, lotId);

    await ctx.answerCallbackQuery(didFinish ? "Marked finished" : "Already finished");
    await removeFinishButton(ctx, lotId);
  });

  return bot;
}

function buildFinishKeyboard(lotIds: number[]): InlineKeyboard | undefined {
  if (lotIds.length === 0) {
    return undefined;
  }

  const keyboard = new InlineKeyboard();
  for (const lotId of lotIds) {
    keyboard.text("Finish", finishCallbackData(lotId)).row();
  }
  return keyboard;
}

// Drops only the tapped lot's button from the markup, so other lots' finish
// actions in the same message stay live.
function removeButtonFromMarkup(
  markup: InlineKeyboardMarkup,
  callbackData: string,
): InlineKeyboardMarkup | undefined {
  const rows = markup.inline_keyboard
    .map((row) =>
      row.filter((button) => !("callback_data" in button) || button.callback_data !== callbackData),
    )
    .filter((row) => row.length > 0);

  return rows.length === 0 ? undefined : { inline_keyboard: rows };
}

// A losing racer recomputes the identical edit and gets Telegram's "message
// is not modified" error, which is the expected no-op outcome, not a failure.
async function removeFinishButton(ctx: Context, lotId: number): Promise<void> {
  const markup = ctx.callbackQuery?.message?.reply_markup as InlineKeyboardMarkup | undefined;
  if (!markup) {
    return;
  }

  const newMarkup = removeButtonFromMarkup(markup, finishCallbackData(lotId));

  try {
    await ctx.editMessageReplyMarkup(newMarkup ? { reply_markup: newMarkup } : undefined);
  } catch (err) {
    if (err instanceof GrammyError && err.description.includes("not modified")) {
      return;
    }
    throw err;
  }
}
