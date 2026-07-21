import { Bot, type BotConfig, type Context, GrammyError, InlineKeyboard } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import cron from "node-cron";
import { confirmAddItems, renderAddPreview } from "./add.js";
import {
  type Brain,
  BrainUnavailableError,
  type FreeTextExtraction,
  type ReceiptExtraction,
  type RecipeSuggestion,
} from "./brain.js";
import buildInfo from "./build-info.json" with { type: "json" };
import { type Clock, systemClock } from "./clock.js";
import type { Config } from "./config.js";
import {
  addMissingIngredients,
  type CookIngredient,
  type CookRecipe,
  decrementForRecipe,
  fetchCoverableFavorites,
  fetchFavoriteRecipes,
  fetchFoodInventory,
  fetchStapleNames,
  rateRecipe,
  reclassifyRecipe,
  renderAlmostThereRecipe,
  renderCookingThisResult,
  renderCookTonight,
  renderFavoritesTonight,
  saveCookedRecipe,
  tierRecipes,
} from "./cook.js";
import type { Db } from "./db.js";
import {
  type DigestLot,
  digestQualifies,
  fetchExpiringSoonLots,
  fetchJustExpiredLots,
  markLotGone,
  markLotStillGood,
  markVerdictsAsked,
  renderExpiryDigest,
} from "./digest.js";
import { decideAutoRelist, finishLot } from "./finish.js";
import { fetchInStockLots, renderInventory } from "./inventory.js";
import { addManualEntry, fetchOpenEntries, renderList, type ShoppingListEntry } from "./list.js";
import { fetchPrefs, parsePrefsEdit, renderPrefs, savePrefs } from "./prefs.js";
import {
  applyKnownRawNames,
  type ConfirmReceiptResult,
  confirmReceipt,
  fetchCatalogNames,
  renderReceiptPreview,
} from "./receipt.js";
import { clearEntry, reconcileShoppingList, renderReconcilePrompt } from "./reconcile.js";
import {
  addCycleGuessEntry,
  type CycleGuess,
  computeCycleGuesses,
  fetchExpiringLots,
  renderShoppingSummary,
} from "./shopping.js";
import { setStaple } from "./staple.js";

const FINISH_PREFIX = "finish:";
const FINISH_CALLBACK = new RegExp(`^${FINISH_PREFIX}(\\d+)$`);

const RECEIPT_CONFIRM = "receipt:confirm";
const RECEIPT_EDIT = "receipt:edit";
const RECEIPT_DISCARD = "receipt:discard";

const ADD_CONFIRM = "add:confirm";
const ADD_EDIT = "add:edit";
const ADD_DISCARD = "add:discard";

const COOK_ADD_MISSING = "cook:addmissing";
const COOKING_THIS_PREFIX = "cook:cooking:";
const COOKING_THIS_CALLBACK = new RegExp(`^${COOKING_THIS_PREFIX}(\\d+)$`);

const COOK_RATE_PREFIX = "cook:rate:";
const COOK_RATE_CALLBACK = new RegExp(`^${COOK_RATE_PREFIX}(\\d+):(up|down)$`);

const SHOPPING_ADD_PREFIX = "shopping:add:";
const SHOPPING_ADD_CALLBACK = new RegExp(`^${SHOPPING_ADD_PREFIX}(\\d+)$`);
const SHOPPING_SKIP_PREFIX = "shopping:skip:";
const SHOPPING_SKIP_CALLBACK = new RegExp(`^${SHOPPING_SKIP_PREFIX}(\\d+)$`);

const RECONCILE_KEEP_PREFIX = "reconcile:keep:";
const RECONCILE_KEEP_CALLBACK = new RegExp(`^${RECONCILE_KEEP_PREFIX}(\\d+)$`);
const RECONCILE_CLEAR_PREFIX = "reconcile:clear:";
const RECONCILE_CLEAR_CALLBACK = new RegExp(`^${RECONCILE_CLEAR_PREFIX}(\\d+)$`);

const RELIST_PREFIX = "relist:";
const RELIST_CALLBACK = new RegExp(`^${RELIST_PREFIX}(yes|no):(\\d+)$`);

const DIGEST_GONE_PREFIX = "digest:gone:";
const DIGEST_GONE_CALLBACK = new RegExp(`^${DIGEST_GONE_PREFIX}(\\d+)$`);
const DIGEST_STILL_GOOD_PREFIX = "digest:still:";
const DIGEST_STILL_GOOD_CALLBACK = new RegExp(`^${DIGEST_STILL_GOOD_PREFIX}(\\d+)$`);
const DIGEST_COOK_IDEAS = "digest:cook";

const BUSY_MESSAGE = "🧠 busy, try again in a minute";
const RECEIPT_CAPTION = /^\/receipt(@\S+)?\b/;

function finishCallbackData(lotId: number): string {
  return `${FINISH_PREFIX}${lotId}`;
}

function cookingThisCallbackData(index: number): string {
  return `${COOKING_THIS_PREFIX}${index}`;
}

function cookRateCallbackData(recipeId: number, rating: "up" | "down"): string {
  return `${COOK_RATE_PREFIX}${recipeId}:${rating}`;
}

function shoppingAddCallbackData(index: number): string {
  return `${SHOPPING_ADD_PREFIX}${index}`;
}

function shoppingSkipCallbackData(index: number): string {
  return `${SHOPPING_SKIP_PREFIX}${index}`;
}

function reconcileKeepCallbackData(entryId: number): string {
  return `${RECONCILE_KEEP_PREFIX}${entryId}`;
}

function reconcileClearCallbackData(entryId: number): string {
  return `${RECONCILE_CLEAR_PREFIX}${entryId}`;
}

function relistCallbackData(answer: "yes" | "no", productId: number): string {
  return `${RELIST_PREFIX}${answer}:${productId}`;
}

function digestGoneCallbackData(lotId: number): string {
  return `${DIGEST_GONE_PREFIX}${lotId}`;
}

function digestStillGoodCallbackData(lotId: number): string {
  return `${DIGEST_STILL_GOOD_PREFIX}${lotId}`;
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

interface PendingAdd {
  extraction: FreeTextExtraction;
  // Same synchronous check-and-set claim as PendingReceipt.claimed. No photo
  // field — /add has nothing to hold beyond the parsed lines themselves.
  claimed: boolean;
}

interface PendingCookMissing {
  ingredients: CookIngredient[];
  // Same synchronous check-and-set claim as PendingReceipt.claimed.
  claimed: boolean;
}

interface PendingCookTonight {
  recipes: CookRecipe[];
  // One claim flag per recipe button on the message — each is an
  // independent first-tap-wins decision, same synchronous check-and-set
  // pattern as PendingReceipt.claimed.
  claimed: boolean[];
}

interface PendingShoppingGuesses {
  guesses: CycleGuess[];
  // One claim flag per add/skip pair — each Cycle Guess is an independent
  // first-tap-wins decision, same pattern as PendingCookTonight.claimed.
  claimed: boolean[];
}

export function createBot(
  config: Config,
  db: Db,
  deps: BotDeps,
  botConfig?: BotConfig<Context>,
): Bot {
  const bot = new Bot(config.telegramBotToken, botConfig);

  // Without this, grammY rethrows any handler error as an unhandled
  // rejection, which kills the whole process on a single bad update — one
  // Telegram API error (e.g. an invalid button) shouldn't take the bot down
  // for both household members.
  bot.catch((err) => {
    console.error("Unhandled bot error", err.error);
  });

  const { brain } = deps;
  const clock = deps.clock ?? systemClock;
  const downloadPhoto = deps.downloadPhoto ?? createDefaultPhotoDownloader(config.telegramBotToken);

  // Appends a row that opens the Mini App at `path`. The chat menu button
  // only ever shows in private chats with the bot, and Telegram rejects an
  // inline keyboard's `web_app` button type outside private chats too
  // (BUTTON_TYPE_INVALID) — so a plain URL button pointing at a `t.me`
  // deep link is the only way to reach a Mini App screen from group
  // messages. The Mini App itself resolves `startapp` back to `path`
  // client-side (see web/src/pages/index.astro).
  function addWebAppRow(keyboard: InlineKeyboard, label: string, path: string): InlineKeyboard {
    return keyboard.row().url(label, webAppDeepLink(bot.botInfo.username, path));
  }

  // Photo bytes and the pending extraction live only in process memory, keyed
  // by the bot's own confirm-keyboard message ID: gone on confirm/discard,
  // and a restart drops everything cleanly (re-send the photo).
  const pendingReceipts = new Map<number, PendingReceipt>();

  // Free-text /add extractions awaiting confirmation, keyed by the bot's own
  // confirm-keyboard message ID — same first-tap-wins/edit/discard shape as
  // pendingReceipts, minus the photo (there isn't one).
  const pendingAddItems = new Map<number, PendingAdd>();

  // Missing-ingredient lists for Almost-there recipes, keyed by the bot's own
  // reply message ID — one "add N missing items" decision per message,
  // exactly the receipt confirm/discard shape. Nothing is written to the
  // shopping list until the tap (per ADR-0002); a restart drops these
  // cleanly, same as pendingReceipts.
  const pendingCookMissing = new Map<number, PendingCookMissing>();

  // Cook Tonight recipes offered on the current /cook reply, keyed by that
  // message's ID — one "cooking this" decision per recipe button. The
  // decrement itself only happens on the tap (per ADR-0002); a restart
  // drops these cleanly, same as pendingReceipts.
  const pendingCookTonight = new Map<number, PendingCookTonight>();

  // Message ID of the most recent /prefs reply still open for editing. Only
  // the latest one stays live, so a reply to a stale /prefs message from
  // earlier in the chat history can't silently rewrite prefs; re-run /prefs
  // to get a fresh editable prompt. A restart drops this cleanly too.
  let pendingPrefsMessageId: number | undefined;

  // Cycle Guesses offered on the current /shopping reply, keyed by that
  // message's ID — one add/skip decision per guess. The cycle_guess entry is
  // only written on the "add" tap (per ADR-0002); a restart drops these
  // cleanly, same as pendingCookTonight.
  const pendingShoppingGuesses = new Map<number, PendingShoppingGuesses>();

  // Message ID of the most recent /shopping summary, so a reply to it can
  // append a last-minute item — unlike pendingPrefsMessageId this is never
  // "used up": either household member can reply to the same summary
  // multiple times, per the ticket's "anything else?" flow.
  let pendingShoppingMessageId: number | undefined;

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
    await ctx.reply(`pong (commit ${buildInfo.commit}, built ${buildInfo.buildDate})`);
  });

  bot.command("inventory", async (ctx) => {
    const lots = fetchInStockLots(db);
    const chunks = renderInventory(lots);

    for (const [index, chunk] of chunks.entries()) {
      const keyboard = buildFinishKeyboard(chunk.lotIds) ?? new InlineKeyboard();
      if (index === chunks.length - 1) {
        addWebAppRow(keyboard, "📋 Open in app", "/");
      }
      await ctx.reply(chunk.text, { reply_markup: keyboard });
    }
  });

  bot.command("list", async (ctx) => {
    const text = ctx.match.trim();
    if (text.length > 0) {
      addManualEntry(db, clock, text);
    }

    await ctx.reply(renderList(fetchOpenEntries(db)), {
      reply_markup: addWebAppRow(new InlineKeyboard(), "🛒 Open in app", "/shopping"),
    });
  });

  bot.command("staple", async (ctx) => {
    const name = ctx.match.trim();
    if (name.length === 0) {
      await ctx.reply("Usage: /staple <name>", {
        reply_markup: addWebAppRow(new InlineKeyboard(), "📌 Open in app", "/staples"),
      });
      return;
    }

    const result = setStaple(db, name);
    await ctx.reply(`📌 ${result.productName} is now a staple.`, {
      reply_markup: addWebAppRow(new InlineKeyboard(), "📌 Open in app", "/staples"),
    });
  });

  bot.command("shopping", async (ctx) => {
    const entries = fetchOpenEntries(db);
    const expiringLots = fetchExpiringLots(db, clock);
    const cycleGuesses = computeCycleGuesses(db, clock);

    const sent = await ctx.reply(renderShoppingSummary(entries, expiringLots, cycleGuesses), {
      reply_markup: buildShoppingGuessKeyboard(cycleGuesses),
    });

    pendingShoppingMessageId = sent.message_id;
    if (cycleGuesses.length > 0) {
      pendingShoppingGuesses.set(sent.message_id, {
        guesses: cycleGuesses,
        claimed: cycleGuesses.map(() => false),
      });
    }
  });

  bot.callbackQuery(SHOPPING_ADD_CALLBACK, async (ctx) => {
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number(ctx.match[1]);
    const pending = messageId !== undefined ? pendingShoppingGuesses.get(messageId) : undefined;
    const guess = pending?.guesses[index];
    if (!pending || guess === undefined || pending.claimed[index]) {
      await ctx.answerCallbackQuery("Already handled");
      return;
    }
    pending.claimed[index] = true;

    addCycleGuessEntry(db, clock, guess);

    await ctx.answerCallbackQuery("Added");
    await removeCallbackButtons(ctx, [
      shoppingAddCallbackData(index),
      shoppingSkipCallbackData(index),
    ]);
  });

  bot.callbackQuery(SHOPPING_SKIP_CALLBACK, async (ctx) => {
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number(ctx.match[1]);
    const pending = messageId !== undefined ? pendingShoppingGuesses.get(messageId) : undefined;
    if (!pending || pending.guesses[index] === undefined || pending.claimed[index]) {
      await ctx.answerCallbackQuery("Already handled");
      return;
    }
    pending.claimed[index] = true;

    await ctx.answerCallbackQuery("Skipped");
    await removeCallbackButtons(ctx, [
      shoppingAddCallbackData(index),
      shoppingSkipCallbackData(index),
    ]);
  });

  // Shared by /cook and the Expiry Digest's "Recipe ideas?" button — both
  // enter the exact same flow, per the ticket.
  async function runCookFlow(ctx: Context): Promise<void> {
    const inventory = fetchFoodInventory(db);
    const inventoryNames = new Set(inventory.map((item) => item.name.toLowerCase()));
    const stapleNames = fetchStapleNames(db);

    // The deterministic pass: liked recipes fully coverable by inventory go
    // out before any LLM call, per the ticket ("proven dinners beat LLM
    // experiments").
    const favorites = fetchFavoriteRecipes(db);
    const coverableFavorites = fetchCoverableFavorites(favorites, inventoryNames, stapleNames);

    if (coverableFavorites.length > 0) {
      const sent = await ctx.reply(renderFavoritesTonight(coverableFavorites), {
        reply_markup: buildCookingThisKeyboard(coverableFavorites),
      });
      pendingCookTonight.set(sent.message_id, {
        recipes: coverableFavorites,
        claimed: coverableFavorites.map(() => false),
      });
    }

    let suggestions: RecipeSuggestion[];
    try {
      suggestions = await brain.suggestRecipes({
        inventory: inventory.map((item) => ({
          name: item.name,
          category: "food",
          quantity: item.quantity,
          unit: item.unit,
          estExpiry: item.estExpiry,
        })),
        prefsBlurb: fetchPrefs(db).blurb,
        favoriteRecipeNames: favorites.map((f) => f.title),
      });
    } catch (err) {
      if (err instanceof BrainUnavailableError) {
        console.error("Brain unavailable", err.cause ?? err);
        await ctx.reply(BUSY_MESSAGE);
        return;
      }
      throw err;
    }

    const classified = suggestions.map((recipe) =>
      reclassifyRecipe(recipe, inventoryNames, stapleNames),
    );
    const { cookTonight, almostThere } = tierRecipes(classified);

    if (cookTonight.length === 0 && almostThere.length === 0) {
      await ctx.reply("🍽 No recipe ideas right now.", {
        reply_markup: addWebAppRow(new InlineKeyboard(), "🍳 Open in app", "/cook"),
      });
      return;
    }

    if (cookTonight.length > 0) {
      const sent = await ctx.reply(renderCookTonight(cookTonight), {
        reply_markup: addWebAppRow(
          buildCookingThisKeyboard(cookTonight),
          "🍳 Open in app",
          "/cook",
        ),
      });
      pendingCookTonight.set(sent.message_id, {
        recipes: cookTonight,
        claimed: cookTonight.map(() => false),
      });
    }

    for (const recipe of almostThere) {
      const missing = recipe.ingredients.filter((i) => !i.present);
      const sent = await ctx.reply(renderAlmostThereRecipe(recipe), {
        reply_markup: buildAddMissingKeyboard(missing.length),
      });
      pendingCookMissing.set(sent.message_id, { ingredients: missing, claimed: false });
    }
  }

  bot.command("cook", runCookFlow);

  bot.callbackQuery(DIGEST_COOK_IDEAS, async (ctx) => {
    await ctx.answerCallbackQuery();
    await runCookFlow(ctx);
  });

  bot.callbackQuery(COOK_ADD_MISSING, async (ctx) => {
    const messageId = ctx.callbackQuery.message?.message_id;
    const pending = messageId !== undefined ? pendingCookMissing.get(messageId) : undefined;
    if (!pending || pending.claimed) {
      await ctx.answerCallbackQuery("Already handled");
      return;
    }
    pending.claimed = true;

    const count = addMissingIngredients(db, clock, pending.ingredients);
    pendingCookMissing.delete(messageId!);

    await ctx.answerCallbackQuery(`Added ${count} item${count === 1 ? "" : "s"}`);
    await ctx.editMessageReplyMarkup();
  });

  bot.callbackQuery(COOKING_THIS_CALLBACK, async (ctx) => {
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number(ctx.match[1]);
    const pending = messageId !== undefined ? pendingCookTonight.get(messageId) : undefined;
    const recipe = pending?.recipes[index];
    if (!pending || recipe === undefined || pending.claimed[index]) {
      await ctx.answerCallbackQuery("Already handled");
      return;
    }
    pending.claimed[index] = true;

    const result = decrementForRecipe(db, recipe);
    const recipeId = saveCookedRecipe(db, clock, recipe);

    await ctx.answerCallbackQuery("Logged");
    await ctx.reply(renderCookingThisResult(recipe.title, result), {
      reply_markup: buildCookingResultKeyboard(
        result.finishConfirmations.map((lot) => lot.lotId),
        recipeId,
      ),
    });
    await removeCallbackButtons(ctx, [cookingThisCallbackData(index)]);
  });

  bot.callbackQuery(COOK_RATE_CALLBACK, async (ctx) => {
    const recipeId = Number(ctx.match[1]);
    const rating = ctx.match[2] === "up" ? "up" : "down";
    const didRate = rateRecipe(db, recipeId, rating);

    await ctx.answerCallbackQuery(didRate ? "Saved" : "Already rated");
    await removeCallbackButtons(ctx, [
      cookRateCallbackData(recipeId, "up"),
      cookRateCallbackData(recipeId, "down"),
    ]);
  });

  bot.command("prefs", async (ctx) => {
    const sent = await ctx.reply(renderPrefs(fetchPrefs(db)), {
      reply_markup: addWebAppRow(new InlineKeyboard(), "📌 Open in app", "/staples"),
    });
    pendingPrefsMessageId = sent.message_id;
  });

  bot.callbackQuery(FINISH_CALLBACK, async (ctx) => {
    const lotId = Number(ctx.match[1]);
    const result = finishLot(db, clock, lotId);

    await ctx.answerCallbackQuery(result.finished ? "Marked finished" : "Already finished");
    await removeCallbackButtons(ctx, [finishCallbackData(lotId)]);

    if (result.offerAutoRelist && result.productId !== null) {
      await ctx.reply(`🔁 Always re-add ${result.productName} once it's finished?`, {
        reply_markup: buildRelistKeyboard(result.productId),
      });
    }
  });

  bot.callbackQuery(RELIST_CALLBACK, async (ctx) => {
    const answer = ctx.match[1] === "yes" ? "yes" : "no";
    const productId = Number(ctx.match[2]);
    const didDecide = decideAutoRelist(db, productId, answer === "yes");

    await ctx.answerCallbackQuery(didDecide ? "Got it" : "Already answered");
    await removeCallbackButtons(ctx, [
      relistCallbackData("yes", productId),
      relistCallbackData("no", productId),
    ]);
  });

  bot.callbackQuery(DIGEST_GONE_CALLBACK, async (ctx) => {
    const lotId = Number(ctx.match[1]);
    const result = markLotGone(db, clock, lotId);

    await ctx.answerCallbackQuery(result.finished ? "Marked finished" : "Already handled");
    await removeCallbackButtons(ctx, [
      digestGoneCallbackData(lotId),
      digestStillGoodCallbackData(lotId),
    ]);

    if (result.offerAutoRelist && result.productId !== null) {
      await ctx.reply(`🔁 Always re-add ${result.productName} once it's finished?`, {
        reply_markup: buildRelistKeyboard(result.productId),
      });
    }
  });

  bot.callbackQuery(DIGEST_STILL_GOOD_CALLBACK, async (ctx) => {
    const lotId = Number(ctx.match[1]);
    const applied = markLotStillGood(db, clock, lotId);

    await ctx.answerCallbackQuery(applied ? "Pushed out a few days" : "Already handled");
    await removeCallbackButtons(ctx, [
      digestGoneCallbackData(lotId),
      digestStillGoodCallbackData(lotId),
    ]);
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
    } catch (err) {
      console.error("Photo download failed", err);
      await ctx.reply(BUSY_MESSAGE);
      return;
    }

    let extraction: ReceiptExtraction;
    try {
      extraction = await brain.extractReceipt(photo, fetchCatalogNames(db));
    } catch (err) {
      if (err instanceof BrainUnavailableError) {
        console.error("Brain unavailable", err.cause ?? err);
        await ctx.reply(BUSY_MESSAGE);
        return;
      }
      throw err;
    }
    extraction = applyKnownRawNames(db, extraction);

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

    let result: ConfirmReceiptResult;
    try {
      result = await confirmReceipt(db, brain, clock, claim.pending.extraction);
    } catch (err) {
      if (err instanceof BrainUnavailableError) {
        console.error("Brain unavailable", err.cause ?? err);
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

    // Product-linked list entries matched by this receipt's Products close
    // silently; leftover free-text entries go to a human via keep/clear
    // instead of a matcher (per the ticket, no fuzzy text matching).
    const reconciled = reconcileShoppingList(db, result.productIds);
    if (reconciled.leftoverFreeText.length > 0) {
      await ctx.reply(renderReconcilePrompt(reconciled.leftoverFreeText), {
        reply_markup: buildReconcileKeyboard(reconciled.leftoverFreeText),
      });
    }
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

  bot.command("add", async (ctx) => {
    const inlineText = ctx.match.trim();
    const repliedText = ctx.message?.reply_to_message?.text?.trim();
    const text = inlineText.length > 0 ? inlineText : repliedText;
    if (!text) {
      await ctx.reply("Usage: /add <items>, or reply to a message listing items with /add");
      return;
    }

    let extraction: FreeTextExtraction;
    try {
      extraction = await brain.parseFreeTextItems(text, fetchCatalogNames(db));
    } catch (err) {
      if (err instanceof BrainUnavailableError) {
        console.error("Brain unavailable", err.cause ?? err);
        await ctx.reply(BUSY_MESSAGE);
        return;
      }
      throw err;
    }

    const sent = await ctx.reply(renderAddPreview(extraction), {
      reply_markup: buildAddKeyboard(),
    });
    pendingAddItems.set(sent.message_id, { extraction, claimed: false });
  });

  bot.callbackQuery(ADD_CONFIRM, async (ctx) => {
    const claim = claimPendingAdd(pendingAddItems, ctx);
    if (!claim) {
      await ctx.answerCallbackQuery("Already handled");
      return;
    }

    try {
      await confirmAddItems(db, brain, clock, claim.pending.extraction);
    } catch (err) {
      if (err instanceof BrainUnavailableError) {
        console.error("Brain unavailable", err.cause ?? err);
        // Nothing was written (confirmAddItems only writes after the Brain
        // call succeeds), so release the claim for a retry, same as the
        // receipt confirm flow.
        claim.pending.claimed = false;
        await ctx.answerCallbackQuery(BUSY_MESSAGE);
        return;
      }
      throw err;
    }

    pendingAddItems.delete(claim.messageId);
    await ctx.answerCallbackQuery("Saved");
    await ctx.editMessageReplyMarkup();
  });

  bot.callbackQuery(ADD_DISCARD, async (ctx) => {
    const claim = claimPendingAdd(pendingAddItems, ctx);
    if (!claim) {
      await ctx.answerCallbackQuery("Already handled");
      return;
    }

    pendingAddItems.delete(claim.messageId);
    await ctx.answerCallbackQuery("Discarded");
    await ctx.editMessageReplyMarkup();
  });

  bot.callbackQuery(ADD_EDIT, async (ctx) => {
    const messageId = ctx.callbackQuery.message?.message_id;
    const pending = messageId !== undefined ? pendingAddItems.get(messageId) : undefined;
    if (!pending || pending.claimed) {
      await ctx.answerCallbackQuery("Already handled");
      return;
    }

    // Leaves the pending extraction in place, unclaimed: the reply-to-this-
    // message handler below is what actually revises it.
    await ctx.answerCallbackQuery("Reply to this message with what to fix");
  });

  bot.callbackQuery(RECONCILE_KEEP_CALLBACK, async (ctx) => {
    const entryId = Number(ctx.match[1]);
    await ctx.answerCallbackQuery("Kept");
    await removeCallbackButtons(ctx, [
      reconcileKeepCallbackData(entryId),
      reconcileClearCallbackData(entryId),
    ]);
  });

  bot.callbackQuery(RECONCILE_CLEAR_CALLBACK, async (ctx) => {
    const entryId = Number(ctx.match[1]);
    const didClear = clearEntry(db, entryId);

    await ctx.answerCallbackQuery(didClear ? "Cleared" : "Already handled");
    await removeCallbackButtons(ctx, [
      reconcileKeepCallbackData(entryId),
      reconcileClearCallbackData(entryId),
    ]);
  });

  bot.on("message:text", async (ctx) => {
    const replyToMessageId = ctx.message.reply_to_message?.message_id;
    const isReplyToBot = ctx.message.reply_to_message?.from?.id === ctx.me.id;
    if (!isReplyToBot || replyToMessageId === undefined) {
      return;
    }

    if (replyToMessageId === pendingPrefsMessageId) {
      const updated = savePrefs(db, parsePrefsEdit(ctx.message.text));
      await ctx.api.editMessageText(ctx.chat.id, replyToMessageId, renderPrefs(updated));
      return;
    }

    if (replyToMessageId === pendingShoppingMessageId) {
      addManualEntry(db, clock, ctx.message.text);
      await ctx.reply(renderList(fetchOpenEntries(db)));
      return;
    }

    const pendingAdd = pendingAddItems.get(replyToMessageId);
    if (pendingAdd && !pendingAdd.claimed) {
      // Same claim-for-the-duration-of-the-revision pattern as pendingReceipts
      // below, minus the photo (there isn't one to re-examine).
      pendingAdd.claimed = true;

      let revised: FreeTextExtraction;
      try {
        revised = await brain.reviseFreeTextItems(
          pendingAdd.extraction,
          ctx.message.text,
          fetchCatalogNames(db),
        );
      } catch (err) {
        pendingAdd.claimed = false;
        if (err instanceof BrainUnavailableError) {
          console.error("Brain unavailable", err.cause ?? err);
          await ctx.reply(BUSY_MESSAGE);
          return;
        }
        throw err;
      }

      pendingAdd.extraction = revised;
      pendingAdd.claimed = false;

      await ctx.api.editMessageText(
        ctx.chat.id,
        replyToMessageId,
        renderAddPreview(pendingAdd.extraction),
        { reply_markup: buildAddKeyboard() },
      );
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
      revised = await brain.reviseReceipt(
        pending.extraction,
        ctx.message.text,
        pending.photo,
        fetchCatalogNames(db),
      );
    } catch (err) {
      pending.claimed = false;
      if (err instanceof BrainUnavailableError) {
        console.error("Brain unavailable", err.cause ?? err);
        await ctx.reply(BUSY_MESSAGE);
        return;
      }
      throw err;
    }

    pending.extraction = applyKnownRawNames(db, revised);
    pending.claimed = false;

    await ctx.api.editMessageText(
      ctx.chat.id,
      replyToMessageId,
      renderReceiptPreview(pending.extraction),
      { reply_markup: buildReceiptKeyboard() },
    );
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

// Same synchronous check-and-claim as claimPendingReceipt, for the /add flow.
function claimPendingAdd(
  pendingAddItems: Map<number, PendingAdd>,
  ctx: Context,
): { messageId: number; pending: PendingAdd } | undefined {
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (messageId === undefined) {
    return undefined;
  }
  const pending = pendingAddItems.get(messageId);
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

// Telegram only passes a `startapp` token through a t.me deep link, not a
// path, so the root screen (no token needed) is the one path that can't
// round-trip through this — every other screen's start param is just its
// path with the leading slash stripped, matched back to a path client-side.
function webAppDeepLink(botUsername: string, path: string): string {
  const startParam = path === "/" ? undefined : path.slice(1);
  const base = `https://t.me/${botUsername}`;
  return startParam ? `${base}?startapp=${startParam}` : base;
}

function buildReceiptKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Confirm", RECEIPT_CONFIRM)
    .text("✏️ Edit", RECEIPT_EDIT)
    .text("❌ Discard", RECEIPT_DISCARD);
}

function buildAddKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Confirm", ADD_CONFIRM)
    .text("✏️ Edit", ADD_EDIT)
    .text("❌ Discard", ADD_DISCARD);
}

function buildAddMissingKeyboard(missingCount: number): InlineKeyboard {
  const label = `Add ${missingCount} missing item${missingCount === 1 ? "" : "s"}`;
  return new InlineKeyboard().text(label, COOK_ADD_MISSING);
}

function buildShoppingGuessKeyboard(guesses: CycleGuess[]): InlineKeyboard | undefined {
  if (guesses.length === 0) {
    return undefined;
  }

  const keyboard = new InlineKeyboard();
  guesses.forEach((guess, index) => {
    keyboard
      .text(`➕ ${guess.productName}`, shoppingAddCallbackData(index))
      .text("Skip", shoppingSkipCallbackData(index))
      .row();
  });
  return keyboard;
}

function buildReconcileKeyboard(entries: ShoppingListEntry[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const entry of entries) {
    keyboard
      .text("Keep", reconcileKeepCallbackData(entry.id))
      .text("Clear", reconcileClearCallbackData(entry.id))
      .row();
  }
  return keyboard;
}

function buildCookingThisKeyboard(recipes: CookRecipe[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  recipes.forEach((recipe, index) => {
    keyboard.text(`🍳 Cooking this: ${recipe.title}`, cookingThisCallbackData(index)).row();
  });
  return keyboard;
}

function addFinishRows(keyboard: InlineKeyboard, lotIds: number[]): InlineKeyboard {
  for (const lotId of lotIds) {
    keyboard.text("Finish", finishCallbackData(lotId)).row();
  }
  return keyboard;
}

function buildFinishKeyboard(lotIds: number[]): InlineKeyboard | undefined {
  if (lotIds.length === 0) {
    return undefined;
  }

  return addFinishRows(new InlineKeyboard(), lotIds);
}

function buildRelistKeyboard(productId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Yes", relistCallbackData("yes", productId))
    .text("No", relistCallbackData("no", productId));
}

// One gone/still-good row per just-expired Lot, plus a "Recipe ideas?" row
// that's always present once the digest qualifies at all (per the ticket,
// it jumps into /cook regardless of whether any Lot needs a verdict).
function buildDigestKeyboard(justExpired: DigestLot[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const lot of justExpired) {
    keyboard
      .text("🗑 Gone", digestGoneCallbackData(lot.lotId))
      .text("👌 Still good", digestStillGoodCallbackData(lot.lotId))
      .row();
  }
  keyboard.text("🍳 Recipe ideas?", DIGEST_COOK_IDEAS);
  return keyboard;
}

async function sendExpiryDigest(bot: Bot, db: Db, clock: Clock, chatId: number): Promise<void> {
  const expiringSoon = fetchExpiringSoonLots(db, clock);
  const justExpired = fetchJustExpiredLots(db, clock);
  if (!digestQualifies(expiringSoon, justExpired)) {
    return;
  }

  await bot.api.sendMessage(chatId, renderExpiryDigest(expiringSoon, justExpired), {
    reply_markup: buildDigestKeyboard(justExpired),
  });

  // Marked only after the send succeeds: the two writes can't be one
  // transaction (Telegram isn't transactional with sqlite), so the choice is
  // between "re-ask a Lot that already went out" and "never ask a Lot whose
  // send silently failed" if the process dies in between. The latter is
  // worse — a message never seen has no way to recover — so send first.
  markVerdictsAsked(
    db,
    clock,
    justExpired.map((lot) => lot.lotId),
  );
}

// A cron failure must never crash the bot process, same guarantee as
// scheduleNightlySnapshot — a missed digest is recoverable tomorrow, but a
// dead poll loop isn't. No LLM call sits anywhere in this path (per the
// ticket, the digest itself is LLM-free; the "Recipe ideas?" button is a
// human tap into a separate flow).
export function scheduleExpiryDigest(
  bot: Bot,
  db: Db,
  clock: Clock,
  chatId: number,
  cronExpression: string,
  tz: string,
): ReturnType<typeof cron.schedule> {
  return cron.schedule(
    cronExpression,
    () => {
      sendExpiryDigest(bot, db, clock, chatId).catch((err) => {
        console.error("Expiry digest failed", err);
      });
    },
    { timezone: tz },
  );
}

// Always carries the 👍/👎 rating prompt, plus a Finish row per Lot the
// decrement left below threshold — the rating prompt is not optional the way
// Finish rows are (per the ticket, the verdict is asked every time).
function buildCookingResultKeyboard(lotIds: number[], recipeId: number): InlineKeyboard {
  const keyboard = addFinishRows(new InlineKeyboard(), lotIds);
  keyboard
    .text("👍", cookRateCallbackData(recipeId, "up"))
    .text("👎", cookRateCallbackData(recipeId, "down"));
  return keyboard;
}

// Drops only the given buttons from the markup (by callback data), so other
// independent decisions packed into the same message — other lots' Finish
// buttons, the other half of a 👍/👎 pair — stay live.
function removeButtonsFromMarkup(
  markup: InlineKeyboardMarkup,
  callbackDataToRemove: string[],
): InlineKeyboardMarkup | undefined {
  const rows = markup.inline_keyboard
    .map((row) =>
      row.filter(
        (button) =>
          !("callback_data" in button) || !callbackDataToRemove.includes(button.callback_data),
      ),
    )
    .filter((row) => row.length > 0);

  return rows.length === 0 ? undefined : { inline_keyboard: rows };
}

// A losing racer recomputes the identical edit and gets Telegram's "message
// is not modified" error, which is the expected no-op outcome, not a failure.
async function removeCallbackButtons(ctx: Context, callbackData: string[]): Promise<void> {
  const markup = ctx.callbackQuery?.message?.reply_markup as InlineKeyboardMarkup | undefined;
  if (!markup) {
    return;
  }

  const newMarkup = removeButtonsFromMarkup(markup, callbackData);

  try {
    await ctx.editMessageReplyMarkup(newMarkup ? { reply_markup: newMarkup } : undefined);
  } catch (err) {
    if (err instanceof GrammyError && err.description.includes("not modified")) {
      return;
    }
    throw err;
  }
}
