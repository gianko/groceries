import { describe, expect, it } from "vitest";
import { createDb } from "../src/db.js";
import { products, stockLots } from "../src/db/schema.js";

describe("createDb", () => {
  it("applies migrations so every schema table is queryable", () => {
    const db = createDb(":memory:");

    const [product] = db
      .insert(products)
      .values({ name: "baked beans", category: "food" })
      .returning()
      .all();

    expect(product).toMatchObject({
      name: "baked beans",
      category: "food",
      isStaple: false,
      autoRelist: false,
    });

    const [lot] = db
      .insert(stockLots)
      .values({
        productId: product!.id,
        quantity: 1,
        purchasedAt: "2026-07-01",
        status: "in_stock",
      })
      .returning()
      .all();

    expect(lot).toMatchObject({ productId: product!.id, status: "in_stock" });
  });
});
