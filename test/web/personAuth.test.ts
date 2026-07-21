import { describe, expect, it } from "vitest";
import type { PersonToken } from "../../src/personTokens.js";
import { COOKIE_MAX_AGE_SECONDS, validatePersonToken } from "../../web/src/lib/personAuth.js";

const now = new Date("2026-07-21T12:00:00Z");

const records: PersonToken[] = [
  { id: 1, name: "Gian", token: "gian-token-abc123" },
  { id: 2, name: "Alex", token: "alex-token-def456" },
];

describe("validatePersonToken", () => {
  it("accepts a token that matches a known person and reissues a full-window expiry", () => {
    const result = validatePersonToken("gian-token-abc123", records, now);

    expect(result).toEqual({
      valid: true,
      personId: 1,
      name: "Gian",
      expiresAt: new Date(now.getTime() + COOKIE_MAX_AGE_SECONDS * 1000),
    });
  });

  it("rejects a token that matches no one", () => {
    const result = validatePersonToken("not-a-real-token", records, now);

    expect(result).toEqual({ valid: false });
  });

  it("rejects a missing/empty token", () => {
    const result = validatePersonToken("", records, now);

    expect(result).toEqual({ valid: false });
  });

  it("rejects a token that only partially matches (wrong length)", () => {
    const result = validatePersonToken("gian-token-abc123-extra", records, now);

    expect(result).toEqual({ valid: false });
  });

  it("computes the refreshed expiry from `now`, not from any prior expiry", () => {
    const later = new Date(now.getTime() + 200 * 24 * 60 * 60 * 1000);

    const result = validatePersonToken("alex-token-def456", records, later);

    expect(result).toEqual({
      valid: true,
      personId: 2,
      name: "Alex",
      expiresAt: new Date(later.getTime() + COOKIE_MAX_AGE_SECONDS * 1000),
    });
  });

  it("respects a custom maxAgeSeconds override", () => {
    const result = validatePersonToken("gian-token-abc123", records, now, 60);

    expect(result).toEqual({
      valid: true,
      personId: 1,
      name: "Gian",
      expiresAt: new Date(now.getTime() + 60 * 1000),
    });
  });
});
