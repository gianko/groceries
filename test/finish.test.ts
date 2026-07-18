import { describe, expect, it } from "vitest";
import { products, shoppingListEntries, stockLots } from "../src/db/schema.js";
import { createDb } from "../src/db.js";
import { decideAutoRelist, finishLot } from "../src/finish.js";
import { FakeClock } from "./support/fakeClock.js";

const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));

function seedLot(
  db: ReturnType<typeof createDb>,
  productOverrides: { name: string; autoRelist?: boolean; autoRelistAsked?: boolean },
): { lotId: number; productId: number } {
  const [product] = db
    .insert(products)
    .values({
      name: productOverrides.name,
      category: "food",
      autoRelist: productOverrides.autoRelist ?? false,
      autoRelistAsked: productOverrides.autoRelistAsked ?? false,
    })
    .returning()
    .all();

  const [lot] = db
    .insert(stockLots)
    .values({
      productId: product!.id,
      quantity: 1,
      purchasedAt: "2026-01-01",
      status: "in_stock",
    })
    .returning()
    .all();

  return { lotId: lot!.id, productId: product!.id };
}

describe("finishLot", () => {
  it("flips the lot to finished and reports no-op false result for a no-op", () => {
    const db = createDb();
    const { lotId } = seedLot(db, { name: "bread" });

    const first = finishLot(db, clock, lotId);
    const second = finishLot(db, clock, lotId);

    expect(first.finished).toBe(true);
    expect(second.finished).toBe(false);
  });

  it("immediately creates a finished-source list entry for an Auto-Relist Product", () => {
    const db = createDb();
    const { lotId, productId } = seedLot(db, { name: "milk", autoRelist: true });

    const result = finishLot(db, clock, lotId);

    expect(result.autoRelisted).toBe(true);
    expect(result.offerAutoRelist).toBe(false);
    const rows = db.select().from(shoppingListEntries).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "finished", productId, status: "open" });
  });

  it("does not list an entry and does not offer again once already asked", () => {
    const db = createDb();
    const { lotId } = seedLot(db, { name: "sponges", autoRelistAsked: true });

    const result = finishLot(db, clock, lotId);

    expect(result.autoRelisted).toBe(false);
    expect(result.offerAutoRelist).toBe(false);
    expect(db.select().from(shoppingListEntries).all()).toHaveLength(0);
  });

  it("offers the always-re-add prompt for a Product not yet asked and not Auto-Relist", () => {
    const db = createDb();
    const { lotId, productId } = seedLot(db, { name: "eggs" });

    const result = finishLot(db, clock, lotId);

    expect(result.offerAutoRelist).toBe(true);
    expect(result.productId).toBe(productId);
    expect(result.productName).toBe("eggs");
  });
});

describe("decideAutoRelist", () => {
  it("sets Auto-Relist on and marks the offer answered, first-tap-wins", () => {
    const db = createDb();
    const [product] = db
      .insert(products)
      .values({ name: "milk", category: "food" })
      .returning()
      .all();

    const first = decideAutoRelist(db, product!.id, true);
    const second = decideAutoRelist(db, product!.id, false);

    expect(first).toBe(true);
    expect(second).toBe(false);
    const row = db.select().from(products).all()[0]!;
    expect(row.autoRelist).toBe(true);
    expect(row.autoRelistAsked).toBe(true);
  });

  it("a 'no' answer sticks just as permanently as a 'yes'", () => {
    const db = createDb();
    const [product] = db
      .insert(products)
      .values({ name: "flour", category: "food" })
      .returning()
      .all();

    decideAutoRelist(db, product!.id, false);
    const row = db.select().from(products).all()[0]!;

    expect(row.autoRelist).toBe(false);
    expect(row.autoRelistAsked).toBe(true);
  });
});
