import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { products, shoppingListEntries, stockLots } from "../src/db/schema.js";
import { createDb, type Db } from "../src/db.js";
import {
  addCycleGuessEntry,
  computeCycleGuesses,
  fetchExpiringLots,
  renderShoppingSummary,
} from "../src/shopping.js";
import { FakeClock } from "./support/fakeClock.js";

function insertProduct(db: Db, name: string, category: "food" | "household" = "food") {
  const [product] = db.insert(products).values({ name, category }).returning().all();
  return product!;
}

function insertLot(
  db: Db,
  productId: number,
  purchasedAt: string,
  opts: { estExpiry?: string | null; quantity?: number; unit?: string | null } = {},
) {
  const [lot] = db
    .insert(stockLots)
    .values({
      productId,
      quantity: opts.quantity ?? 1,
      unit: opts.unit ?? null,
      purchasedAt,
      estExpiry: opts.estExpiry ?? null,
      status: "in_stock",
    })
    .returning()
    .all();
  return lot!;
}

describe("fetchExpiringLots", () => {
  it("includes in-stock Lots expiring within 2 days, soonest first", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-10T12:00:00Z"));
    const bread = insertProduct(db, "bread");
    const milk = insertProduct(db, "milk");
    const soap = insertProduct(db, "soap", "household");

    insertLot(db, bread.id, "2026-01-08", { estExpiry: "2026-01-12" });
    insertLot(db, milk.id, "2026-01-09", { estExpiry: "2026-01-11" });
    insertLot(db, soap.id, "2026-01-01", { estExpiry: "2026-02-01" });

    const result = fetchExpiringLots(db, clock);

    expect(result.map((r) => r.productName)).toEqual(["milk", "bread"]);
  });

  it("excludes finished Lots and Lots with no estExpiry", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-10T12:00:00Z"));
    const cheese = insertProduct(db, "cheese");
    const rice = insertProduct(db, "rice");

    const finishedLot = insertLot(db, cheese.id, "2026-01-08", { estExpiry: "2026-01-11" });
    db.update(stockLots).set({ status: "finished" }).where(eq(stockLots.id, finishedLot.id)).run();
    insertLot(db, rice.id, "2026-01-08", { estExpiry: null });

    const result = fetchExpiringLots(db, clock);
    expect(result).toEqual([]);
  });
});

describe("computeCycleGuesses", () => {
  it("guesses a Product once the time since last purchase reaches the median gap", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const beans = insertProduct(db, "baked beans");

    insertLot(db, beans.id, "2025-11-01");
    insertLot(db, beans.id, "2025-11-22"); // 21-day gap
    insertLot(db, beans.id, "2025-12-13"); // 21-day gap, median = 21

    expect(computeCycleGuesses(db, clock)).toEqual([]);

    clock.advance(21 * 24 * 60 * 60 * 1000); // advance 3 weeks past last purchase

    expect(computeCycleGuesses(db, clock)).toEqual([
      { productId: beans.id, productName: "baked beans" },
    ]);
  });

  it("does not guess a Product with fewer than two distinct purchase dates", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-06-01T00:00:00Z"));
    const rare = insertProduct(db, "saffron");
    insertLot(db, rare.id, "2025-01-01");

    expect(computeCycleGuesses(db, clock)).toEqual([]);
  });

  it("treats same-day multiple Lots as one purchase event", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const eggs = insertProduct(db, "eggs");
    insertLot(db, eggs.id, "2025-12-01");
    insertLot(db, eggs.id, "2025-12-01");

    expect(computeCycleGuesses(db, clock)).toEqual([]);
  });

  it("excludes a Product already on the open shopping list", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-13T00:00:00Z"));
    const beans = insertProduct(db, "baked beans");
    insertLot(db, beans.id, "2025-11-01");
    insertLot(db, beans.id, "2025-11-22");

    db.insert(shoppingListEntries)
      .values({
        source: "manual",
        productId: beans.id,
        status: "open",
        createdAt: clock.now().toISOString(),
      })
      .run();

    expect(computeCycleGuesses(db, clock)).toEqual([]);
  });
});

describe("addCycleGuessEntry", () => {
  it("writes a cycle_guess entry linked to the Product", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const beans = insertProduct(db, "baked beans");

    const entry = addCycleGuessEntry(db, clock, {
      productId: beans.id,
      productName: "baked beans",
    });

    expect(entry).toEqual({
      id: entry.id,
      source: "cycle_guess",
      productName: "baked beans",
      freeText: null,
    });

    const rows = db.select().from(shoppingListEntries).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("cycle_guess");
    expect(rows[0]?.productId).toBe(beans.id);
    expect(rows[0]?.status).toBe("open");
  });
});

describe("renderShoppingSummary", () => {
  it("shows the list, expiring section, and cycle guesses together", () => {
    const text = renderShoppingSummary(
      [{ id: 1, source: "manual", productName: "milk", freeText: null }],
      [{ lotId: 1, productName: "cheese", quantity: 1, unit: null, estExpiry: "2026-01-11" }],
      [{ productId: 2, productName: "baked beans" }],
    );

    expect(text).toContain("Shopping list");
    expect(text).toContain("milk");
    expect(text).toContain("cheese");
    expect(text).toContain("baked beans");
  });

  it("shows an empty placeholder when there is nothing open and no sections", () => {
    const text = renderShoppingSummary([], [], []);
    expect(text).toContain("(empty)");
    expect(text).not.toContain("Use soon");
    expect(text).not.toContain("Probably low");
  });
});
