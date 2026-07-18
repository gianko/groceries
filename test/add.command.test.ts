import { eq } from "drizzle-orm";
import type { InlineKeyboardMarkup } from "grammy/types";
import { beforeEach, describe, expect, it } from "vitest";
import { BrainUnavailableError } from "../src/brain.js";
import type { Config } from "../src/config.js";
import { products, rawNameMap, stockLots } from "../src/db/schema.js";
import { fail, ok } from "./support/brainFake.js";
import { createTestHarness, type TestHarness } from "./support/harness.js";
import { callbackQueryUpdate, photoMessageUpdate, textMessageUpdate } from "./support/updates.js";

const ALLOWED_USER_A = 111;
const ALLOWED_USER_B = 222;
const GROUP_CHAT_ID = -1001234567890;
const BOT_USER_ID = 1;

const config: Config = {
  telegramBotToken: "test-token",
  geminiApiKey: "test-key",
  allowedUserIds: [ALLOWED_USER_A, ALLOWED_USER_B],
  groupChatId: GROUP_CHAT_ID,
  tz: "Europe/Dublin",
  dbPath: ":memory:",
  heartbeatPath: "heartbeat",
  heartbeatIntervalMs: 30_000,
  heartbeatStaleMs: 90_000,
  snapshotPath: "pantry.snapshot.db",
  snapshotCron: "0 3 * * *",
  digestCron: "0 17 * * *",
};

const sampleExtraction = {
  lines: [{ name: "baked beans", category: "food" as const, quantity: 2, unit: null }],
};

function findConfirmMarkup(harness: TestHarness): {
  messageId: number;
  markup: InlineKeyboardMarkup;
} {
  const call = harness.calls.find((c) => c.method === "sendMessage" && c.payload.reply_markup);
  return {
    messageId: 1000,
    markup: call!.payload.reply_markup as InlineKeyboardMarkup,
  };
}

describe("/add happy path", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness(config);
  });

  it("shows a confirm keyboard for /add with inline free text", async () => {
    harness.brain.scriptParseFreeTextItems(ok(sampleExtraction));

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "/add 2 tins baked beans",
      }),
    );

    expect(harness.calls).toHaveLength(1);
    const call = harness.calls[0]!;
    expect(call.method).toBe("sendMessage");
    expect(call.payload.text).toContain("baked beans");
    const markup = call.payload.reply_markup as InlineKeyboardMarkup;
    const buttonTexts = markup.inline_keyboard.flat().map((b) => b.text);
    expect(buttonTexts).toEqual(["✅ Confirm", "✏️ Edit", "❌ Discard"]);

    const parseCall = harness.brain.calls.find((c) => c.method === "parseFreeTextItems");
    expect(parseCall!.args[0]).toBe("2 tins baked beans");
  });

  it("uses the replied-to message's text when /add is sent bare as a reply", async () => {
    harness.brain.scriptParseFreeTextItems(ok(sampleExtraction));

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "/add",
        replyToUserMessageId: 55,
      }),
    );

    expect(harness.calls).toHaveLength(1);
    const parseCall = harness.brain.calls.find((c) => c.method === "parseFreeTextItems");
    expect(parseCall!.args[0]).toBe("some other message");
  });

  it("shows a usage message and calls the Brain not at all when /add has no text and no reply", async () => {
    await harness.handleUpdate(
      textMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID, text: "/add" }),
    );

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]!.payload.text).toContain("Usage");
    expect(harness.brain.calls).toEqual([]);
  });

  it("passes the current Catalog name list to the parse call", async () => {
    harness.db.insert(products).values({ name: "milk", category: "food" }).run();
    harness.brain.scriptParseFreeTextItems(ok(sampleExtraction));

    await harness.handleUpdate(
      textMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID, text: "/add rice" }),
    );

    const parseCall = harness.brain.calls.find((c) => c.method === "parseFreeTextItems");
    expect(parseCall!.args[1]).toEqual(expect.arrayContaining(["milk"]));
  });

  it("inserts Products and Lots on confirm, purchased today, with no Raw Name mapping, and nothing on discard", async () => {
    harness.brain.scriptParseFreeTextItems(ok(sampleExtraction));
    harness.brain.scriptEstimateShelfLife(ok([{ name: "baked beans", days: 400 }]));

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "/add 2 tins baked beans",
      }),
    );
    const { messageId, markup } = findConfirmMarkup(harness);

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "add:confirm",
        messageId,
        replyMarkup: markup,
      }),
    );

    expect(harness.db.select().from(products).all()).toHaveLength(1);
    expect(harness.db.select().from(stockLots).all()).toHaveLength(1);
    expect(harness.db.select().from(rawNameMap).all()).toHaveLength(0);

    const lot = harness.db.select().from(stockLots).all()[0]!;
    expect(lot.purchasedAt).toBe("2026-01-01");

    const answers = harness.calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers).toHaveLength(1);
    expect(answers[0]!.payload.text).toBe("Saved");
  });

  it("stores nothing on discard", async () => {
    harness.brain.scriptParseFreeTextItems(ok(sampleExtraction));

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "/add baked beans",
      }),
    );
    const { messageId, markup } = findConfirmMarkup(harness);

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "add:discard",
        messageId,
        replyMarkup: markup,
      }),
    );

    expect(harness.db.select().from(products).all()).toHaveLength(0);
    expect(harness.db.select().from(stockLots).all()).toHaveLength(0);

    const answers = harness.calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers[0]!.payload.text).toBe("Discarded");
  });

  it("names normalize against the existing Catalog instead of forking a new Product", async () => {
    harness.db
      .insert(products)
      .values({ name: "baked beans", category: "food", shelfLifeDays: 400 })
      .run();
    harness.brain.scriptParseFreeTextItems(ok(sampleExtraction));

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "/add beans, baked",
      }),
    );
    const { messageId, markup } = findConfirmMarkup(harness);

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "add:confirm",
        messageId,
        replyMarkup: markup,
      }),
    );

    expect(harness.db.select().from(products).all()).toHaveLength(1);
  });

  it("first tap wins on the confirm keyboard; the loser is a no-op", async () => {
    harness.brain.scriptParseFreeTextItems(ok(sampleExtraction));
    harness.brain.scriptEstimateShelfLife(ok([{ name: "baked beans", days: 400 }]));

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "/add baked beans",
      }),
    );
    const { messageId, markup } = findConfirmMarkup(harness);

    await Promise.all([
      harness.handleUpdate(
        callbackQueryUpdate({
          userId: ALLOWED_USER_A,
          chatId: GROUP_CHAT_ID,
          data: "add:confirm",
          messageId,
          replyMarkup: markup,
        }),
      ),
      harness.handleUpdate(
        callbackQueryUpdate({
          userId: ALLOWED_USER_B,
          chatId: GROUP_CHAT_ID,
          data: "add:discard",
          messageId,
          replyMarkup: markup,
        }),
      ),
    ]);

    expect(harness.db.select().from(stockLots).all()).toHaveLength(1);
    const answers = harness.calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.map((c) => c.payload.text)).toEqual(["Saved", "Already handled"]);
  });

  it("shows the busy message and stores nothing when the Brain fails on parse", async () => {
    harness.brain.scriptParseFreeTextItems(fail(new BrainUnavailableError("nope")));

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "/add baked beans",
      }),
    );

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]!.payload.text).toBe("🧠 busy, try again in a minute");
    expect(harness.db.select().from(products).all()).toHaveLength(0);
  });

  it("keeps the pending items and keyboard alive after a failed confirm, so a retry succeeds", async () => {
    harness.brain.scriptParseFreeTextItems(ok(sampleExtraction));
    harness.brain.scriptEstimateShelfLife(fail(new BrainUnavailableError("nope")));

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "/add baked beans",
      }),
    );
    const { messageId, markup } = findConfirmMarkup(harness);

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "add:confirm",
        messageId,
        replyMarkup: markup,
      }),
    );
    expect(harness.db.select().from(products).all()).toHaveLength(0);

    harness.brain.scriptEstimateShelfLife(ok([{ name: "baked beans", days: 400 }]));
    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "add:confirm",
        messageId,
        replyMarkup: markup,
      }),
    );

    expect(harness.db.select().from(products).all()).toHaveLength(1);
    const answers = harness.calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.map((c) => c.payload.text)).toEqual(["🧠 busy, try again in a minute", "Saved"]);
  });

  it("drops a pending confirmation across a restart", async () => {
    harness.brain.scriptParseFreeTextItems(ok(sampleExtraction));

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "/add baked beans",
      }),
    );
    const { messageId, markup } = findConfirmMarkup(harness);

    const restarted = createTestHarness(config, { brain: harness.brain });
    await restarted.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "add:confirm",
        messageId,
        replyMarkup: markup,
      }),
    );

    expect(restarted.db.select().from(products).all()).toHaveLength(0);
    const answers = restarted.calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers[0]!.payload.text).toBe("Already handled");
  });
});

describe("/add correction loop", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness(config);
  });

  const revisedExtraction = {
    lines: [{ name: "chopped tomatoes", category: "food" as const, quantity: 1, unit: null }],
  };

  it("acknowledges the Edit button without discarding the pending items", async () => {
    harness.brain.scriptParseFreeTextItems(ok(sampleExtraction));

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "/add baked beans",
      }),
    );
    const { messageId, markup } = findConfirmMarkup(harness);

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "add:edit",
        messageId,
        replyMarkup: markup,
      }),
    );

    const editAnswer = harness.calls.find(
      (c) => c.method === "answerCallbackQuery" && c.payload.text !== undefined,
    );
    expect(editAnswer!.payload.text).toContain("Reply to this message");

    harness.brain.scriptEstimateShelfLife(ok([{ name: "baked beans", days: 400 }]));
    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "add:confirm",
        messageId,
        replyMarkup: markup,
      }),
    );

    expect(harness.db.select().from(products).all()).toHaveLength(1);
  });

  it("re-shows a revised list with the same keyboard after a free-text reply to the /add message", async () => {
    harness.brain.scriptParseFreeTextItems(ok(sampleExtraction));

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "/add baked beans",
      }),
    );
    const { messageId } = findConfirmMarkup(harness);

    harness.brain.scriptReviseFreeTextItems(ok(revisedExtraction));
    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "it's chopped tomatoes, not baked beans",
        replyToBotMessageId: messageId,
        botUserId: BOT_USER_ID,
      }),
    );

    const reviseCall = harness.brain.calls.find((c) => c.method === "reviseFreeTextItems");
    expect(reviseCall!.args[0]).toEqual(sampleExtraction);
    expect(reviseCall!.args[1]).toBe("it's chopped tomatoes, not baked beans");

    const editCall = harness.calls.find((c) => c.method === "editMessageText");
    expect(editCall).toBeDefined();
    expect(editCall!.payload.text).toContain("chopped tomatoes");
    const markup = editCall!.payload.reply_markup as InlineKeyboardMarkup;
    expect(markup.inline_keyboard.flat().map((b) => b.text)).toEqual([
      "✅ Confirm",
      "✏️ Edit",
      "❌ Discard",
    ]);
  });

  it("stores the revised lines, not the originals, when confirmed after a correction", async () => {
    harness.brain.scriptParseFreeTextItems(ok(sampleExtraction));

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "/add baked beans",
      }),
    );
    const { messageId, markup } = findConfirmMarkup(harness);

    harness.brain.scriptReviseFreeTextItems(ok(revisedExtraction));
    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "it's chopped tomatoes",
        replyToBotMessageId: messageId,
        botUserId: BOT_USER_ID,
      }),
    );

    harness.brain.scriptEstimateShelfLife(ok([{ name: "chopped tomatoes", days: 5 }]));
    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "add:confirm",
        messageId,
        replyMarkup: markup,
      }),
    );

    const storedProducts = harness.db.select().from(products).all();
    expect(storedProducts).toHaveLength(1);
    expect(storedProducts[0]!.name).toBe("chopped tomatoes");
  });

  it("shows the busy message and keeps the original list when revision fails", async () => {
    harness.brain.scriptParseFreeTextItems(ok(sampleExtraction));

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "/add baked beans",
      }),
    );
    const { messageId, markup } = findConfirmMarkup(harness);

    harness.brain.scriptReviseFreeTextItems(fail(new BrainUnavailableError("nope")));
    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "it's chopped tomatoes",
        replyToBotMessageId: messageId,
        botUserId: BOT_USER_ID,
      }),
    );

    const replies = harness.calls.filter((c) => c.method === "sendMessage");
    expect(replies.at(-1)!.payload.text).toBe("🧠 busy, try again in a minute");
    expect(harness.calls.find((c) => c.method === "editMessageText")).toBeUndefined();

    harness.brain.scriptEstimateShelfLife(ok([{ name: "baked beans", days: 400 }]));
    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "add:confirm",
        messageId,
        replyMarkup: markup,
      }),
    );

    const storedProducts = harness.db.select().from(products).all();
    expect(storedProducts[0]!.name).toBe("baked beans");
  });

  it("supports multiple correction rounds on the same message", async () => {
    harness.brain.scriptParseFreeTextItems(ok(sampleExtraction));

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "/add baked beans",
      }),
    );
    const { messageId, markup } = findConfirmMarkup(harness);

    harness.brain.scriptReviseFreeTextItems(ok(revisedExtraction));
    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "it's chopped tomatoes",
        replyToBotMessageId: messageId,
        botUserId: BOT_USER_ID,
      }),
    );

    const thirdExtraction = { lines: [{ ...revisedExtraction.lines[0]!, quantity: 2 }] };
    harness.brain.scriptReviseFreeTextItems(ok(thirdExtraction));
    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "actually there were two",
        replyToBotMessageId: messageId,
        botUserId: BOT_USER_ID,
      }),
    );

    harness.brain.scriptEstimateShelfLife(ok([{ name: "chopped tomatoes", days: 5 }]));
    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "add:confirm",
        messageId,
        replyMarkup: markup,
      }),
    );

    const storedLots = harness.db.select().from(stockLots).all();
    expect(storedLots).toHaveLength(1);
    expect(storedLots[0]!.quantity).toBe(2);
  });
});

describe("/add and receipts share the Catalog but never Raw Name", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness(config);
  });

  it("lets a later receipt purchase of the same item join the same Product as a new Lot", async () => {
    harness.brain.scriptParseFreeTextItems(ok(sampleExtraction));
    harness.brain.scriptEstimateShelfLife(ok([{ name: "baked beans", days: 400 }]));

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "/add baked beans",
      }),
    );
    const { messageId, markup } = findConfirmMarkup(harness);
    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "add:confirm",
        messageId,
        replyMarkup: markup,
      }),
    );

    const product = harness.db
      .select()
      .from(products)
      .where(eq(products.name, "baked beans"))
      .get();
    expect(product).toBeDefined();
    expect(harness.db.select().from(rawNameMap).all()).toHaveLength(0);

    harness.brain.scriptExtractReceipt(
      ok({
        lines: [
          {
            rawName: "T.FIN B/BEANS 420G",
            name: "baked beans",
            category: "food" as const,
            quantity: 1,
            unit: "g",
            price: 1.5,
          },
        ],
      }),
    );
    await harness.handleUpdate(
      photoMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        replyToBotMessageId: 42,
        botUserId: BOT_USER_ID,
      }),
    );
    const receiptCall = harness.calls.filter(
      (c) => c.method === "sendMessage" && (c.payload.reply_markup as InlineKeyboardMarkup),
    );
    const receiptMarkup = receiptCall.at(-1)!.payload.reply_markup as InlineKeyboardMarkup;
    const receiptMessageId = 1001;

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "receipt:confirm",
        messageId: receiptMessageId,
        replyMarkup: receiptMarkup,
      }),
    );

    const lotsForProduct = harness.db
      .select()
      .from(stockLots)
      .where(eq(stockLots.productId, product!.id))
      .all();
    expect(lotsForProduct).toHaveLength(2);
    expect(harness.db.select().from(products).all()).toHaveLength(1);
  });
});
