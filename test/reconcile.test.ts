import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { ReceiptExtraction, ReceiptLine } from "../src/brain.js";
import { addMissingIngredients } from "../src/cook.js";
import { products, shoppingListEntries } from "../src/db/schema.js";
import { createDb, type Db } from "../src/db.js";
import { confirmReceipt } from "../src/receipt.js";
import { clearEntry, reconcileShoppingList, renderReconcilePrompt } from "../src/reconcile.js";
import { BrainFake, ok } from "./support/brainFake.js";
import { FakeClock } from "./support/fakeClock.js";

function insertProduct(db: Db, name: string): number {
  const [product] = db.insert(products).values({ name, category: "food" }).returning().all();
  return product!.id;
}

function insertEntry(
  db: Db,
  overrides: { productId?: number | null; freeText?: string | null; status?: "open" | "done" },
): number {
  const [row] = db
    .insert(shoppingListEntries)
    .values({
      source: "manual",
      productId: overrides.productId ?? null,
      freeText: overrides.freeText ?? null,
      status: overrides.status ?? "open",
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .returning()
    .all();
  return row!.id;
}

describe("reconcileShoppingList", () => {
  it("silently closes a Product-linked open entry whose Product is on the receipt", () => {
    const db = createDb(":memory:");
    const milkId = insertProduct(db, "milk");
    const entryId = insertEntry(db, { productId: milkId });

    const result = reconcileShoppingList(db, [milkId]);

    expect(result.doneCount).toBe(1);
    const entry = db
      .select()
      .from(shoppingListEntries)
      .where(eq(shoppingListEntries.id, entryId))
      .get();
    expect(entry?.status).toBe("done");
  });

  it("leaves a Product-linked open entry open when its Product is not on the receipt", () => {
    const db = createDb(":memory:");
    const milkId = insertProduct(db, "milk");
    const eggsId = insertProduct(db, "eggs");
    const entryId = insertEntry(db, { productId: milkId });

    reconcileShoppingList(db, [eggsId]);

    const entry = db
      .select()
      .from(shoppingListEntries)
      .where(eq(shoppingListEntries.id, entryId))
      .get();
    expect(entry?.status).toBe("open");
  });

  it("never matches a free-text entry by name, even if the text equals a purchased Product's name", () => {
    const db = createDb(":memory:");
    const milkId = insertProduct(db, "milk");
    insertEntry(db, { freeText: "milk" });

    const result = reconcileShoppingList(db, [milkId]);

    expect(result.doneCount).toBe(0);
    expect(result.leftoverFreeText).toHaveLength(1);
    expect(result.leftoverFreeText[0]?.freeText).toBe("milk");
  });

  it("returns every open free-text entry as leftover, since none can ever be matched by identity", () => {
    const db = createDb(":memory:");
    insertEntry(db, { freeText: "chopped tomatoes" });
    insertEntry(db, { freeText: "sponges" });

    const result = reconcileShoppingList(db, []);

    expect(result.leftoverFreeText.map((e) => e.freeText).sort()).toEqual([
      "chopped tomatoes",
      "sponges",
    ]);
  });

  it("does not surface an already-done free-text entry as leftover", () => {
    const db = createDb(":memory:");
    insertEntry(db, { freeText: "sponges", status: "done" });

    const result = reconcileShoppingList(db, []);

    expect(result.leftoverFreeText).toHaveLength(0);
  });
});

describe("clearEntry", () => {
  it("closes an open entry", () => {
    const db = createDb(":memory:");
    const entryId = insertEntry(db, { freeText: "sponges" });

    expect(clearEntry(db, entryId)).toBe(true);
    const entry = db
      .select()
      .from(shoppingListEntries)
      .where(eq(shoppingListEntries.id, entryId))
      .get();
    expect(entry?.status).toBe("done");
  });

  it("is a no-op the second time (first-tap-wins)", () => {
    const db = createDb(":memory:");
    const entryId = insertEntry(db, { freeText: "sponges" });

    expect(clearEntry(db, entryId)).toBe(true);
    expect(clearEntry(db, entryId)).toBe(false);
  });
});

describe("recipe_missing free-text entries through the receipt path", () => {
  function line(overrides: Partial<ReceiptLine> & { rawName: string; name: string }): ReceiptLine {
    return { category: "food", quantity: 1, unit: null, price: null, ...overrides };
  }

  it("joins the Catalog when purchased, but stays a free-text leftover since it was never Product-linked", async () => {
    const db = createDb(":memory:");
    const clock = new FakeClock(new Date("2026-07-10T12:00:00Z"));
    const brain = new BrainFake();
    brain.scriptEstimateShelfLife(ok([{ name: "chopped tomatoes", days: 5 }]));

    addMissingIngredients(db, clock, [{ name: "chopped tomatoes" }]);
    const before = db
      .select()
      .from(shoppingListEntries)
      .where(eq(shoppingListEntries.source, "recipe_missing"))
      .get();
    expect(before).toMatchObject({ productId: null, freeText: "chopped tomatoes", status: "open" });

    const extraction: ReceiptExtraction = {
      lines: [line({ rawName: "TESCO CHOP TOMATO", name: "chopped tomatoes" })],
    };
    const { productIds } = await confirmReceipt(db, brain, clock, extraction);

    const product = db.select().from(products).where(eq(products.name, "chopped tomatoes")).get();
    expect(product).toBeDefined();
    expect(productIds).toContain(product!.id);

    // No fuzzy match against the free-text entry's text: it wasn't Product-linked
    // to begin with, so reconciliation can't silently close it — it surfaces
    // for a human keep/clear instead.
    const reconciled = reconcileShoppingList(db, productIds);
    expect(reconciled.leftoverFreeText.map((e) => e.freeText)).toContain("chopped tomatoes");

    const after = db
      .select()
      .from(shoppingListEntries)
      .where(eq(shoppingListEntries.source, "recipe_missing"))
      .get();
    expect(after?.status).toBe("open");
  });
});

describe("renderReconcilePrompt", () => {
  it("lists every leftover free-text entry", () => {
    const entries = [
      { id: 1, source: "manual" as const, productName: null, freeText: "sponges" },
      { id: 2, source: "manual" as const, productName: null, freeText: "chopped tomatoes" },
    ];

    const text = renderReconcilePrompt(entries);

    expect(text).toContain("sponges");
    expect(text).toContain("chopped tomatoes");
  });
});
