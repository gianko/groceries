import { describe, expect, it } from "vitest";
import { createDb } from "../src/db.js";
import { fetchPrefs, parsePrefsEdit, renderPrefs, savePrefs } from "../src/prefs.js";

describe("fetchPrefs / savePrefs", () => {
  it("returns null size and blurb before anything is saved", () => {
    const db = createDb(":memory:");
    expect(fetchPrefs(db)).toEqual({ householdSize: null, blurb: null });
  });

  it("persists a full update and reflects it on the next fetch", () => {
    const db = createDb(":memory:");
    savePrefs(db, { householdSize: 2, blurb: "weeknight meals under 45 min" });
    expect(fetchPrefs(db)).toEqual({ householdSize: 2, blurb: "weeknight meals under 45 min" });
  });

  it("a partial update leaves the other field untouched", () => {
    const db = createDb(":memory:");
    savePrefs(db, { householdSize: 2, blurb: "quick meals" });
    savePrefs(db, { householdSize: 3 });
    expect(fetchPrefs(db)).toEqual({ householdSize: 3, blurb: "quick meals" });

    savePrefs(db, { blurb: "no seafood" });
    expect(fetchPrefs(db)).toEqual({ householdSize: 3, blurb: "no seafood" });
  });
});

describe("renderPrefs", () => {
  it("shows not-set placeholders when nothing is saved", () => {
    const text = renderPrefs({ householdSize: null, blurb: null });
    expect(text).toContain("Size: not set");
    expect(text).toContain("Cooking notes: not set");
  });

  it("shows current values when saved", () => {
    const text = renderPrefs({ householdSize: 2, blurb: "quick meals" });
    expect(text).toContain("Size: 2");
    expect(text).toContain("Cooking notes: quick meals");
  });
});

describe("parsePrefsEdit", () => {
  it("parses an explicit size line", () => {
    expect(parsePrefsEdit("size: 3")).toEqual({ householdSize: 3 });
    expect(parsePrefsEdit("household size 4")).toEqual({ householdSize: 4 });
  });

  it("parses an explicit blurb line", () => {
    expect(parsePrefsEdit("blurb: weeknight meals under 45 min")).toEqual({
      blurb: "weeknight meals under 45 min",
    });
  });

  it("parses both fields from one multi-line reply", () => {
    expect(parsePrefsEdit("size: 3\nblurb: no seafood")).toEqual({
      householdSize: 3,
      blurb: "no seafood",
    });
  });

  it("treats a bare number as a household size", () => {
    expect(parsePrefsEdit("3")).toEqual({ householdSize: 3 });
    expect(parsePrefsEdit("4 people")).toEqual({ householdSize: 4 });
  });

  it("treats plain text with no prefix as the new blurb", () => {
    expect(parsePrefsEdit("weeknight meals under 45 min")).toEqual({
      blurb: "weeknight meals under 45 min",
    });
  });
});
