import type { InlineKeyboardMarkup } from "grammy/types";
import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { products, shoppingListEntries, stockLots } from "../src/db/schema.js";
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
};

function seedLot(
  harness: TestHarness,
  overrides: { name: string; autoRelist?: boolean; autoRelistAsked?: boolean },
): number {
  const [product] = harness.db
    .insert(products)
    .values({
      name: overrides.name,
      category: "food",
      autoRelist: overrides.autoRelist ?? false,
      autoRelistAsked: overrides.autoRelistAsked ?? false,
    })
    .returning()
    .all();

  const [lot] = harness.db
    .insert(stockLots)
    .values({
      productId: product!.id,
      quantity: 1,
      purchasedAt: "2026-07-01",
      status: "in_stock",
    })
    .returning()
    .all();

  return lot!.id;
}

async function finishLotViaInventory(harness: TestHarness, lotId: number): Promise<void> {
  await harness.handleUpdate(
    textMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID, text: "/inventory" }),
  );
  const replyMarkup = harness.calls[harness.calls.length - 1]!.payload
    .reply_markup as InlineKeyboardMarkup;

  await harness.handleUpdate(
    callbackQueryUpdate({
      userId: ALLOWED_USER_A,
      chatId: GROUP_CHAT_ID,
      data: `finish:${lotId}`,
      messageId: 1,
      replyMarkup,
    }),
  );
}

describe("Finish-Confirmation: Auto-Relist", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness(config);
  });

  it("immediately puts an Auto-Relist Product's finished Lot on the shopping list, no offer attached", async () => {
    const lotId = seedLot(harness, { name: "milk", autoRelist: true });

    await finishLotViaInventory(harness, lotId);

    const entries = harness.db.select().from(shoppingListEntries).all();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: "finished", status: "open" });

    const offers = harness.calls.filter(
      (c) => c.method === "sendMessage" && (c.payload.text as string).includes("Always re-add"),
    );
    expect(offers).toHaveLength(0);
  });

  it("offers 'always re-add?' on an early finish for a Product never asked before", async () => {
    const lotId = seedLot(harness, { name: "eggs" });

    await finishLotViaInventory(harness, lotId);

    const offer = harness.calls.find(
      (c) => c.method === "sendMessage" && (c.payload.text as string).includes("Always re-add"),
    );
    expect(offer).toBeDefined();
    expect(offer!.payload.text).toContain("eggs");
  });

  it("does not offer again once the Product has already been asked", async () => {
    const lotId = seedLot(harness, { name: "flour", autoRelistAsked: true });

    await finishLotViaInventory(harness, lotId);

    const offer = harness.calls.find(
      (c) => c.method === "sendMessage" && (c.payload.text as string).includes("Always re-add"),
    );
    expect(offer).toBeUndefined();
  });

  it("a Yes tap turns on Auto-Relist and the offer never resurfaces on later finishes", async () => {
    const [product] = harness.db
      .insert(products)
      .values({ name: "butter", category: "food" })
      .returning()
      .all();
    const [firstLot] = harness.db
      .insert(stockLots)
      .values({
        productId: product!.id,
        quantity: 1,
        purchasedAt: "2026-07-01",
        status: "in_stock",
      })
      .returning()
      .all();

    await finishLotViaInventory(harness, firstLot!.id);
    const offerMarkup = harness.calls[harness.calls.length - 1]!.payload
      .reply_markup as InlineKeyboardMarkup;

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: `relist:yes:${product!.id}`,
        messageId: harness.calls.length,
        replyMarkup: offerMarkup,
      }),
    );

    const row = harness.db.select().from(products).all()[0]!;
    expect(row.autoRelist).toBe(true);
    expect(row.autoRelistAsked).toBe(true);

    const [secondLot] = harness.db
      .insert(stockLots)
      .values({
        productId: product!.id,
        quantity: 1,
        purchasedAt: "2026-07-05",
        status: "in_stock",
      })
      .returning()
      .all();

    const callsBefore = harness.calls.length;
    await finishLotViaInventory(harness, secondLot!.id);

    const newOffers = harness.calls
      .slice(callsBefore)
      .filter(
        (c) => c.method === "sendMessage" && (c.payload.text as string).includes("Always re-add"),
      );
    expect(newOffers).toHaveLength(0);

    const entries = harness.db.select().from(shoppingListEntries).all();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: "finished", productId: product!.id });
  });

  it("a No tap sticks — the offer does not resurface, and Auto-Relist stays off", async () => {
    const lotId = seedLot(harness, { name: "sugar" });
    await finishLotViaInventory(harness, lotId);
    const productId = harness.db.select().from(products).all()[0]!.id;
    const offerMarkup = harness.calls[harness.calls.length - 1]!.payload
      .reply_markup as InlineKeyboardMarkup;

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: `relist:no:${productId}`,
        messageId: harness.calls.length,
        replyMarkup: offerMarkup,
      }),
    );

    const row = harness.db.select().from(products).all()[0]!;
    expect(row.autoRelist).toBe(false);
    expect(row.autoRelistAsked).toBe(true);
  });

  it("lets either household member answer; first tap wins and the loser is a no-op", async () => {
    const lotId = seedLot(harness, { name: "coffee" });
    await finishLotViaInventory(harness, lotId);
    const productId = harness.db.select().from(products).all()[0]!.id;
    const offerMarkup = harness.calls[harness.calls.length - 1]!.payload
      .reply_markup as InlineKeyboardMarkup;
    const offerMessageId = harness.calls.length;

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: `relist:yes:${productId}`,
        messageId: offerMessageId,
        replyMarkup: offerMarkup,
      }),
    );
    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_B,
        chatId: GROUP_CHAT_ID,
        data: `relist:no:${productId}`,
        messageId: offerMessageId,
        replyMarkup: offerMarkup,
      }),
    );

    const row = harness.db.select().from(products).all()[0]!;
    expect(row.autoRelist).toBe(true);

    const answers = harness.calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.map((c) => c.payload.text)).toEqual(
      expect.arrayContaining(["Got it", "Already answered"]),
    );
  });
});
