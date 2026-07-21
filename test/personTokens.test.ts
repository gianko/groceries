import { describe, expect, it } from "vitest";
import { createDb } from "../src/db.js";
import { fetchPersonTokens, mintPersonToken } from "../src/personTokens.js";
import { FakeClock } from "./support/fakeClock.js";

describe("mintPersonToken", () => {
  it("creates a new person with a random token", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-07-21T12:00:00Z"));

    const result = mintPersonToken(db, clock, "Gian");

    expect(result.name).toBe("Gian");
    expect(result.token).toMatch(/^[\w-]{40,}$/);
    expect(fetchPersonTokens(db)).toEqual([result]);
  });

  it("mints distinct tokens for distinct people", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-07-21T12:00:00Z"));

    const gian = mintPersonToken(db, clock, "Gian");
    const alex = mintPersonToken(db, clock, "Alex");

    expect(gian.token).not.toBe(alex.token);
    expect(
      fetchPersonTokens(db)
        .map((p) => p.name)
        .sort(),
    ).toEqual(["Alex", "Gian"]);
  });

  it("rotates an existing person's token in place rather than adding a row", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-07-21T12:00:00Z"));
    const first = mintPersonToken(db, clock, "Gian");

    const second = mintPersonToken(db, clock, "Gian");

    expect(second.id).toBe(first.id);
    expect(second.token).not.toBe(first.token);
    expect(fetchPersonTokens(db)).toHaveLength(1);
  });
});
