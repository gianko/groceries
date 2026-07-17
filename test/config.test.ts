import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const validEnv = {
  TELEGRAM_BOT_TOKEN: "123:abc",
  GEMINI_API_KEY: "gem-key",
  ALLOWED_USER_IDS: "111,222",
  GROUP_CHAT_ID: "-1001234567890",
  TZ: "Europe/Dublin",
};

describe("loadConfig", () => {
  it("parses a complete, valid env", () => {
    const config = loadConfig(validEnv);

    expect(config).toEqual({
      telegramBotToken: "123:abc",
      geminiApiKey: "gem-key",
      allowedUserIds: [111, 222],
      groupChatId: -1001234567890,
      tz: "Europe/Dublin",
    });
  });

  it.each([
    "TELEGRAM_BOT_TOKEN",
    "GEMINI_API_KEY",
    "ALLOWED_USER_IDS",
    "GROUP_CHAT_ID",
    "TZ",
  ])("fails fast when %s is missing", (key) => {
    const env = { ...validEnv };
    delete (env as Record<string, string | undefined>)[key];

    expect(() => loadConfig(env)).toThrowError(new RegExp(key));
  });

  it("rejects a non-numeric entry in ALLOWED_USER_IDS", () => {
    expect(() =>
      loadConfig({ ...validEnv, ALLOWED_USER_IDS: "111,not-a-number" }),
    ).toThrowError(/ALLOWED_USER_IDS/);
  });

  it("rejects a non-numeric GROUP_CHAT_ID", () => {
    expect(() =>
      loadConfig({ ...validEnv, GROUP_CHAT_ID: "nope" }),
    ).toThrowError(/GROUP_CHAT_ID/);
  });
});
