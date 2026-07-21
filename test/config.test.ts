import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const validEnv = {
  GEMINI_API_KEY: "gem-key",
  TZ: "Europe/Dublin",
  WEB_APP_URL: "https://pantry.example.com",
};

describe("loadConfig", () => {
  it("parses a complete, valid env", () => {
    const config = loadConfig(validEnv);

    expect(config).toEqual({
      geminiApiKey: "gem-key",
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

  it.each(["GEMINI_API_KEY", "TZ", "WEB_APP_URL"])("fails fast when %s is missing", (key) => {
    const env = { ...validEnv };
    delete (env as Record<string, string | undefined>)[key];

    expect(() => loadConfig(env)).toThrowError(new RegExp(key));
  });

  it("strips a trailing slash from WEB_APP_URL", () => {
    const config = loadConfig({ ...validEnv, WEB_APP_URL: "https://pantry.example.com/" });

    expect(config.webAppUrl).toBe("https://pantry.example.com");
  });
});
