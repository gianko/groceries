import { describe, expect, it } from "vitest";
import type { RecipeSuggestion } from "../src/brain.js";
import {
  addMissingIngredients,
  type CookRecipe,
  decrementForRecipe,
  fetchCoverableFavorites,
  fetchFavoriteRecipes,
  fetchFoodInventory,
  fetchStapleNames,
  rateRecipe,
  reclassifyRecipe,
  renderAlmostThereRecipe,
  renderCookingThisResult,
  renderCookTonight,
  saveCookedRecipe,
  tierRecipes,
} from "../src/cook.js";
import { products, recipes, shoppingListEntries, stockLots } from "../src/db/schema.js";
import { createDb, type Db } from "../src/db.js";
import { FakeClock } from "./support/fakeClock.js";

describe("fetchFoodInventory", () => {
  it("returns only food, in-stock items, soonest-expiring first", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-07-01T00:00:00Z"));
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

    const inventory = fetchFoodInventory(db, clock);

    expect(inventory.map((i) => i.name)).toEqual(["milk", "bread"]);
    expect(inventory[0]).toEqual({ name: "milk", quantity: 1, unit: "l", estExpiry: "2026-07-18" });
  });

  it("excludes an in-stock Lot that's already past its estimate", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-07-01T00:00:00Z"));
    const [yogurt] = db
      .insert(products)
      .values({ name: "yogurt", category: "food" })
      .returning()
      .all();
    db.insert(stockLots)
      .values({
        productId: yogurt!.id,
        quantity: 1,
        purchasedAt: "2026-06-01",
        estExpiry: "2026-06-30",
        status: "in_stock",
      })
      .run();

    expect(fetchFoodInventory(db, clock)).toEqual([]);
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
    instructions: [],
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
      instructions: [],
    };
    const almostThere = {
      title: "Chili",
      ingredients: [{ name: "kidney beans", quantity: 1, unit: null, present: false }],
      missingCount: 1,
      instructions: [],
    };
    const tooManyMissing = {
      title: "Fancy stew",
      ingredients: [],
      missingCount: 4,
      instructions: [],
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
    const text = renderCookTonight([
      { title: "Beans on toast", ingredients: [], missingCount: 0, instructions: [] },
    ]);
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
      instructions: [],
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

function seedProductLot(
  db: Db,
  overrides: {
    name: string;
    quantity: number;
    unit?: string | null;
    estExpiry?: string | null;
  },
): number {
  const [product] = db
    .insert(products)
    .values({ name: overrides.name, category: "food" })
    .returning()
    .all();

  const [lot] = db
    .insert(stockLots)
    .values({
      productId: product!.id,
      quantity: overrides.quantity,
      unit: overrides.unit ?? null,
      purchasedAt: "2026-07-01",
      estExpiry: overrides.estExpiry ?? null,
      status: "in_stock",
    })
    .returning()
    .all();

  return lot!.id;
}

function cookRecipe(overrides: Partial<CookRecipe>): CookRecipe {
  return { title: "Test recipe", ingredients: [], missingCount: 0, instructions: [], ...overrides };
}

describe("decrementForRecipe", () => {
  it("decrements a matched Lot by the recipe's ingredient quantity", () => {
    const db = createDb();
    const lotId = seedProductLot(db, { name: "bread", quantity: 10, unit: "slice" });
    const recipe = cookRecipe({
      ingredients: [{ name: "bread", quantity: 2, unit: "slice", present: true }],
    });

    const result = decrementForRecipe(db, recipe);

    expect(result.decremented).toEqual([{ lotId, productName: "bread", before: 10, after: 8 }]);
    expect(result.finishConfirmations).toEqual([]);
    const lot = db
      .select()
      .from(stockLots)
      .all()
      .find((l) => l.id === lotId);
    expect(lot?.quantity).toBe(8);
  });

  it("consumes soonest-expiry Lots first, spilling over into the next Lot", () => {
    const db = createDb();
    const [product] = db
      .insert(products)
      .values({ name: "bread", category: "food" })
      .returning()
      .all();
    const [soon, later] = db
      .insert(stockLots)
      .values([
        {
          productId: product!.id,
          quantity: 10,
          unit: "slice",
          purchasedAt: "2026-07-01",
          estExpiry: "2026-07-10",
          status: "in_stock",
        },
        {
          productId: product!.id,
          quantity: 10,
          unit: "slice",
          purchasedAt: "2026-07-01",
          estExpiry: "2026-07-20",
          status: "in_stock",
        },
      ])
      .returning()
      .all();
    const soonId = soon!.id;
    const laterId = later!.id;
    const recipe = cookRecipe({
      ingredients: [{ name: "bread", quantity: 12, unit: "slice", present: true }],
    });

    const result = decrementForRecipe(db, recipe);

    // The soonest-expiry Lot is fully consumed (remainder 0, at/below the
    // threshold), so it's a Finish-Confirmation rather than a guessed write;
    // the other 2 slices spill into the later Lot, which stays well above
    // threshold and gets decremented directly.
    expect(result.finishConfirmations).toEqual([
      { lotId: soonId, productName: "bread", quantity: 10, unit: "slice" },
    ]);
    expect(result.decremented).toEqual([
      { lotId: laterId, productName: "bread", before: 10, after: 8 },
    ]);
  });

  it("fires a Finish-Confirmation instead of writing a small guessed remainder", () => {
    const db = createDb();
    const lotId = seedProductLot(db, { name: "rice", quantity: 4, unit: "cup" });
    // Remainder would be 1/4 = exactly the 25% threshold.
    const recipe = cookRecipe({
      ingredients: [{ name: "rice", quantity: 3, unit: "cup", present: true }],
    });

    const result = decrementForRecipe(db, recipe);

    expect(result.decremented).toEqual([]);
    expect(result.finishConfirmations).toEqual([
      { lotId, productName: "rice", quantity: 4, unit: "cup" },
    ]);
    const lot = db
      .select()
      .from(stockLots)
      .all()
      .find((l) => l.id === lotId);
    expect(lot?.quantity).toBe(4);
  });

  it("fires a Finish-Confirmation instead of guessing on a unit mismatch", () => {
    const db = createDb();
    const lotId = seedProductLot(db, { name: "milk", quantity: 1, unit: "l" });
    const recipe = cookRecipe({
      ingredients: [{ name: "milk", quantity: 250, unit: "ml", present: true }],
    });

    const result = decrementForRecipe(db, recipe);

    expect(result.decremented).toEqual([]);
    expect(result.finishConfirmations).toEqual([
      { lotId, productName: "milk", quantity: 1, unit: "l" },
    ]);
    const lot = db
      .select()
      .from(stockLots)
      .all()
      .find((l) => l.id === lotId);
    expect(lot?.quantity).toBe(1);
  });

  it("skips ingredients the recipe marked absent, including a Staple with no Lots", () => {
    const db = createDb();
    const recipe = cookRecipe({
      ingredients: [{ name: "salt", quantity: 1, unit: "pinch", present: true }],
    });

    const result = decrementForRecipe(db, recipe);

    expect(result.decremented).toEqual([]);
    expect(result.finishConfirmations).toEqual([]);
  });
});

describe("renderCookingThisResult", () => {
  it("lists decremented Lots and Lots awaiting Finish-Confirmation", () => {
    const text = renderCookingThisResult("Beans on toast", {
      decremented: [{ lotId: 1, productName: "bread", before: 10, after: 8 }],
      finishConfirmations: [{ lotId: 2, productName: "butter", quantity: 1, unit: null }],
    });

    expect(text).toContain("Beans on toast");
    expect(text).toContain("bread (10 → 8)");
    expect(text).toContain("butter");
  });

  it("says there's nothing to update when both lists are empty", () => {
    const text = renderCookingThisResult("Simple pasta", {
      decremented: [],
      finishConfirmations: [],
    });

    expect(text).toContain("Nothing to update");
  });
});

describe("saveCookedRecipe / rateRecipe", () => {
  it("saves a recipe with no rating, then lets the first rating tap set it", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const recipeId = saveCookedRecipe(db, clock, {
      title: "Beans on toast",
      ingredients: [{ name: "bread", quantity: 2, unit: "slice", present: true }],
      missingCount: 0,
      instructions: ["Toast bread", "Add beans"],
    });

    const saved = db
      .select()
      .from(recipes)
      .all()
      .find((r) => r.id === recipeId);
    expect(saved?.title).toBe("Beans on toast");
    expect(saved?.rating).toBeNull();
    expect(saved?.ingredients).toEqual([{ name: "bread", quantity: 2, unit: "slice" }]);

    const didRate = rateRecipe(db, recipeId, "up");

    expect(didRate).toBe(true);
    const rated = db
      .select()
      .from(recipes)
      .all()
      .find((r) => r.id === recipeId);
    expect(rated?.rating).toBe("up");
  });

  it("first-tap-wins between racing 👍/👎 on the same recipe", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const recipeId = saveCookedRecipe(db, clock, {
      title: "Chili",
      ingredients: [],
      missingCount: 0,
      instructions: [],
    });

    const first = rateRecipe(db, recipeId, "up");
    const second = rateRecipe(db, recipeId, "down");

    expect(first).toBe(true);
    expect(second).toBe(false);
    const rated = db
      .select()
      .from(recipes)
      .all()
      .find((r) => r.id === recipeId);
    expect(rated?.rating).toBe("up");
  });
});

describe("fetchFavoriteRecipes", () => {
  it("returns only recipes rated up", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const likedId = saveCookedRecipe(db, clock, {
      title: "Beans on toast",
      ingredients: [{ name: "bread", quantity: 2, unit: "slice", present: true }],
      missingCount: 0,
      instructions: ["Toast bread", "Add beans"],
    });
    const dislikedId = saveCookedRecipe(db, clock, {
      title: "Fancy stew",
      ingredients: [],
      missingCount: 0,
      instructions: [],
    });
    saveCookedRecipe(db, clock, {
      title: "Pending verdict",
      ingredients: [],
      missingCount: 0,
      instructions: [],
    });
    rateRecipe(db, likedId, "up");
    rateRecipe(db, dislikedId, "down");

    const favorites = fetchFavoriteRecipes(db);

    expect(favorites).toEqual([
      {
        title: "Beans on toast",
        ingredients: [{ name: "bread", quantity: 2, unit: "slice" }],
        instructions: ["Toast bread", "Add beans"],
      },
    ]);
  });

  it("uses only the most recently cooked verdict when a title was cooked more than once", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    const firstCookId = saveCookedRecipe(db, clock, {
      title: "Chili",
      ingredients: [{ name: "kidney beans", quantity: 1, unit: "can", present: true }],
      missingCount: 0,
      instructions: [],
    });
    rateRecipe(db, firstCookId, "up");

    const secondCookId = saveCookedRecipe(db, clock, {
      title: "Chili",
      ingredients: [{ name: "kidney beans", quantity: 1, unit: "can", present: true }],
      missingCount: 0,
      instructions: [],
    });
    rateRecipe(db, secondCookId, "down");

    expect(fetchFavoriteRecipes(db)).toEqual([]);
  });
});

describe("fetchCoverableFavorites", () => {
  it("surfaces a liked favorite whose ingredients are all in inventory (staples exempt)", () => {
    const favorites = [
      {
        title: "Beans on toast",
        ingredients: [
          { name: "bread", quantity: 2, unit: "slice" },
          { name: "salt", quantity: 1, unit: "pinch" },
        ],
        instructions: ["Toast bread"],
      },
    ];

    const result = fetchCoverableFavorites(favorites, new Set(["bread"]), new Set(["salt"]));

    expect(result).toEqual([
      {
        title: "Beans on toast",
        ingredients: [
          { name: "bread", quantity: 2, unit: "slice", present: true },
          { name: "salt", quantity: 1, unit: "pinch", present: true },
        ],
        missingCount: 0,
        instructions: ["Toast bread"],
      },
    ]);
  });

  it("drops a favorite missing even one ingredient, instead of demoting it", () => {
    const favorites = [
      {
        title: "Chili",
        ingredients: [
          { name: "kidney beans", quantity: 1, unit: "can" },
          { name: "rice", quantity: 200, unit: "g" },
        ],
        instructions: [],
      },
    ];

    const result = fetchCoverableFavorites(favorites, new Set(["rice"]), new Set());

    expect(result).toEqual([]);
  });
});
