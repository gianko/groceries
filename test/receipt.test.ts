import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { ReceiptExtraction, ReceiptLine } from "../src/brain.js";
import { products, rawNameMap, stockLots } from "../src/db/schema.js";
import { createDb, type Db } from "../src/db.js";
import {
  applyKnownRawNames,
  confirmReceipt,
  fetchCatalogNames,
  renderReceiptPreview,
} from "../src/receipt.js";
import { BrainFake, fail, ok } from "./support/brainFake.js";
import { FakeClock } from "./support/fakeClock.js";

function line(overrides: Partial<ReceiptLine> & { rawName: string; name: string }): ReceiptLine {
  return {
    category: "food",
    quantity: 1,
    unit: null,
    price: null,
    ...overrides,
  };
}

function extraction(lines: ReceiptLine[]): ReceiptExtraction {
  return { lines };
}

describe("confirmReceipt", () => {
  let db: Db;
  let brain: BrainFake;
  let clock: FakeClock;

  beforeEach(() => {
    db = createDb(":memory:");
    brain = new BrainFake();
    clock = new FakeClock(new Date("2026-07-10T12:00:00Z"));
  });

  it("creates a Product and Stock Lot per line, with price and Raw Name mapping", async () => {
    brain.scriptEstimateShelfLife(ok([{ name: "baked beans", days: 400 }]));

    const { lotIds } = await confirmReceipt(
      db,
      brain,
      clock,
      extraction([
        line({
          rawName: "T.FIN B/BEANS 420G",
          name: "baked beans",
          category: "food",
          quantity: 1,
          unit: "g",
          price: 1.5,
        }),
      ]),
    );

    expect(lotIds).toHaveLength(1);

    const product = db.select().from(products).where(eq(products.name, "baked beans")).get();
    expect(product).toMatchObject({ name: "baked beans", category: "food", shelfLifeDays: 400 });

    const lot = db.select().from(stockLots).where(eq(stockLots.id, lotIds[0]!)).get();
    expect(lot).toMatchObject({
      productId: product!.id,
      quantity: 1,
      unit: "g",
      price: 1.5,
      purchasedAt: "2026-07-10",
      estExpiry: "2027-08-14",
      status: "in_stock",
    });

    const mapping = db
      .select()
      .from(rawNameMap)
      .where(eq(rawNameMap.rawName, "T.FIN B/BEANS 420G"))
      .get();
    expect(mapping?.productId).toBe(product!.id);
  });

  it("estimates shelf life once per Product via a single batched call for all cache misses", async () => {
    brain.scriptEstimateShelfLife(
      ok([
        { name: "baked beans", days: 400 },
        { name: "milk", days: 7 },
      ]),
    );

    await confirmReceipt(
      db,
      brain,
      clock,
      extraction([
        line({ rawName: "T.FIN B/BEANS 420G", name: "baked beans" }),
        line({ rawName: "T.FIN B/BEANS 420G x2", name: "baked beans" }),
        line({ rawName: "AVONMORE MILK 2L", name: "milk" }),
      ]),
    );

    const shelfLifeCalls = brain.calls.filter((c) => c.method === "estimateShelfLife");
    expect(shelfLifeCalls).toHaveLength(1);
    expect(shelfLifeCalls[0]!.args[0]).toEqual(expect.arrayContaining(["baked beans", "milk"]));
    expect((shelfLifeCalls[0]!.args[0] as string[]).length).toBe(2);
  });

  it("reuses a Product's cached shelf life on a later receipt instead of calling the Brain again", async () => {
    brain.scriptEstimateShelfLife(ok([{ name: "baked beans", days: 400 }]));
    await confirmReceipt(
      db,
      brain,
      clock,
      extraction([line({ rawName: "T.FIN B/BEANS 420G", name: "baked beans" })]),
    );
    expect(brain.calls.filter((c) => c.method === "estimateShelfLife")).toHaveLength(1);

    clock.advance(24 * 60 * 60 * 1000);
    const { lotIds } = await confirmReceipt(
      db,
      brain,
      clock,
      extraction([line({ rawName: "T.FIN B/BEANS 420G", name: "baked beans" })]),
    );

    expect(brain.calls.filter((c) => c.method === "estimateShelfLife")).toHaveLength(1);
    const lot = db.select().from(stockLots).where(eq(stockLots.id, lotIds[0]!)).get();
    expect(lot?.estExpiry).toBe("2027-08-15");

    const productCount = db.select().from(products).all();
    expect(productCount).toHaveLength(1);
  });

  it("matches an existing Product by name instead of creating a duplicate", async () => {
    db.insert(products).values({ name: "milk", category: "food", shelfLifeDays: 7 }).run();

    await confirmReceipt(
      db,
      brain,
      clock,
      extraction([line({ rawName: "AVONMORE MILK 2L", name: "milk", category: "food" })]),
    );

    expect(brain.calls.filter((c) => c.method === "estimateShelfLife")).toHaveLength(0);
    expect(db.select().from(products).all()).toHaveLength(1);
  });

  it("stores a lot with no est_expiry when the Brain has no estimate for that name", async () => {
    brain.scriptEstimateShelfLife(ok([]));

    const { lotIds } = await confirmReceipt(
      db,
      brain,
      clock,
      extraction([line({ rawName: "MYSTERY ITEM", name: "mystery item" })]),
    );

    const lot = db.select().from(stockLots).where(eq(stockLots.id, lotIds[0]!)).get();
    expect(lot?.estExpiry).toBeNull();
  });

  it("leaves no Product, Lot, or Raw Name row behind when the Brain call fails", async () => {
    brain.scriptEstimateShelfLife(fail(new Error("brain down")));

    await expect(
      confirmReceipt(
        db,
        brain,
        clock,
        extraction([line({ rawName: "T.FIN B/BEANS 420G", name: "baked beans" })]),
      ),
    ).rejects.toThrow("brain down");

    expect(db.select().from(products).all()).toHaveLength(0);
    expect(db.select().from(stockLots).all()).toHaveLength(0);
    expect(db.select().from(rawNameMap).all()).toHaveLength(0);
  });
});

describe("applyKnownRawNames", () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("overrides name and category for a line whose Raw Name was mapped on a prior receipt, ignoring what the Brain guessed this time", () => {
    const [product] = db
      .insert(products)
      .values({ name: "baked beans", category: "food", shelfLifeDays: 400 })
      .returning()
      .all();
    db.insert(rawNameMap).values({ rawName: "T.FIN B/BEANS 420G", productId: product!.id }).run();

    const resolved = applyKnownRawNames(
      db,
      extraction([
        line({ rawName: "T.FIN B/BEANS 420G", name: "beans, baked tin", category: "household" }),
      ]),
    );

    expect(resolved.lines[0]).toMatchObject({ name: "baked beans", category: "food" });
  });

  it("leaves a line untouched when its Raw Name has never been mapped", () => {
    const resolved = applyKnownRawNames(
      db,
      extraction([line({ rawName: "MYSTERY ITEM", name: "mystery item" })]),
    );

    expect(resolved.lines[0]).toMatchObject({ name: "mystery item" });
  });
});

describe("fetchCatalogNames", () => {
  it("returns every Product name in the Catalog", () => {
    const db = createDb(":memory:");
    db.insert(products).values({ name: "milk", category: "food" }).run();
    db.insert(products).values({ name: "baked beans", category: "food" }).run();

    expect(fetchCatalogNames(db).sort()).toEqual(["baked beans", "milk"]);
  });

  it("returns an empty list when the Catalog is empty", () => {
    const db = createDb(":memory:");
    expect(fetchCatalogNames(db)).toEqual([]);
  });
});

describe("renderReceiptPreview", () => {
  it("renders one line per parsed item with quantity and price", () => {
    const text = renderReceiptPreview(
      extraction([
        line({ rawName: "T.FIN B/BEANS 420G", name: "baked beans", unit: "g", price: 1.5 }),
      ]),
    );

    expect(text).toContain("baked beans");
    expect(text).toContain("€1.50");
  });

  it("says nothing was found when there are no lines", () => {
    expect(renderReceiptPreview(extraction([]))).toContain("No items found");
  });
});
