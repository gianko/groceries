import { Bot, type BotConfig, type Context, GrammyError, InlineKeyboard } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { type Brain, BrainUnavailableError, type ReceiptExtraction } from "./brain.js";
import { type Clock, systemClock } from "./clock.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { finishLot } from "./finish.js";
import { fetchInStockLots, renderInventory } from "./inventory.js";
import { confirmReceipt, renderReceiptPreview } from "./receipt.js";

const FINISH_PREFIX = "finish:";
const FINISH_CALLBACK = new RegExp(`^${FINISH_PREFIX}(\\d+)$`);

const RECEIPT_CONFIRM = "receipt:confirm";
const RECEIPT_EDIT = "receipt:edit";
const RECEIPT_DISCARD = "receipt:discard";

const BUSY_MESSAGE = "🧠 busy, try again in a minute";
const RECEIPT_CAPTION = /^\/receipt(@\S+)?\b/;

function finishCallbackData(lotId: number): string {
  return `${FINISH_PREFIX}${lotId}`;
}

export type PhotoDownloader = (ctx: Context) => Promise<Buffer>;

export interface BotDeps {
  brain: Brain;
  clock?: Clock;
  downloadPhoto?: PhotoDownloader;
}

interface PendingReceipt {
  extraction: ReceiptExtraction;
  photo: Buffer;
  // Synchronously set true by whichever callback claims this pending receipt
  // first, before any await — the in-memory equivalent of finish.ts's
  // conditional UPDATE, so racing confirm/discard taps on the same message
  // can't both proceed. Cleared again if a claimed confirm fails, so a
  // Brain hiccup doesn't strand the pending receipt behind a permanent
  // "Already handled".
  claimed: boolean;
}

export function createBot(
  config: Config,
  db: Db,
  deps: BotDeps,
  botConfig?: BotConfig<Context>,
): Bot {
  const bot = new Bot(config.telegramBotToken, botConfig);
  const { brain } = deps;
  const clock = deps.clock ?? systemClock;
  const downloadPhoto = deps.downloadPhoto ?? createDefaultPhotoDownloader(config.telegramBotToken);

  // Photo bytes and the pending extraction live only in process memory, keyed
  // by the bot's own confirm-keyboard message ID: gone on confirm/discard,
  // and a restart drops everything cleanly (re-send the photo).
  const pendingReceipts = new Map<number, PendingReceipt>();

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

  bot.on("message:photo", async (ctx) => {
    const isReplyToBot = ctx.message.reply_to_message?.from?.id === ctx.me.id;
    const isReceiptCaption = RECEIPT_CAPTION.test(ctx.message.caption ?? "");
    if (!isReplyToBot && !isReceiptCaption) {
      return;
    }

    let photo: Buffer;
    try {
      photo = await downloadPhoto(ctx);
    } catch {
      await ctx.reply(BUSY_MESSAGE);
      return;
    }

    let extraction: ReceiptExtraction;
    try {
      extraction = await brain.extractReceipt(photo);
    } catch (err) {
      if (err instanceof BrainUnavailableError) {
        await ctx.reply(BUSY_MESSAGE);
        return;
      }
      throw err;
    }

    const sent = await ctx.reply(renderReceiptPreview(extraction), {
      reply_markup: buildReceiptKeyboard(),
    });
    pendingReceipts.set(sent.message_id, { extraction, photo, claimed: false });
  });

  bot.callbackQuery(RECEIPT_CONFIRM, async (ctx) => {
    const claim = claimPendingReceipt(pendingReceipts, ctx);
    if (!claim) {
      await ctx.answerCallbackQuery("Already handled");
      return;
    }

    try {
      await confirmReceipt(db, brain, clock, claim.pending.extraction);
    } catch (err) {
      if (err instanceof BrainUnavailableError) {
        // Nothing was written (confirmReceipt only writes after the Brain
        // call succeeds), so release the claim: the keyboard stays up and a
        // retry tap gets a fresh shot instead of a permanent "Already handled".
        claim.pending.claimed = false;
        await ctx.answerCallbackQuery(BUSY_MESSAGE);
        return;
      }
      throw err;
    }

    pendingReceipts.delete(claim.messageId);
    await ctx.answerCallbackQuery("Saved");
    await ctx.editMessageReplyMarkup();
  });

  bot.callbackQuery(RECEIPT_DISCARD, async (ctx) => {
    const claim = claimPendingReceipt(pendingReceipts, ctx);
    if (!claim) {
      await ctx.answerCallbackQuery("Already handled");
      return;
    }

    pendingReceipts.delete(claim.messageId);
    await ctx.answerCallbackQuery("Discarded");
    await ctx.editMessageReplyMarkup();
  });

  bot.callbackQuery(RECEIPT_EDIT, async (ctx) => {
    const messageId = ctx.callbackQuery.message?.message_id;
    const pending = messageId !== undefined ? pendingReceipts.get(messageId) : undefined;
    if (!pending || pending.claimed) {
      await ctx.answerCallbackQuery("Already handled");
      return;
    }

    // Leaves the pending receipt (and its photo) in place, unclaimed: the
    // reply-to-this-message handler below is what actually revises it.
    await ctx.answerCallbackQuery("Reply to this message with what to fix");
  });

  bot.on("message:text", async (ctx) => {
    const replyToMessageId = ctx.message.reply_to_message?.message_id;
    const isReplyToBot = ctx.message.reply_to_message?.from?.id === ctx.me.id;
    if (!isReplyToBot || replyToMessageId === undefined) {
      return;
    }

    const pending = pendingReceipts.get(replyToMessageId);
    if (!pending || pending.claimed) {
      return;
    }

    // Claimed for the duration of the revision so a racing confirm/discard
    // tap can't act on a photo/extraction pair that's mid-revision, then
    // released either way so the next round of the loop (or a final
    // confirm/discard) can proceed on the same message id.
    pending.claimed = true;

    let revised: ReceiptExtraction;
    try {
      revised = await brain.reviseReceipt(pending.extraction, ctx.message.text, pending.photo);
    } catch (err) {
      pending.claimed = false;
      if (err instanceof BrainUnavailableError) {
        await ctx.reply(BUSY_MESSAGE);
        return;
      }
      throw err;
    }

    pending.extraction = revised;
    pending.claimed = false;

    await ctx.api.editMessageText(ctx.chat.id, replyToMessageId, renderReceiptPreview(revised), {
      reply_markup: buildReceiptKeyboard(),
    });
  });

  return bot;
}

// Synchronous check-and-claim: since no await happens before the mutation,
// two racing confirm/discard taps on the same message can't both claim it.
// The entry itself is deleted by the caller once the decision is final
// (confirm succeeds, or discard) — not here — so a failed confirm can
// release the claim and leave the pending receipt intact for a retry.
function claimPendingReceipt(
  pendingReceipts: Map<number, PendingReceipt>,
  ctx: Context,
): { messageId: number; pending: PendingReceipt } | undefined {
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (messageId === undefined) {
    return undefined;
  }
  const pending = pendingReceipts.get(messageId);
  if (!pending || pending.claimed) {
    return undefined;
  }
  pending.claimed = true;
  return { messageId, pending };
}

function createDefaultPhotoDownloader(token: string): PhotoDownloader {
  return async (ctx) => {
    const photos = ctx.message?.photo;
    const largest = photos?.[photos.length - 1];
    if (!largest) {
      throw new Error("No photo on message");
    }

    const file = await ctx.api.getFile(largest.file_id);
    if (!file.file_path) {
      throw new Error("Telegram did not return a file path");
    }

    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to download photo: ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  };
}

function buildReceiptKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Confirm", RECEIPT_CONFIRM)
    .text("✏️ Edit", RECEIPT_EDIT)
    .text("❌ Discard", RECEIPT_DISCARD);
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
