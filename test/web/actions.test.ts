import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrainUnavailableError } from "../../src/brain.js";
import { products, shoppingListEntries, stockLots } from "../../src/db/schema.js";
import { createDb, type Db } from "../../src/db.js";
import { BrainFake, fail, ok } from "../support/brainFake.js";

const echoCalls: string[] = [];
const db: Db = createDb();
const brain = new BrainFake();

vi.mock("../../web/src/lib/webDb.js", () => ({
  getDb: () => db,
  getBrain: () => brain,
}));

vi.mock("../../web/src/lib/echo.js", () => ({
  sendGroupEcho: (text: string) => {
    echoCalls.push(text);
  },
}));

// Loaded after the mocks above so the module under test picks up the fakes
// — the top-level import in actions/index.ts resolves to these mocks, not
// the real DB/Telegram client. "astro:actions" itself is aliased in
// vitest.config.ts to astro's own defineAction runtime, so this exercises
// real zod validation + the real safeServerHandler/orThrow binding, not a
// stub.
const { server } = await import("../../web/src/actions/index.js");

const context = { locals: { userId: 111, userName: "Gian" } };

// biome-ignore lint/suspicious/noExplicitAny: astro's action-client type
// doesn't infer cleanly through a shared helper; callers rely on the real
// runtime shape, not this any.
function call(action: any, input: unknown): Promise<any> {
  return action.orThrow.call(context, input);
}

beforeEach(() => {
  echoCalls.length = 0;
  brain.calls.length = 0;
  db.delete(shoppingListEntries).run();
  db.delete(stockLots).run();
  db.delete(products).run();
  db.run(`delete from recipes`);
  db.run(`delete from prefs`);
});

function seedProduct(overrides: {
  name: string;
  category?: "food" | "household";
  isStaple?: boolean;
}): number {
  const [product] = db
    .insert(products)
    .values({
      name: overrides.name,
      category: overrides.category ?? "food",
      isStaple: overrides.isStaple ?? false,
    })
    .returning()
    .all();
  return product!.id;
}

function seedLot(
  productId: number,
  overrides: { quantity?: number; unit?: string | null } = {},
): number {
  const [lot] = db
    .insert(stockLots)
    .values({
      productId,
      quantity: overrides.quantity ?? 1,
      unit: overrides.unit ?? null,
      purchasedAt: "2026-01-01",
      status: "in_stock",
    })
    .returning()
    .all();
  return lot!.id;
}

describe("inventory.finishBatch", () => {
  it("finishes matched lots and reports results", async () => {
    const productId = seedProduct({ name: "Milk" });
    const lotId = seedLot(productId);

    const result = await call(server.inventory.finishBatch, { lotIds: [lotId] });

    expect(result.results).toEqual([{ lotId, finished: true, productName: "Milk" }]);
    const row = db
      .select()
      .from(stockLots)
      .all()
      .find((l) => l.id === lotId);
    expect(row?.status).toBe("finished");
  });

  it("rejects non-numeric lot ids", async () => {
    await expect(
      call(server.inventory.finishBatch, { lotIds: ["not-a-number"] }),
    ).rejects.toThrow();
  });
});

describe("inventory.decideAutoRelist", () => {
  it("applies the auto-relist decision for the product", async () => {
    const productId = seedProduct({ name: "Eggs" });

    const result = await call(server.inventory.decideAutoRelist, {
      productId,
      wantsAutoRelist: true,
    });

    expect(result).toEqual({ applied: true });
    const row = db
      .select()
      .from(products)
      .all()
      .find((p) => p.id === productId);
    expect(row?.autoRelist).toBe(true);
  });
});

describe("cook.suggestTonight", () => {
  it("returns tiered suggestions on a successful Brain call", async () => {
    const productId = seedProduct({ name: "Pasta" });
    seedLot(productId);
    brain.scriptSuggestRecipes(
      ok([
        {
          title: "Pasta bake",
          ingredients: [{ name: "Pasta", quantity: 1, unit: null, present: true }],
          missingCount: 0,
          instructions: ["Boil", "Bake"],
        },
      ]),
    );

    const result = await call(server.cook.suggestTonight, {});

    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.cookTonight.map((r) => r.title)).toContain("Pasta bake");
    }
  });

  it("reports unavailable instead of throwing when the Brain fails", async () => {
    brain.scriptSuggestRecipes(fail(new BrainUnavailableError("down")));

    const result = await call(server.cook.suggestTonight, {});

    expect(result).toEqual({ available: false });
  });
});

describe("cook.commit", () => {
  it("decrements matched lots, saves the recipe, and echoes who cooked it", async () => {
    const productId = seedProduct({ name: "Bread" });
    seedLot(productId, { quantity: 10 });

    const result = await call(server.cook.commit, {
      recipe: {
        title: "Toast",
        ingredients: [{ name: "Bread", quantity: 2, unit: null, present: true }],
        missingCount: 0,
        instructions: ["Toast it"],
      },
    });

    expect(result.decremented).toEqual([
      { lotId: expect.any(Number), productName: "Bread", before: 10, after: 8 },
    ]);
    expect(typeof result.recipeId).toBe("number");
    expect(echoCalls).toEqual(["Cooked Toast — used Bread by Gian 🍳"]);
  });

  it("omits the used-suffix when nothing was decremented", async () => {
    await call(server.cook.commit, {
      recipe: {
        title: "Cereal",
        ingredients: [],
        missingCount: 0,
        instructions: null,
      },
    });

    expect(echoCalls).toEqual(["Cooked Cereal by Gian 🍳"]);
  });
});

describe("cook.addMissing", () => {
  it("adds each ingredient and echoes once per item", async () => {
    const result = await call(server.cook.addMissing, {
      ingredientNames: ["Garlic", "Onion"],
    });

    expect(result.count).toBe(2);
    expect(echoCalls).toEqual([
      "Garlic added to shopping list by Gian 🛒",
      "Onion added to shopping list by Gian 🛒",
    ]);
  });
});

describe("cook.rate", () => {
  it("rates an existing recipe", async () => {
    db.run(
      `insert into recipes (title, ingredients, instructions, created_at) values ('Soup', '[]', '[]', '2026-01-01')`,
    );
    const [row] = db.all<{ id: number }>(`select id from recipes where title = 'Soup'`);

    const result = await call(server.cook.rate, { recipeId: row!.id, rating: "up" });

    expect(result).toEqual({ rated: true });
  });

  it("reports false for a recipe id that doesn't exist", async () => {
    const result = await call(server.cook.rate, { recipeId: 999_999, rating: "down" });

    expect(result).toEqual({ rated: false });
  });
});

describe("shopping.addManual", () => {
  it("adds a manual entry and echoes it", async () => {
    const entry = await call(server.shopping.addManual, { text: "Coffee" });

    expect(entry.freeText).toBe("Coffee");
    expect(echoCalls).toEqual(["Coffee added to shopping list by Gian 🛒"]);
  });

  it("rejects empty text", async () => {
    await expect(call(server.shopping.addManual, { text: "" })).rejects.toThrow();
  });
});

describe("shopping.checkOff", () => {
  it("checks off an open entry and echoes it", async () => {
    const [entry] = db
      .insert(shoppingListEntries)
      .values({
        source: "manual",
        freeText: "Tea",
        status: "open",
        createdAt: "2026-01-01",
      })
      .returning()
      .all();

    const result = await call(server.shopping.checkOff, { entryId: entry!.id });

    expect(result).toEqual({ checked: true });
    expect(echoCalls).toEqual(["Tea checked off by Gian ✓"]);
  });

  it("no-ops silently for an entry that isn't open", async () => {
    const result = await call(server.shopping.checkOff, { entryId: 999_999 });

    expect(result).toEqual({ checked: false });
    expect(echoCalls).toEqual([]);
  });
});

describe("shopping.acceptCycleGuess", () => {
  it("adds a cycle-guess entry and echoes it", async () => {
    const productId = seedProduct({ name: "Butter" });

    const entry = await call(server.shopping.acceptCycleGuess, {
      productId,
      productName: "Butter",
    });

    expect(entry.source).toBe("cycle_guess");
    expect(echoCalls).toEqual(["Butter (probably low) added to shopping list by Gian 🛒"]);
  });
});

describe("staple.setStaple / unstaple", () => {
  it("declares a staple, creating the product if missing, and echoes it", async () => {
    const result = await call(server.staple.setStaple, { name: "Salt" });

    expect(result.staples.map((s) => s.name)).toContain("Salt");
    expect(echoCalls).toEqual(["Salt added as a staple by Gian 📌"]);
  });

  it("removes a staple and echoes it", async () => {
    seedProduct({ name: "Pepper", isStaple: true });

    const result = await call(server.staple.unstaple, { name: "Pepper" });

    expect(result.staples.map((s) => s.name)).not.toContain("Pepper");
    expect(echoCalls).toEqual(["Pepper removed as a staple by Gian 📌"]);
  });

  it("rejects a blank name", async () => {
    await expect(call(server.staple.setStaple, { name: "" })).rejects.toThrow();
  });
});

describe("prefs.savePrefs", () => {
  it("saves household size and blurb", async () => {
    const result = await call(server.prefs.savePrefs, {
      householdSize: 3,
      blurb: "likes spicy food",
    });

    expect(result).toEqual({ householdSize: 3, blurb: "likes spicy food" });
  });

  it("rejects a household size below 1", async () => {
    await expect(call(server.prefs.savePrefs, { householdSize: 0, blurb: "" })).rejects.toThrow();
  });
});
