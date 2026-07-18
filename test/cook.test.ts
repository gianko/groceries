import { describe, expect, it } from "vitest";
import type { RecipeSuggestion } from "../src/brain.js";
import {
  addMissingIngredients,
  fetchFoodInventory,
  fetchStapleNames,
  reclassifyRecipe,
  renderAlmostThereRecipe,
  renderCookTonight,
  tierRecipes,
} from "../src/cook.js";
import { products, shoppingListEntries, stockLots } from "../src/db/schema.js";
import { createDb } from "../src/db.js";
import { FakeClock } from "./support/fakeClock.js";

describe("fetchFoodInventory", () => {
  it("returns only food, in-stock items, soonest-expiring first", () => {
    const db = createDb();
    const [bread] = db
      .insert(products)
      .values({ name: "bread", category: "food" })
      .returning()
      .all();
    const [milk] = db.insert(products).values({ name: "milk", category: "food" }).returning().all();
    const [soap] = db
      .insert(products)
      .values({ name: "soap", category: "household" })
      .returning()
      .all();
    const [finished] = db
      .insert(products)
      .values({ name: "old cheese", category: "food" })
      .returning()
      .all();

    db.insert(stockLots)
      .values({
        productId: bread!.id,
        quantity: 1,
        unit: null,
        purchasedAt: "2026-07-01",
        estExpiry: "2026-07-20",
        status: "in_stock",
      })
      .run();
    db.insert(stockLots)
      .values({
        productId: milk!.id,
        quantity: 1,
        unit: "l",
        purchasedAt: "2026-07-01",
        estExpiry: "2026-07-18",
        status: "in_stock",
      })
      .run();
    db.insert(stockLots)
      .values({
        productId: soap!.id,
        quantity: 1,
        purchasedAt: "2026-07-01",
        estExpiry: null,
        status: "in_stock",
      })
      .run();
    db.insert(stockLots)
      .values({
        productId: finished!.id,
        quantity: 1,
        purchasedAt: "2026-06-01",
        estExpiry: "2026-06-10",
        status: "finished",
      })
      .run();

    const inventory = fetchFoodInventory(db);

    expect(inventory.map((i) => i.name)).toEqual(["milk", "bread"]);
    expect(inventory[0]).toEqual({ name: "milk", quantity: 1, unit: "l", estExpiry: "2026-07-18" });
  });
});

describe("fetchStapleNames", () => {
  it("returns lowercased names of staple-flagged Products", () => {
    const db = createDb();
    db.insert(products).values({ name: "salt", category: "food", isStaple: true }).run();
    db.insert(products).values({ name: "milk", category: "food", isStaple: false }).run();

    expect(fetchStapleNames(db)).toEqual(new Set(["salt"]));
  });
});

function recipe(overrides: Partial<RecipeSuggestion>): RecipeSuggestion {
  return {
    title: "Test recipe",
    ingredients: [],
    missingCount: 0,
    ...overrides,
  };
}

describe("reclassifyRecipe", () => {
  it("keeps an ingredient present when it verbatim-matches the food inventory and the Brain said present", () => {
    const r = recipe({
      ingredients: [{ name: "milk", quantity: 1, unit: "l", present: true }],
    });

    const result = reclassifyRecipe(r, new Set(["milk"]), new Set());

    expect(result.ingredients[0]?.present).toBe(true);
    expect(result.missingCount).toBe(0);
  });

  it("reclassifies a hallucinated present ingredient (not a verbatim Catalog match) as missing", () => {
    const r = recipe({
      ingredients: [{ name: "chopped basil", quantity: 1, unit: null, present: true }],
    });

    const result = reclassifyRecipe(r, new Set(["milk"]), new Set());

    expect(result.ingredients[0]?.present).toBe(false);
    expect(result.missingCount).toBe(1);
  });

  it("never counts a Staple-flagged ingredient as missing, even if absent from inventory and the Brain said missing", () => {
    const r = recipe({
      ingredients: [{ name: "salt", quantity: 1, unit: null, present: false }],
    });

    const result = reclassifyRecipe(r, new Set(), new Set(["salt"]));

    expect(result.ingredients[0]?.present).toBe(true);
    expect(result.missingCount).toBe(0);
  });

  it("matches verbatim names case-insensitively", () => {
    const r = recipe({
      ingredients: [{ name: "Milk", quantity: 1, unit: null, present: true }],
    });

    const result = reclassifyRecipe(r, new Set(["milk"]), new Set());

    expect(result.ingredients[0]?.present).toBe(true);
  });
});

describe("tierRecipes", () => {
  it("puts a fully-covered recipe in cookTonight and a <=3-missing recipe in almostThere", () => {
    const fullyCovered = {
      title: "Beans on toast",
      ingredients: [{ name: "bread", quantity: 1, unit: null, present: true }],
      missingCount: 0,
    };
    const almostThere = {
      title: "Chili",
      ingredients: [{ name: "kidney beans", quantity: 1, unit: null, present: false }],
      missingCount: 1,
    };
    const tooManyMissing = {
      title: "Fancy stew",
      ingredients: [],
      missingCount: 4,
    };

    const tiers = tierRecipes([fullyCovered, almostThere, tooManyMissing]);

    expect(tiers.cookTonight).toEqual([fullyCovered]);
    expect(tiers.almostThere).toEqual([almostThere]);
  });
});

describe("renderCookTonight", () => {
  it("says nothing is fully in stock when empty", () => {
    expect(renderCookTonight([])).toContain("Nothing fully in stock");
  });

  it("lists recipe titles", () => {
    const text = renderCookTonight([{ title: "Beans on toast", ingredients: [], missingCount: 0 }]);
    expect(text).toContain("Beans on toast");
  });
});

describe("renderAlmostThereRecipe", () => {
  it("lists only the missing ingredients with quantity", () => {
    const text = renderAlmostThereRecipe({
      title: "Chili",
      ingredients: [
        { name: "kidney beans", quantity: 1, unit: "can", present: false },
        { name: "rice", quantity: 200, unit: "g", present: true },
      ],
      missingCount: 1,
    });

    expect(text).toContain("Chili");
    expect(text).toContain("kidney beans (1 can)");
    expect(text).not.toContain("rice");
  });
});

describe("addMissingIngredients", () => {
  it("links a Product-matched ingredient and free-texts the rest", () => {
    const db = createDb();
    const [product] = db
      .insert(products)
      .values({ name: "kidney beans", category: "food" })
      .returning()
      .all();

    const count = addMissingIngredients(db, new FakeClock(new Date("2026-01-01T00:00:00Z")), [
      { name: "Kidney Beans" },
      { name: "chopped basil" },
    ]);

    expect(count).toBe(2);
    const rows = db.select().from(shoppingListEntries).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.source === "recipe_missing")).toBe(true);
    expect(rows.find((r) => r.productId === product!.id)?.freeText).toBeNull();
    expect(rows.find((r) => r.freeText === "chopped basil")?.productId).toBeNull();
  });
});
