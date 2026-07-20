import type { InlineKeyboardMarkup } from "grammy/types";
import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { products, shoppingListEntries, stockLots } from "../src/db/schema.js";
import { FakeClock } from "./support/fakeClock.js";
import { createTestHarness, type TestHarness } from "./support/harness.js";
import { callbackQueryUpdate, textMessageUpdate } from "./support/updates.js";

const ALLOWED_USER_A = 111;
const ALLOWED_USER_B = 222;
const GROUP_CHAT_ID = -1001234567890;

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
  webAppUrl: "https://pantry.example.com",
};

function insertProductWithLots(
  harness: TestHarness,
  name: string,
  purchases: string[],
  opts: { estExpiry?: string | null } = {},
): number {
  const [product] = harness.db
    .insert(products)
    .values({ name, category: "food" })
    .returning()
    .all();
  for (const purchasedAt of purchases) {
    harness.db
      .insert(stockLots)
      .values({
        productId: product!.id,
        quantity: 1,
        purchasedAt,
        estExpiry: opts.estExpiry ?? null,
        status: "in_stock",
      })
      .run();
  }
  return product!.id;
}

async function runShopping(harness: TestHarness): Promise<void> {
  await harness.handleUpdate(
    textMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID, text: "/shopping" }),
  );
}

describe("/shopping", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness(config, {
      clock: new FakeClock(new Date("2026-01-13T12:00:00Z")),
    });
  });

  it("shows the open list, expiring Lots, and Cycle Guesses in one summary", async () => {
    harness.db
      .insert(shoppingListEntries)
      .values({
        source: "manual",
        freeText: "toothpaste",
        status: "open",
        createdAt: harness.clock.now().toISOString(),
      })
      .run();

    insertProductWithLots(harness, "cheese", ["2026-01-10"], { estExpiry: "2026-01-14" });
    insertProductWithLots(harness, "baked beans", ["2025-11-01", "2025-11-22"]);

    await runShopping(harness);

    expect(harness.calls).toHaveLength(1);
    const text = harness.calls[0]!.payload.text as string;
    expect(text).toContain("toothpaste");
    expect(text).toContain("cheese");
    expect(text).toContain("baked beans");
  });

  it("shows a working add button that writes a cycle_guess entry, first-tap-wins", async () => {
    const productId = insertProductWithLots(harness, "baked beans", ["2025-11-01", "2025-11-22"]);

    await runShopping(harness);
    const markup = harness.calls[0]!.payload.reply_markup as InlineKeyboardMarkup;
    const addButton = markup.inline_keyboard[0]!.find(
      (b) => "callback_data" in b && b.callback_data.startsWith("shopping:add:"),
    ) as { callback_data: string };

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: addButton.callback_data,
        messageId: 1000,
        replyMarkup: markup,
      }),
    );

    const rows = harness.db.select().from(shoppingListEntries).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("cycle_guess");
    expect(rows[0]?.productId).toBe(productId);

    // A second tap on the same button is a no-op.
    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_B,
        chatId: GROUP_CHAT_ID,
        data: addButton.callback_data,
        messageId: 1000,
        replyMarkup: markup,
      }),
    );
    expect(harness.db.select().from(shoppingListEntries).all()).toHaveLength(1);
  });

  it("leaves no trace when a Cycle Guess is skipped", async () => {
    insertProductWithLots(harness, "baked beans", ["2025-11-01", "2025-11-22"]);

    await runShopping(harness);
    const markup = harness.calls[0]!.payload.reply_markup as InlineKeyboardMarkup;
    const skipButton = markup.inline_keyboard[0]!.find(
      (b) => "callback_data" in b && b.callback_data.startsWith("shopping:skip:"),
    ) as { callback_data: string };

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: skipButton.callback_data,
        messageId: 1000,
        replyMarkup: markup,
      }),
    );

    expect(harness.db.select().from(shoppingListEntries).all()).toHaveLength(0);
  });

  it("appends a last-minute item when replying to the summary, from either household member", async () => {
    await runShopping(harness);
    const summaryMessageId = 1000;

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_B,
        chatId: GROUP_CHAT_ID,
        text: "olive oil",
        replyToBotMessageId: summaryMessageId,
      }),
    );

    const rows = harness.db.select().from(shoppingListEntries).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("manual");
    expect(rows[0]?.freeText).toBe("olive oil");

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "kitchen roll",
        replyToBotMessageId: summaryMessageId,
      }),
    );

    expect(harness.db.select().from(shoppingListEntries).all()).toHaveLength(2);
  });
});
