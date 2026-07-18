import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { products } from "../src/db/schema.js";
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
  digestCron: "0 17 * * *",
};

describe("/staple", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness(config);
  });

  it("creates a new Product as a staple", async () => {
    await harness.handleUpdate(
      textMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID, text: "/staple salt" }),
    );

    expect(harness.calls[0]!.payload.text).toContain("salt");
    const rows = harness.db.select().from(products).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "salt", isStaple: true });
  });

  it("flips an existing Product to staple instead of forking a duplicate", async () => {
    harness.db.insert(products).values({ name: "pepper", category: "food" }).run();

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "/staple Pepper",
      }),
    );

    const rows = harness.db.select().from(products).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "pepper", isStaple: true });
  });

  it("asks for a name when none is given", async () => {
    await harness.handleUpdate(
      textMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID, text: "/staple" }),
    );

    expect(harness.calls[0]!.payload.text).toContain("Usage");
    expect(harness.db.select().from(products).all()).toHaveLength(0);
  });
});
