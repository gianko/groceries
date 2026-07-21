import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { prefs } from "../src/db/schema.js";
import { savePrefs } from "../src/prefs.js";
import { createTestHarness, type TestHarness } from "./support/harness.js";
import { textMessageUpdate } from "./support/updates.js";

const ALLOWED_USER_A = 111;
const GROUP_CHAT_ID = -1001234567890;
const BOT_USER_ID = 1;

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
  webAppUrl: "https://pantry.example.com",
};

describe("/prefs", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness(config);
  });

  it("shows not-set placeholders when nothing is saved yet", async () => {
    await harness.handleUpdate(
      textMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID, text: "/prefs" }),
    );

    expect(harness.calls).toHaveLength(1);
    const text = harness.calls[0]!.payload.text as string;
    expect(text).toContain("Size: not set");
    expect(text).toContain("Cooking notes: not set");
  });

  it("shows current household size and blurb", async () => {
    savePrefs(harness.db, { householdSize: 2, blurb: "weeknight meals under 45 min" });

    await harness.handleUpdate(
      textMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID, text: "/prefs" }),
    );

    const text = harness.calls[0]!.payload.text as string;
    expect(text).toContain("Size: 2");
    expect(text).toContain("Cooking notes: weeknight meals under 45 min");
  });

  it("updates prefs from a free-text reply and edits the message in place", async () => {
    await harness.handleUpdate(
      textMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID, text: "/prefs" }),
    );
    const messageId = 1000;

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "size: 3",
        replyToBotMessageId: messageId,
        botUserId: BOT_USER_ID,
      }),
    );

    const editCall = harness.calls.find((c) => c.method === "editMessageText");
    expect(editCall).toBeDefined();
    expect(editCall!.payload.text).toContain("Size: 3");

    const stored = harness.db.select().from(prefs).all();
    expect(stored[0]?.householdSize).toBe(3);
  });

  it("supports updating size and blurb across separate replies, keeping the other field", async () => {
    await harness.handleUpdate(
      textMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID, text: "/prefs" }),
    );
    const messageId = 1000;

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "size: 2",
        replyToBotMessageId: messageId,
        botUserId: BOT_USER_ID,
      }),
    );
    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "weeknight meals under 45 min",
        replyToBotMessageId: messageId,
        botUserId: BOT_USER_ID,
      }),
    );

    const editCalls = harness.calls.filter((c) => c.method === "editMessageText");
    const lastEdit = editCalls[editCalls.length - 1]!;
    expect(lastEdit.payload.text).toContain("Size: 2");
    expect(lastEdit.payload.text).toContain("Cooking notes: weeknight meals under 45 min");
  });

  it("stops honouring a stale /prefs message once a newer one has been sent", async () => {
    await harness.handleUpdate(
      textMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID, text: "/prefs" }),
    );
    const staleMessageId = 1000;

    await harness.handleUpdate(
      textMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID, text: "/prefs" }),
    );

    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "size: 9",
        replyToBotMessageId: staleMessageId,
        botUserId: BOT_USER_ID,
      }),
    );

    expect(harness.calls.find((c) => c.method === "editMessageText")).toBeUndefined();
    const stored = harness.db.select().from(prefs).all();
    expect(stored).toHaveLength(0);
  });

  it("does not persist prefs from a reply to an unrelated bot message", async () => {
    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "size: 5",
        replyToBotMessageId: 42,
        botUserId: BOT_USER_ID,
      }),
    );

    const stored = harness.db.select().from(prefs).all();
    expect(stored).toHaveLength(0);
  });
});
