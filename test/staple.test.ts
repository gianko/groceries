import { describe, expect, it } from "vitest";
import { products } from "../src/db/schema.js";
import { createDb } from "../src/db.js";
import { setStaple } from "../src/staple.js";

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
