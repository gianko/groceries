import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { products, shoppingListEntries } from "../src/db/schema.js";
import { createTestHarness, type TestHarness } from "./support/harness.js";
import { textMessageUpdate } from "./support/updates.js";

const ALLOWED_USER_A = 111;
const GROUP_CHAT_ID = -1001234567890;

const config: Config = {
  telegramBotToken: "test-token",
  geminiApiKey: "test-key",
  allowedUserIds: [ALLOWED_USER_A, 222],
  groupChatId: GROUP_CHAT_ID,
  tz: "Europe/Dublin",
  dbPath: ":memory:",
  heartbeatPath: "heartbeat",
  heartbeatIntervalMs: 30_000,
  heartbeatStaleMs: 90_000,
  snapshotPath: "pantry.snapshot.db",
  snapshotCron: "0 3 * * *",
};

describe("/list", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness(config);
  });

  it("shows an empty list when nothing is open", async () => {
    await harness.handleUpdate(
      textMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID, text: "/list" }),
    );

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]!.payload.text).toContain("empty");
  });

  it("adds a free-text entry with argument text that matches no Product, then shows it", async () => {
    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "/list chopped tomatoes",
      }),
    );

    const text = harness.calls[0]!.payload.text as string;
    expect(text).toContain("chopped tomatoes");

    const rows = harness.db.select().from(shoppingListEntries).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("manual");
    expect(rows[0]?.freeText).toBe("chopped tomatoes");
    expect(rows[0]?.productId).toBeNull();
  });

  it("adds a linked entry when the argument matches an existing Product", async () => {
    harness.db.insert(products).values({ name: "milk", category: "food" }).run();

    await harness.handleUpdate(
      textMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID, text: "/list Milk" }),
    );

    const text = harness.calls[0]!.payload.text as string;
    expect(text).toContain("milk");

    const rows = harness.db.select().from(shoppingListEntries).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.productId).not.toBeNull();
    expect(rows[0]?.freeText).toBeNull();
  });

  it("does not show done entries", async () => {
    const [product] = harness.db
      .insert(products)
      .values({ name: "milk", category: "food" })
      .returning()
      .all();
    harness.db
      .insert(shoppingListEntries)
      .values({
        source: "manual",
        productId: product!.id,
        status: "done",
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();

    await harness.handleUpdate(
      textMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID, text: "/list" }),
    );

    const text = harness.calls[0]!.payload.text as string;
    expect(text).not.toContain("milk");
    expect(text).toContain("empty");
  });
});
