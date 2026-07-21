import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const validEnv = {
  TELEGRAM_BOT_TOKEN: "123:abc",
  GEMINI_API_KEY: "gem-key",
  ALLOWED_USER_IDS: "111,222",
  GROUP_CHAT_ID: "-1001234567890",
  TZ: "Europe/Dublin",
  WEB_APP_URL: "https://pantry.example.com",
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
      dbPath: "pantry.db",
      heartbeatPath: "heartbeat",
      heartbeatIntervalMs: 30_000,
      heartbeatStaleMs: 90_000,
      snapshotPath: "pantry.snapshot.db",
      snapshotCron: "0 3 * * *",
      webAppUrl: "https://pantry.example.com",
    });
  });

  it("honors ops env overrides when present", () => {
    const config = loadConfig({
      ...validEnv,
      DB_PATH: "/data/pantry.db",
      HEARTBEAT_PATH: "/data/heartbeat",
      HEARTBEAT_INTERVAL_MS: "15000",
      HEARTBEAT_STALE_MS: "45000",
      SNAPSHOT_PATH: "/data/pantry.snapshot.db",
      SNAPSHOT_CRON: "30 2 * * *",
    });

    expect(config).toMatchObject({
      dbPath: "/data/pantry.db",
      heartbeatPath: "/data/heartbeat",
      heartbeatIntervalMs: 15_000,
      heartbeatStaleMs: 45_000,
      snapshotPath: "/data/pantry.snapshot.db",
      snapshotCron: "30 2 * * *",
    });
  });

  it.each([
    "TELEGRAM_BOT_TOKEN",
    "GEMINI_API_KEY",
    "ALLOWED_USER_IDS",
    "GROUP_CHAT_ID",
    "TZ",
    "WEB_APP_URL",
  ])("fails fast when %s is missing", (key) => {
    const env = { ...validEnv };
    delete (env as Record<string, string | undefined>)[key];

    expect(() => loadConfig(env)).toThrowError(new RegExp(key));
  });

  it("rejects a non-numeric entry in ALLOWED_USER_IDS", () => {
    expect(() => loadConfig({ ...validEnv, ALLOWED_USER_IDS: "111,not-a-number" })).toThrowError(
      /ALLOWED_USER_IDS/,
    );
  });

  it("rejects a non-numeric GROUP_CHAT_ID", () => {
    expect(() => loadConfig({ ...validEnv, GROUP_CHAT_ID: "nope" })).toThrowError(/GROUP_CHAT_ID/);
  });

  it("strips a trailing slash from WEB_APP_URL", () => {
    const config = loadConfig({ ...validEnv, WEB_APP_URL: "https://pantry.example.com/" });

    expect(config.webAppUrl).toBe("https://pantry.example.com");
  });
});
