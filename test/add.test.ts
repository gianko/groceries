import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { confirmAddItems, renderAddPreview } from "../src/add.js";
import type { FreeTextExtraction, FreeTextLine } from "../src/brain.js";
import { products, rawNameMap, stockLots } from "../src/db/schema.js";
import { createDb, type Db } from "../src/db.js";
import { BrainFake, fail, ok } from "./support/brainFake.js";
import { FakeClock } from "./support/fakeClock.js";

function line(overrides: Partial<FreeTextLine> & { name: string }): FreeTextLine {
  return {
    category: "food",
    quantity: 1,
    unit: null,
    ...overrides,
  };
}

function extraction(lines: FreeTextLine[]): FreeTextExtraction {
  return { lines };
}

describe("confirmAddItems", () => {
  let db: Db;
  let brain: BrainFake;
  let clock: FakeClock;

  beforeEach(() => {
    db = createDb(":memory:");
    brain = new BrainFake();
    clock = new FakeClock(new Date("2026-07-10T12:00:00Z"));
  });

  it("creates a Product and Stock Lot per line, purchased today, with no Raw Name mapping", async () => {
    brain.scriptEstimateShelfLife(ok([{ name: "baked beans", days: 400 }]));

    const { lotIds } = await confirmAddItems(
      db,
      brain,
      clock,
      extraction([line({ name: "baked beans", category: "food", quantity: 2, unit: null })]),
    );

    expect(lotIds).toHaveLength(1);

    const product = db.select().from(products).where(eq(products.name, "baked beans")).get();
    expect(product).toMatchObject({ name: "baked beans", category: "food", shelfLifeDays: 400 });

    const lot = db.select().from(stockLots).where(eq(stockLots.id, lotIds[0]!)).get();
    expect(lot).toMatchObject({
      productId: product!.id,
      quantity: 2,
      unit: null,
      price: null,
      purchasedAt: "2026-07-10",
      estExpiry: "2027-08-14",
      status: "in_stock",
    });

    expect(db.select().from(rawNameMap).all()).toHaveLength(0);
  });

  it("estimates shelf life once per Product via a single batched call for all cache misses", async () => {
    brain.scriptEstimateShelfLife(
      ok([
        { name: "baked beans", days: 400 },
        { name: "rice", days: 300 },
      ]),
    );

    await confirmAddItems(
      db,
      brain,
      clock,
      extraction([
        line({ name: "baked beans" }),
        line({ name: "baked beans" }),
        line({ name: "rice" }),
      ]),
    );

    const shelfLifeCalls = brain.calls.filter((c) => c.method === "estimateShelfLife");
    expect(shelfLifeCalls).toHaveLength(1);
    expect(shelfLifeCalls[0]!.args[0]).toEqual(expect.arrayContaining(["baked beans", "rice"]));
    expect((shelfLifeCalls[0]!.args[0] as string[]).length).toBe(2);
  });

  it("matches an existing Product by name instead of creating a duplicate, reusing its cached shelf life", async () => {
    db.insert(products).values({ name: "milk", category: "food", shelfLifeDays: 7 }).run();

    const { lotIds } = await confirmAddItems(
      db,
      brain,
      clock,
      extraction([line({ name: "milk", category: "food" })]),
    );

    expect(brain.calls.filter((c) => c.method === "estimateShelfLife")).toHaveLength(0);
    expect(db.select().from(products).all()).toHaveLength(1);

    const lot = db.select().from(stockLots).where(eq(stockLots.id, lotIds[0]!)).get();
    expect(lot?.estExpiry).toBe("2026-07-17");
  });

  it("stores a lot with no est_expiry when the Brain has no estimate for that name", async () => {
    brain.scriptEstimateShelfLife(ok([]));

    const { lotIds } = await confirmAddItems(
      db,
      brain,
      clock,
      extraction([line({ name: "mystery item" })]),
    );

    const lot = db.select().from(stockLots).where(eq(stockLots.id, lotIds[0]!)).get();
    expect(lot?.estExpiry).toBeNull();
  });

  it("leaves no Product or Lot row behind when the Brain call fails", async () => {
    brain.scriptEstimateShelfLife(fail(new Error("brain down")));

    await expect(
      confirmAddItems(db, brain, clock, extraction([line({ name: "baked beans" })])),
    ).rejects.toThrow("brain down");

    expect(db.select().from(products).all()).toHaveLength(0);
    expect(db.select().from(stockLots).all()).toHaveLength(0);
  });

  it("returns the resolved product ids", async () => {
    brain.scriptEstimateShelfLife(ok([{ name: "baked beans", days: 400 }]));

    const { productIds } = await confirmAddItems(
      db,
      brain,
      clock,
      extraction([line({ name: "baked beans" })]),
    );

    const product = db.select().from(products).where(eq(products.name, "baked beans")).get();
    expect(productIds).toEqual([product!.id]);
  });
});

describe("renderAddPreview", () => {
  it("renders one line per parsed item with quantity", () => {
    const text = renderAddPreview(extraction([line({ name: "baked beans", unit: "g" })]));

    expect(text).toContain("baked beans");
  });

  it("says nothing was found when there are no lines", () => {
    expect(renderAddPreview(extraction([]))).toContain("No items found");
  });
});
