import type { InlineKeyboardMarkup } from "grammy/types";
import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { products, stockLots } from "../src/db/schema.js";
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

function seedLot(
  harness: TestHarness,
  overrides: {
    name: string;
    category: "food" | "household";
    estExpiry?: string | null;
  },
): number {
  const [product] = harness.db
    .insert(products)
    .values({ name: overrides.name, category: overrides.category })
    .returning()
    .all();

  const [lot] = harness.db
    .insert(stockLots)
    .values({
      productId: product!.id,
      quantity: 1,
      purchasedAt: "2026-07-01",
      estExpiry: overrides.estExpiry ?? null,
      status: "in_stock",
    })
    .returning()
    .all();

  return lot!.id;
}

describe("/inventory", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness(config);
  });

  it("shows seeded lots grouped by category, food ordered by soonest expiry", async () => {
    seedLot(harness, { name: "Bread", category: "food", estExpiry: "2026-07-20" });
    seedLot(harness, { name: "Milk", category: "food", estExpiry: "2026-07-18" });
    seedLot(harness, { name: "Toilet roll", category: "household" });

    await harness.handleUpdate(
      textMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID, text: "/inventory" }),
    );

    expect(harness.calls).toHaveLength(1);
    const text = harness.calls[0]!.payload.text as string;
    expect(text.indexOf("Milk")).toBeLessThan(text.indexOf("Bread"));
    expect(text.indexOf("Bread")).toBeLessThan(text.indexOf("Toilet roll"));
  });

  it("flips exactly the tapped Lot to finished, and only on a tap", async () => {
    const milkLotId = seedLot(harness, { name: "Milk", category: "food" });
    const breadLotId = seedLot(harness, { name: "Bread", category: "food" });

    await harness.handleUpdate(
      textMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID, text: "/inventory" }),
    );
    const replyMarkup = harness.calls[0]!.payload.reply_markup as InlineKeyboardMarkup;

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: `finish:${milkLotId}`,
        messageId: 1,
        replyMarkup,
      }),
    );

    const rows = harness.db.select().from(stockLots).all();
    const milk = rows.find((r) => r.id === milkLotId);
    const bread = rows.find((r) => r.id === breadLotId);
    expect(milk?.status).toBe("finished");
    expect(bread?.status).toBe("in_stock");
  });

  it("lets either household member tap; first tap wins and the loser is a no-op", async () => {
    const milkLotId = seedLot(harness, { name: "Milk", category: "food" });

    await harness.handleUpdate(
      textMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID, text: "/inventory" }),
    );
    const replyMarkup = harness.calls[0]!.payload.reply_markup as InlineKeyboardMarkup;

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: `finish:${milkLotId}`,
        messageId: 1,
        replyMarkup,
      }),
    );
    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_B,
        chatId: GROUP_CHAT_ID,
        data: `finish:${milkLotId}`,
        messageId: 1,
        replyMarkup,
      }),
    );

    const milk = harness.db
      .select()
      .from(stockLots)
      .all()
      .find((r) => r.id === milkLotId);
    expect(milk?.status).toBe("finished");

    const answers = harness.calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.map((c) => c.payload.text)).toEqual(["Marked finished", "Already finished"]);
  });
});
