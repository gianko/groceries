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
};

const sampleExtraction = {
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

describe("receipt happy path", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness(config);
  });

  it("shows a confirm keyboard for a photo sent as a reply to the bot", async () => {
    harness.brain.scriptExtractReceipt(ok(sampleExtraction));

    await harness.handleUpdate(
      photoMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        replyToBotMessageId: 42,
        botUserId: BOT_USER_ID,
      }),
    );

    expect(harness.calls).toHaveLength(1);
    const call = harness.calls[0]!;
    expect(call.method).toBe("sendMessage");
    expect(call.payload.text).toContain("baked beans");
    const markup = call.payload.reply_markup as InlineKeyboardMarkup;
    const buttonTexts = markup.inline_keyboard.flat().map((b) => b.text);
    expect(buttonTexts).toEqual(["✅ Confirm", "✏️ Edit", "❌ Discard"]);
  });

  it("shows a confirm keyboard for a photo captioned /receipt", async () => {
    harness.brain.scriptExtractReceipt(ok(sampleExtraction));

    await harness.handleUpdate(
      photoMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID, caption: "/receipt" }),
    );

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]!.method).toBe("sendMessage");
  });

  it("ignores a photo that is neither a reply to the bot nor captioned /receipt", async () => {
    await harness.handleUpdate(
      photoMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID }),
    );

    expect(harness.calls).toEqual([]);
    expect(harness.brain.calls).toEqual([]);
  });

  it("inserts Products, Lots, and Raw Name mappings on confirm, and nothing on discard", async () => {
    harness.brain.scriptExtractReceipt(ok(sampleExtraction));
    harness.brain.scriptEstimateShelfLife(ok([{ name: "baked beans", days: 400 }]));

    await harness.handleUpdate(
      photoMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        replyToBotMessageId: 42,
        botUserId: BOT_USER_ID,
      }),
    );
    const { messageId, markup } = findConfirmMarkup(harness);

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "receipt:confirm",
        messageId,
        replyMarkup: markup,
      }),
    );

    expect(harness.db.select().from(products).all()).toHaveLength(1);
    expect(harness.db.select().from(stockLots).all()).toHaveLength(1);
    expect(harness.db.select().from(rawNameMap).all()).toHaveLength(1);

    const answers = harness.calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers).toHaveLength(1);
    expect(answers[0]!.payload.text).toBe("Saved");
  });

  it("stores nothing on discard", async () => {
    harness.brain.scriptExtractReceipt(ok(sampleExtraction));

    await harness.handleUpdate(
      photoMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        replyToBotMessageId: 42,
        botUserId: BOT_USER_ID,
      }),
    );
    const { messageId, markup } = findConfirmMarkup(harness);

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "receipt:discard",
        messageId,
        replyMarkup: markup,
      }),
    );

    expect(harness.db.select().from(products).all()).toHaveLength(0);
    expect(harness.db.select().from(stockLots).all()).toHaveLength(0);

    const answers = harness.calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers[0]!.payload.text).toBe("Discarded");
  });

  it("first tap wins on the confirm keyboard; the loser is a no-op", async () => {
    harness.brain.scriptExtractReceipt(ok(sampleExtraction));
    harness.brain.scriptEstimateShelfLife(ok([{ name: "baked beans", days: 400 }]));

    await harness.handleUpdate(
      photoMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        replyToBotMessageId: 42,
        botUserId: BOT_USER_ID,
      }),
    );
    const { messageId, markup } = findConfirmMarkup(harness);

    await Promise.all([
      harness.handleUpdate(
        callbackQueryUpdate({
          userId: ALLOWED_USER_A,
          chatId: GROUP_CHAT_ID,
          data: "receipt:confirm",
          messageId,
          replyMarkup: markup,
        }),
      ),
      harness.handleUpdate(
        callbackQueryUpdate({
          userId: ALLOWED_USER_B,
          chatId: GROUP_CHAT_ID,
          data: "receipt:discard",
          messageId,
          replyMarkup: markup,
        }),
      ),
    ]);

    expect(harness.db.select().from(stockLots).all()).toHaveLength(1);
    const answers = harness.calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.map((c) => c.payload.text)).toEqual(["Saved", "Already handled"]);
  });

  it("shows the busy message and stores nothing when the Brain fails on extraction", async () => {
    harness.brain.scriptExtractReceipt(fail(new BrainUnavailableError("nope")));

    await harness.handleUpdate(
      photoMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        replyToBotMessageId: 42,
        botUserId: BOT_USER_ID,
      }),
    );

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]!.payload.text).toBe("🧠 busy, try again in a minute");
    expect(harness.db.select().from(products).all()).toHaveLength(0);
  });

  it("shows the busy message on confirm when shelf-life estimation fails, and stores nothing", async () => {
    harness.brain.scriptExtractReceipt(ok(sampleExtraction));
    harness.brain.scriptEstimateShelfLife(fail(new BrainUnavailableError("nope")));

    await harness.handleUpdate(
      photoMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        replyToBotMessageId: 42,
        botUserId: BOT_USER_ID,
      }),
    );
    const { messageId, markup } = findConfirmMarkup(harness);

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "receipt:confirm",
        messageId,
        replyMarkup: markup,
      }),
    );

    const answers = harness.calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers[0]!.payload.text).toBe("🧠 busy, try again in a minute");
    expect(harness.db.select().from(stockLots).all()).toHaveLength(0);
    expect(harness.db.select().from(products).all()).toHaveLength(0);
    expect(harness.db.select().from(rawNameMap).all()).toHaveLength(0);
  });

  it("keeps the pending receipt and keyboard alive after a failed confirm, so a retry succeeds", async () => {
    harness.brain.scriptExtractReceipt(ok(sampleExtraction));
    harness.brain.scriptEstimateShelfLife(fail(new BrainUnavailableError("nope")));

    await harness.handleUpdate(
      photoMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        replyToBotMessageId: 42,
        botUserId: BOT_USER_ID,
      }),
    );
    const { messageId, markup } = findConfirmMarkup(harness);

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "receipt:confirm",
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
        data: "receipt:confirm",
        messageId,
        replyMarkup: markup,
      }),
    );

    expect(harness.db.select().from(products).all()).toHaveLength(1);
    expect(harness.db.select().from(stockLots).all()).toHaveLength(1);
    const answers = harness.calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.map((c) => c.payload.text)).toEqual(["🧠 busy, try again in a minute", "Saved"]);
  });

  it("drops a pending confirmation across a restart (a fresh bot instance can't confirm the old message)", async () => {
    harness.brain.scriptExtractReceipt(ok(sampleExtraction));

    await harness.handleUpdate(
      photoMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        replyToBotMessageId: 42,
        botUserId: BOT_USER_ID,
      }),
    );
    const { messageId, markup } = findConfirmMarkup(harness);

    const restarted = createTestHarness(config, { brain: harness.brain });
    await restarted.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "receipt:confirm",
        messageId,
        replyMarkup: markup,
      }),
    );

    expect(restarted.db.select().from(products).all()).toHaveLength(0);
    const answers = restarted.calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers[0]!.payload.text).toBe("Already handled");
  });

  it("acknowledges the Edit button without discarding the pending receipt", async () => {
    harness.brain.scriptExtractReceipt(ok(sampleExtraction));

    await harness.handleUpdate(
      photoMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        replyToBotMessageId: 42,
        botUserId: BOT_USER_ID,
      }),
    );
    const { messageId, markup } = findConfirmMarkup(harness);

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "receipt:edit",
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
        data: "receipt:confirm",
        messageId,
        replyMarkup: markup,
      }),
    );

    expect(harness.db.select().from(products).all()).toHaveLength(1);
  });

  it("ignores an unknown text message, leaving no pending state to confirm", async () => {
    await harness.handleUpdate(
      textMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID, text: "hello" }),
    );
    expect(harness.calls).toEqual([]);
  });
});

describe("Catalog-aware normalization", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness(config);
  });

  it("overrides the Brain's naming for a known Raw Name with the mapped Product, involving no LLM naming for that line", async () => {
    const [product] = harness.db
      .insert(products)
      .values({ name: "baked beans", category: "food", shelfLifeDays: 400 })
      .returning()
      .all();
    harness.db
      .insert(rawNameMap)
      .values({ rawName: "T.FIN B/BEANS 420G", productId: product!.id })
      .run();

    // The Brain misfires on naming for a raw name we already know — the
    // bypass should ignore this guess entirely and use the mapped Product.
    harness.brain.scriptExtractReceipt(
      ok({
        lines: [
          {
            rawName: "T.FIN B/BEANS 420G",
            name: "beans, baked (tin)",
            category: "household" as const,
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

    const call = harness.calls[0]!;
    expect(call.payload.text).toContain("baked beans");
    expect(call.payload.text).not.toContain("beans, baked");
  });

  it("passes the current Catalog name list to the extraction call, so new Raw Names are normalized against it", async () => {
    harness.db.insert(products).values({ name: "milk", category: "food" }).run();
    harness.db.insert(products).values({ name: "baked beans", category: "food" }).run();
    harness.brain.scriptExtractReceipt(ok(sampleExtraction));

    await harness.handleUpdate(
      photoMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        replyToBotMessageId: 42,
        botUserId: BOT_USER_ID,
      }),
    );

    const extractCall = harness.brain.calls.find((c) => c.method === "extractReceipt");
    expect(extractCall!.args[1]).toEqual(expect.arrayContaining(["milk", "baked beans"]));
  });
});

describe("receipt correction loop", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness(config);
  });

  const revisedExtraction = {
    lines: [
      {
        rawName: "T.FIN B/BEANS 420G",
        name: "chopped tomatoes",
        category: "food" as const,
        quantity: 1,
        unit: "g",
        price: 1.5,
      },
    ],
  };

  it("re-shows a revised list with the same keyboard after a free-text reply to the receipt message", async () => {
    harness.brain.scriptExtractReceipt(ok(sampleExtraction));

    await harness.handleUpdate(
      photoMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        replyToBotMessageId: 42,
        botUserId: BOT_USER_ID,
      }),
    );
    const { messageId } = findConfirmMarkup(harness);

    harness.brain.scriptReviseReceipt(ok(revisedExtraction));
    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "it's chopped tomatoes, not baked beans",
        replyToBotMessageId: messageId,
        botUserId: BOT_USER_ID,
      }),
    );

    const reviseCall = harness.brain.calls.find((c) => c.method === "reviseReceipt");
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
    harness.brain.scriptExtractReceipt(ok(sampleExtraction));

    await harness.handleUpdate(
      photoMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        replyToBotMessageId: 42,
        botUserId: BOT_USER_ID,
      }),
    );
    const { messageId, markup } = findConfirmMarkup(harness);

    harness.brain.scriptReviseReceipt(ok(revisedExtraction));
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
        data: "receipt:confirm",
        messageId,
        replyMarkup: markup,
      }),
    );

    const storedProducts = harness.db.select().from(products).all();
    expect(storedProducts).toHaveLength(1);
    expect(storedProducts[0]!.name).toBe("chopped tomatoes");
  });

  it("supports multiple correction rounds on the same message", async () => {
    harness.brain.scriptExtractReceipt(ok(sampleExtraction));

    await harness.handleUpdate(
      photoMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        replyToBotMessageId: 42,
        botUserId: BOT_USER_ID,
      }),
    );
    const { messageId, markup } = findConfirmMarkup(harness);

    harness.brain.scriptReviseReceipt(ok(revisedExtraction));
    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "it's chopped tomatoes",
        replyToBotMessageId: messageId,
        botUserId: BOT_USER_ID,
      }),
    );

    const thirdExtraction = {
      lines: [{ ...revisedExtraction.lines[0]!, quantity: 2 }],
    };
    harness.brain.scriptReviseReceipt(ok(thirdExtraction));
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
        data: "receipt:confirm",
        messageId,
        replyMarkup: markup,
      }),
    );

    const storedLots = harness.db.select().from(stockLots).all();
    expect(storedLots).toHaveLength(1);
    expect(storedLots[0]!.quantity).toBe(2);
  });

  it("ignores a free-text reply to a non-bot message, even if it names a pending receipt's message id", async () => {
    harness.brain.scriptExtractReceipt(ok(sampleExtraction));

    await harness.handleUpdate(
      photoMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        replyToBotMessageId: 42,
        botUserId: BOT_USER_ID,
      }),
    );
    const { messageId } = findConfirmMarkup(harness);

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "it's chopped tomatoes",
        replyToUserMessageId: messageId,
      }),
    );

    expect(harness.brain.calls.find((c) => c.method === "reviseReceipt")).toBeUndefined();
    expect(harness.calls.find((c) => c.method === "editMessageText")).toBeUndefined();
  });

  it("ignores a free-text reply to a message that is not a pending receipt", async () => {
    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "random reply",
        replyToBotMessageId: 999,
        botUserId: BOT_USER_ID,
      }),
    );

    expect(harness.calls).toEqual([]);
    expect(harness.brain.calls).toEqual([]);
  });

  it("shows the busy message and keeps the original list when revision fails", async () => {
    harness.brain.scriptExtractReceipt(ok(sampleExtraction));

    await harness.handleUpdate(
      photoMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        replyToBotMessageId: 42,
        botUserId: BOT_USER_ID,
      }),
    );
    const { messageId, markup } = findConfirmMarkup(harness);

    harness.brain.scriptReviseReceipt(fail(new BrainUnavailableError("nope")));
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
        data: "receipt:confirm",
        messageId,
        replyMarkup: markup,
      }),
    );

    const storedProducts = harness.db.select().from(products).all();
    expect(storedProducts[0]!.name).toBe("baked beans");
  });
});
