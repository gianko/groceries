import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { createTestHarness, type TestHarness } from "./support/harness.js";
import { textMessageUpdate } from "./support/updates.js";

const ALLOWED_USER_A = 111;
const ALLOWED_USER_B = 222;
const UNKNOWN_USER = 999;
const GROUP_CHAT_ID = -1001234567890;
const OTHER_CHAT_ID = -1009999999999;

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

describe("bot auth middleware", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness(config);
  });

  it("answers a command from an allowed user in the allowed group", async () => {
    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        text: "/ping",
      }),
    );

    expect(harness.calls).toEqual([
      {
        method: "sendMessage",
        payload: expect.objectContaining({
          chat_id: GROUP_CHAT_ID,
          text: "pong (commit unknown, built unknown)",
        }),
      },
    ]);
  });

  it("answers either allowed user, not just the first", async () => {
    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_B,
        chatId: GROUP_CHAT_ID,
        text: "/ping",
      }),
    );

    expect(harness.calls).toHaveLength(1);
  });

  it("silently ignores an unknown user in the allowed group", async () => {
    await harness.handleUpdate(
      textMessageUpdate({
        userId: UNKNOWN_USER,
        chatId: GROUP_CHAT_ID,
        text: "/ping",
      }),
    );

    expect(harness.calls).toEqual([]);
  });

  it("silently ignores an allowed user in a different chat", async () => {
    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: OTHER_CHAT_ID,
        text: "/ping",
      }),
    );

    expect(harness.calls).toEqual([]);
  });

  it("silently ignores an allowed user DMing the bot privately", async () => {
    await harness.handleUpdate(
      textMessageUpdate({
        userId: ALLOWED_USER_A,
        chatId: ALLOWED_USER_A,
        chatType: "private",
        text: "/ping",
      }),
    );

    expect(harness.calls).toEqual([]);
  });
});
