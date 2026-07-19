import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateInitData } from "../../web/src/lib/initData.js";

const BOT_TOKEN = "123456:test-bot-token";

function signInitData(fields: Record<string, string>): string {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const params = new URLSearchParams(fields);
  params.set("hash", hash);
  return params.toString();
}

function initDataFor(userId: number, authDate: Date, overrides: Record<string, string> = {}) {
  return signInitData({
    auth_date: String(Math.floor(authDate.getTime() / 1000)),
    query_id: "AAsomequeryid",
    user: JSON.stringify({ id: userId, first_name: "Test" }),
    ...overrides,
  });
}

const now = new Date("2026-07-19T12:00:00Z");

describe("validateInitData", () => {
  it("accepts a correctly-signed, fresh payload for an allowed user", () => {
    const raw = initDataFor(111, now);

    const result = validateInitData(raw, BOT_TOKEN, [111, 222], now);

    expect(result).toEqual({ valid: true, userId: 111, firstName: "Test" });
  });

  it("rejects a payload signed with the wrong bot token", () => {
    const dataCheckString = "auth_date=1784548800\nuser={}";
    const wrongHash = createHmac(
      "sha256",
      createHmac("sha256", "WebAppData").update("wrong-token").digest(),
    )
      .update(dataCheckString)
      .digest("hex");
    const raw = `auth_date=1784548800&user=%7B%7D&hash=${wrongHash}`;

    const result = validateInitData(raw, BOT_TOKEN, [111], now);

    expect(result.valid).toBe(false);
  });

  it("rejects a payload for a user not in the allow-list", () => {
    const raw = initDataFor(999, now);

    const result = validateInitData(raw, BOT_TOKEN, [111, 222], now);

    expect(result).toEqual({ valid: false, reason: "user not allowed" });
  });

  it("rejects a stale payload past the freshness window", () => {
    const staleAuthDate = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    const raw = initDataFor(111, staleAuthDate);

    const result = validateInitData(raw, BOT_TOKEN, [111], now);

    expect(result).toEqual({ valid: false, reason: "stale auth_date" });
  });

  it("rejects a payload missing the hash field", () => {
    const result = validateInitData("auth_date=123&user=%7B%7D", BOT_TOKEN, [111], now);

    expect(result.valid).toBe(false);
  });
});
