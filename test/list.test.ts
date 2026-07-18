import { describe, expect, it } from "vitest";
import { products, shoppingListEntries } from "../src/db/schema.js";
import { createDb } from "../src/db.js";
import { addManualEntry, fetchOpenEntries, renderList } from "../src/list.js";
import { FakeClock } from "./support/fakeClock.js";

describe("addManualEntry", () => {
  it("links to an existing Product by exact case-insensitive name match", () => {
    const db = createDb();
    const [product] = db
      .insert(products)
      .values({ name: "milk", category: "food" })
      .returning()
      .all();

    const entry = addManualEntry(db, new FakeClock(new Date("2026-01-01T00:00:00Z")), "Milk");

    expect(entry.source).toBe("manual");
    expect(entry.productName).toBe("milk");
    expect(entry.freeText).toBeNull();

    const rows = db.select().from(shoppingListEntries).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.productId).toBe(product!.id);
    expect(rows[0]?.freeText).toBeNull();
  });

  it("creates a free-text entry when no Product matches", () => {
    const db = createDb();

    const entry = addManualEntry(
      db,
      new FakeClock(new Date("2026-01-01T00:00:00Z")),
      "chopped tomatoes",
    );

    expect(entry.productName).toBeNull();
    expect(entry.freeText).toBe("chopped tomatoes");

    const rows = db.select().from(shoppingListEntries).all();
    expect(rows[0]?.productId).toBeNull();
    expect(rows[0]?.freeText).toBe("chopped tomatoes");
  });
});

describe("fetchOpenEntries", () => {
  it("returns only open entries, done entries drop off", () => {
    const db = createDb();
    const [product] = db
      .insert(products)
      .values({ name: "milk", category: "food" })
      .returning()
      .all();

    db.insert(shoppingListEntries)
      .values({
        source: "manual",
        productId: product!.id,
        status: "open",
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();
    db.insert(shoppingListEntries)
      .values({
        source: "manual",
        freeText: "sponges",
        status: "done",
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();

    const entries = fetchOpenEntries(db);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.productName).toBe("milk");
  });
});

describe("renderList", () => {
  it("says the list is empty when there are no open entries", () => {
    expect(renderList([])).toBe("🛒 Shopping list is empty.");
  });

  it("shows Product-linked and free-text entries", () => {
    const text = renderList([
      { id: 1, source: "manual", productName: "milk", freeText: null },
      { id: 2, source: "manual", productName: null, freeText: "chopped tomatoes" },
    ]);

    expect(text).toContain("• milk");
    expect(text).toContain("• chopped tomatoes");
  });
});
