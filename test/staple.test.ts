import { describe, expect, it } from "vitest";
import { products } from "../src/db/schema.js";
import { createDb } from "../src/db.js";
import { fetchStaples, setStaple, unstaple } from "../src/staple.js";

describe("setStaple", () => {
  it("creates the Product as a staple when the Catalog lacks it", () => {
    const db = createDb();

    const result = setStaple(db, "salt");

    expect(result).toEqual({ productName: "salt", created: true });
    const rows = db.select().from(products).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "salt", category: "food", isStaple: true });
  });

  it("flips isStaple on an existing Product by case-insensitive name match, without duplicating it", () => {
    const db = createDb();
    db.insert(products).values({ name: "olive oil", category: "food" }).run();

    const result = setStaple(db, "Olive Oil");

    expect(result).toEqual({ productName: "olive oil", created: false });
    const rows = db.select().from(products).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "olive oil", isStaple: true });
  });
});

describe("fetchStaples", () => {
  it("returns declared staples as a flat alphabetically sorted list", () => {
    const db = createDb();
    db.insert(products)
      .values([
        { name: "pepper", category: "food", isStaple: true },
        { name: "olive oil", category: "food", isStaple: true },
        { name: "dish soap", category: "household", isStaple: true },
        { name: "flour", category: "food", isStaple: false },
      ])
      .run();

    const staples = fetchStaples(db);

    expect(staples.map((s) => s.name)).toEqual(["dish soap", "olive oil", "pepper"]);
    expect(staples[0]).toMatchObject({ name: "dish soap", category: "household" });
  });
});

describe("unstaple", () => {
  it("case-insensitively flips isStaple to false on an existing Product", () => {
    const db = createDb();
    db.insert(products).values({ name: "salt", category: "food", isStaple: true }).run();

    const result = unstaple(db, "Salt");

    expect(result).toBe("salt");
    const rows = db.select().from(products).all();
    expect(rows[0]).toMatchObject({ name: "salt", isStaple: false });
  });

  it("is a no-op when no Product matches the name", () => {
    const db = createDb();

    const result = unstaple(db, "nonexistent");

    expect(result).toBeNull();
    expect(db.select().from(products).all()).toHaveLength(0);
  });
});
