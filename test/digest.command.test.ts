import type { InlineKeyboardMarkup } from "grammy/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleExpiryDigest } from "../src/bot.js";
import type { Config } from "../src/config.js";
import { expiryVerdicts, products, stockLots } from "../src/db/schema.js";
import { ok } from "./support/brainFake.js";
import { FakeClock } from "./support/fakeClock.js";
import { createTestHarness, type TestHarness } from "./support/harness.js";
import { callbackQueryUpdate } from "./support/updates.js";

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

function seedJustExpiredLot(
  harness: TestHarness,
  name: string,
  opts: { autoRelist?: boolean } = {},
): number {
  const [product] = harness.db
    .insert(products)
    .values({ name, category: "food", autoRelist: opts.autoRelist ?? false })
    .returning()
    .all();
  const [lot] = harness.db
    .insert(stockLots)
    .values({
      productId: product!.id,
      quantity: 1,
      purchasedAt: "2026-01-01",
      estExpiry: "2026-01-10",
      status: "in_stock",
    })
    .returning()
    .all();
  harness.db
    .insert(expiryVerdicts)
    .values({ lotId: lot!.id, createdAt: harness.clock.now().toISOString() })
    .run();
  return lot!.id;
}

describe("Expiry Digest gone/still-good callbacks", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness(config, {
      clock: new FakeClock(new Date("2026-01-10T17:00:00Z")),
    });
  });

  it("🗑 Gone finishes the Lot, first-tap-wins", async () => {
    const lotId = seedJustExpiredLot(harness, "cheese");

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: `digest:gone:${lotId}`,
        messageId: 1000,
      }),
    );

    expect(harness.db.select().from(stockLots).all()[0]?.status).toBe("finished");
    expect(harness.db.select().from(expiryVerdicts).all()).toEqual([]);

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_B,
        chatId: GROUP_CHAT_ID,
        data: `digest:gone:${lotId}`,
        messageId: 1000,
      }),
    );

    const answers = harness.calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.map((c) => c.payload.text)).toEqual(
      expect.arrayContaining(["Marked finished", "Already handled"]),
    );
  });

  it("offers Auto-Relist after a 🗑 Gone tap, same as a normal Finish-Confirmation", async () => {
    const lotId = seedJustExpiredLot(harness, "milk");

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: `digest:gone:${lotId}`,
        messageId: 1000,
      }),
    );

    const offer = harness.calls.find(
      (c) => c.method === "sendMessage" && (c.payload.text as string).includes("Always re-add"),
    );
    expect(offer).toBeDefined();
  });

  it("👌 Still good pushes est_expiry out and clears the verdict, first-tap-wins", async () => {
    const lotId = seedJustExpiredLot(harness, "yogurt");

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: `digest:still:${lotId}`,
        messageId: 1000,
      }),
    );

    const lot = harness.db.select().from(stockLots).all()[0]!;
    expect(lot.status).toBe("in_stock");
    expect(lot.estExpiry).toBe("2026-01-13");
    expect(harness.db.select().from(expiryVerdicts).all()).toEqual([]);

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_B,
        chatId: GROUP_CHAT_ID,
        data: `digest:still:${lotId}`,
        messageId: 1000,
      }),
    );

    const answers = harness.calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.map((c) => c.payload.text)).toEqual(
      expect.arrayContaining(["Pushed out a few days", "Already handled"]),
    );
  });

  it("the Recipe ideas? button jumps into the /cook flow", async () => {
    harness.brain.scriptSuggestRecipes(ok([]));

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "digest:cook",
        messageId: 1000,
      }),
    );

    // No inventory, no favorites: the Brain still gets called, same as a
    // bare /cook with an empty pantry.
    expect(harness.brain.calls.filter((c) => c.method === "suggestRecipes")).toHaveLength(1);
  });
});

describe("scheduleExpiryDigest", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness(config, {
      clock: new FakeClock(new Date("2026-01-10T17:00:00Z")),
    });
  });

  it("registers the cron expression with node-cron at the configured tz", async () => {
    const { default: cron } = await import("node-cron");
    const scheduleSpy = vi.spyOn(cron, "schedule");

    const task = scheduleExpiryDigest(
      harness.bot,
      harness.db,
      harness.clock,
      GROUP_CHAT_ID,
      "0 17 * * *",
      "Europe/Dublin",
    );

    expect(scheduleSpy).toHaveBeenCalledWith("0 17 * * *", expect.any(Function), {
      timezone: "Europe/Dublin",
    });
    task.stop();
    scheduleSpy.mockRestore();
  });

  it("sends nothing when a quiet pantry doesn't qualify", async () => {
    const { default: cron } = await import("node-cron");
    const scheduleSpy = vi.spyOn(cron, "schedule");

    scheduleExpiryDigest(
      harness.bot,
      harness.db,
      harness.clock,
      GROUP_CHAT_ID,
      "0 17 * * *",
      "Europe/Dublin",
    );
    const fired = scheduleSpy.mock.calls[0]?.[1] as () => void;
    fired();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.calls).toHaveLength(0);
    scheduleSpy.mockRestore();
  });

  it("sends the digest and marks the Lot's verdict as asked when a Lot just expired", async () => {
    const [product] = harness.db
      .insert(products)
      .values({ name: "cheese", category: "food" })
      .returning()
      .all();
    const [lot] = harness.db
      .insert(stockLots)
      .values({
        productId: product!.id,
        quantity: 1,
        purchasedAt: "2026-01-01",
        estExpiry: "2026-01-10",
        status: "in_stock",
      })
      .returning()
      .all();

    const { default: cron } = await import("node-cron");
    const scheduleSpy = vi.spyOn(cron, "schedule");

    scheduleExpiryDigest(
      harness.bot,
      harness.db,
      harness.clock,
      GROUP_CHAT_ID,
      "0 17 * * *",
      "Europe/Dublin",
    );
    const fired = scheduleSpy.mock.calls[0]?.[1] as () => void;
    fired();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]!.payload.text).toContain("cheese");
    expect(harness.db.select().from(expiryVerdicts).all()).toEqual([
      { lotId: lot!.id, createdAt: harness.clock.now().toISOString() },
    ]);

    scheduleSpy.mockRestore();
  });

  it("shows both sections together and gives just-expired Lots verdict buttons", async () => {
    const [bread] = harness.db
      .insert(products)
      .values({ name: "bread", category: "food" })
      .returning()
      .all();
    const [cheese] = harness.db
      .insert(products)
      .values({ name: "cheese", category: "food" })
      .returning()
      .all();
    harness.db
      .insert(stockLots)
      .values({
        productId: bread!.id,
        quantity: 1,
        purchasedAt: "2026-01-01",
        estExpiry: "2026-01-12",
        status: "in_stock",
      })
      .run();
    const [expiredLot] = harness.db
      .insert(stockLots)
      .values({
        productId: cheese!.id,
        quantity: 1,
        purchasedAt: "2026-01-01",
        estExpiry: "2026-01-10",
        status: "in_stock",
      })
      .returning()
      .all();

    const { default: cron } = await import("node-cron");
    const scheduleSpy = vi.spyOn(cron, "schedule");

    scheduleExpiryDigest(
      harness.bot,
      harness.db,
      harness.clock,
      GROUP_CHAT_ID,
      "0 17 * * *",
      "Europe/Dublin",
    );
    const fired = scheduleSpy.mock.calls[0]?.[1] as () => void;
    fired();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.calls).toHaveLength(1);
    const text = harness.calls[0]!.payload.text as string;
    expect(text).toContain("Expiring soon");
    expect(text).toContain("bread");
    expect(text).toContain("gone or still good");
    expect(text).toContain("cheese");

    const markup = harness.calls[0]!.payload.reply_markup as InlineKeyboardMarkup;
    const buttons = markup.inline_keyboard.flat().filter((b) => "callback_data" in b) as {
      callback_data: string;
      text: string;
    }[];
    expect(buttons.map((b) => b.callback_data)).toEqual(
      expect.arrayContaining([
        `digest:gone:${expiredLot!.id}`,
        `digest:still:${expiredLot!.id}`,
        "digest:cook",
      ]),
    );

    scheduleSpy.mockRestore();
  });
});
