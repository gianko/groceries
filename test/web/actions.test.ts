import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrainUnavailableError, type ChatTurn } from "../../src/brain.js";
import { products, rawNameMap, shoppingListEntries, stockLots } from "../../src/db/schema.js";
import { createDb, type Db } from "../../src/db.js";
import { BrainFake, fail, ok } from "../support/brainFake.js";

const db: Db = createDb();
const brain = new BrainFake();

vi.mock("../../web/src/lib/webDb.js", () => ({
  getDb: () => db,
  getBrain: () => brain,
}));

// Loaded after the mocks above so the module under test picks up the fakes
// — the top-level import in actions/index.ts resolves to these mocks, not
// the real DB/Telegram client. "astro:actions" itself is aliased in
// vitest.config.ts to astro's own defineAction runtime, so this exercises
// real zod validation + the real safeServerHandler/orThrow binding, not a
// stub.
const { server } = await import("../../web/src/actions/index.js");

const context = { locals: { userId: 111, userName: "Gian" } };

// astro's action-client type doesn't infer cleanly through a shared helper;
// callers rely on the real runtime shape, not this any.
// biome-ignore lint/suspicious/noExplicitAny: see comment above
function call(action: any, input: unknown): Promise<any> {
  return action.orThrow.call(context, input);
}

beforeEach(() => {
  brain.calls.length = 0;
  db.delete(shoppingListEntries).run();
  db.delete(rawNameMap).run();
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
  overrides: { quantity?: number; unit?: string | null; estExpiry?: string | null } = {},
): number {
  const [lot] = db
    .insert(stockLots)
    .values({
      productId,
      quantity: overrides.quantity ?? 1,
      unit: overrides.unit ?? null,
      purchasedAt: "2026-01-01",
      estExpiry: overrides.estExpiry ?? null,
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

    expect(result.results).toEqual([
      { lotId, finished: true, productName: "Milk", finishedBy: null },
    ]);
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

describe("digest.markGone", () => {
  it("finishes the lot", async () => {
    const productId = seedProduct({ name: "Yogurt" });
    const lotId = seedLot(productId, { estExpiry: "2020-01-01" });

    const result = await call(server.digest.markGone, { lotId });

    expect(result.finished).toBe(true);
    const row = db
      .select()
      .from(stockLots)
      .all()
      .find((l) => l.id === lotId);
    expect(row?.status).toBe("finished");
  });

  it("no-ops for a lot that's already finished", async () => {
    const productId = seedProduct({ name: "Cheese" });
    const lotId = seedLot(productId, { estExpiry: "2020-01-01" });
    await call(server.digest.markGone, { lotId });

    const second = await call(server.digest.markGone, { lotId });

    expect(second.finished).toBe(false);
  });
});

describe("digest.markStillGood", () => {
  it("pushes est_expiry out from today for a just-expired lot", async () => {
    const productId = seedProduct({ name: "Bread" });
    const lotId = seedLot(productId, { estExpiry: "2020-01-01" });

    const result = await call(server.digest.markStillGood, { lotId });

    expect(result).toEqual({ applied: true });
    const row = db
      .select()
      .from(stockLots)
      .all()
      .find((l) => l.id === lotId);
    expect(row?.estExpiry).not.toBe("2020-01-01");
  });

  it("no-ops for a lot that isn't past its estimate", async () => {
    const productId = seedProduct({ name: "Rice" });
    const lotId = seedLot(productId, { estExpiry: "2099-01-01" });

    const result = await call(server.digest.markStillGood, { lotId });

    expect(result).toEqual({ applied: false });
  });
});

describe("cook.commit", () => {
  it("decrements matched lots and saves the recipe", async () => {
    const productId = seedProduct({ name: "Bread" });
    seedLot(productId, { quantity: 10 });

    const result = await call(server.cook.commit, {
      recipe: {
        title: "Toast",
        ingredients: [{ name: "Bread", quantity: 2, unit: null, present: true }],
        missingCount: 0,
        instructions: ["Toast it."],
      },
    });

    expect(result.decremented).toEqual([
      { lotId: expect.any(Number), productName: "Bread", before: 10, after: 8 },
    ]);
    expect(typeof result.recipeId).toBe("number");
  });

  it("saves a recipe with no ingredients decremented", async () => {
    const result = await call(server.cook.commit, {
      recipe: {
        title: "Cereal",
        ingredients: [],
        missingCount: 0,
        instructions: null,
      },
    });

    expect(result.decremented).toEqual([]);
    expect(typeof result.recipeId).toBe("number");
  });
});

describe("cook.addMissing", () => {
  it("adds each ingredient", async () => {
    const result = await call(server.cook.addMissing, {
      ingredientNames: ["Garlic", "Onion"],
    });

    expect(result.count).toBe(2);
  });
});

describe("cook.rate", () => {
  it("rates an existing recipe", async () => {
    db.run(
      `insert into recipes (title, ingredients, instructions, created_at) values ('Soup', '[]', null, '2026-01-01')`,
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

describe("cook.chatSend / cook.chatConfirm", () => {
  it("executes read-only and immediate-write tools without a confirm step", async () => {
    brain.scriptConverse(
      ok<ChatTurn>({
        role: "toolCall",
        call: { name: "addToShoppingList", args: { ingredientNames: ["Garlic"] } },
      }),
      ok<ChatTurn>({ role: "model", text: "Added garlic to the list." }),
    );

    const result = await call(server.cook.chatSend, {
      history: [],
      message: "add garlic please",
    });

    expect(result.reply).toBe("Added garlic to the list.");
    const entries = db.select().from(shoppingListEntries).all();
    expect(entries.map((e) => e.freeText)).toContain("Garlic");
  });

  it("never decrements stock on chatSend — only chatConfirm does, per the Stock-Lot confirm gate", async () => {
    const productId = seedProduct({ name: "Bread" });
    const lotId = seedLot(productId, { quantity: 10 });
    const recipe = {
      title: "Toast",
      ingredients: [{ name: "Bread", quantity: 2, unit: null, present: true }],
      missingCount: 0,
      instructions: ["Toast it."],
    };
    brain.scriptConverse(
      ok<ChatTurn>({ role: "toolCall", call: { name: "commitCook", args: { main: recipe } } }),
    );

    const sendResult = await call(server.cook.chatSend, {
      history: [],
      message: "cook the toast",
    });

    expect(sendResult.attachments).toEqual([
      { type: "confirmCook", meal: { main: recipe, side: null } },
    ]);
    let lot = db
      .select()
      .from(stockLots)
      .all()
      .find((l) => l.id === lotId);
    expect(lot?.quantity).toBe(10);

    brain.scriptConverse(ok<ChatTurn>({ role: "model", text: "Enjoy!" }));
    const confirmResult = await call(server.cook.chatConfirm, { history: sendResult.history });

    expect(confirmResult.reply).toBe("Enjoy!");
    lot = db
      .select()
      .from(stockLots)
      .all()
      .find((l) => l.id === lotId);
    expect(lot?.quantity).toBe(8);
  });
});

describe("receipt.parse", () => {
  it("returns the Brain's extraction with known Raw Names applied", async () => {
    const productId = seedProduct({ name: "Whole Milk" });
    db.insert(rawNameMap).values({ rawName: "MILK 2L", productId }).run();
    brain.scriptExtractReceipt(
      ok({
        lines: [
          {
            rawName: "MILK 2L",
            name: "milk",
            category: "food",
            quantity: 1,
            unit: null,
            price: 1.5,
          },
        ],
      }),
    );
    const photo = new File([new Uint8Array([1, 2, 3])], "receipt.jpg", { type: "image/jpeg" });

    const formData = new FormData();
    formData.append("photo", photo);
    const result = await call(server.receipt.parse, formData);

    expect(result.available).toBe(true);
    expect(result.extraction.lines).toEqual([
      {
        rawName: "MILK 2L",
        name: "Whole Milk",
        category: "food",
        quantity: 1,
        unit: null,
        price: 1.5,
      },
    ]);
  });

  it("reports unavailable instead of throwing when the Brain fails", async () => {
    brain.scriptExtractReceipt(fail(new BrainUnavailableError("down")));
    const photo = new File([new Uint8Array([1, 2, 3])], "receipt.jpg", { type: "image/jpeg" });

    const formData = new FormData();
    formData.append("photo", photo);
    const result = await call(server.receipt.parse, formData);

    expect(result).toEqual({ available: false });
  });
});

describe("receipt.confirm", () => {
  function extractionInput() {
    return {
      extraction: {
        lines: [
          {
            rawName: "MILK 2L",
            name: "Milk",
            category: "food" as const,
            quantity: 1,
            unit: null,
            price: 1.5,
          },
        ],
      },
    };
  }

  it("saves the extraction and reconciles the shopping list", async () => {
    brain.scriptEstimateShelfLife(ok([{ name: "Milk", days: 7 }]));
    const productId = seedProduct({ name: "Milk" });
    db.insert(shoppingListEntries)
      .values({
        source: "manual",
        productId,
        status: "open",
        createdAt: "2026-01-01",
      })
      .run();

    const result = await call(server.receipt.confirm, extractionInput());

    expect(result.available).toBe(true);
    expect(result.leftoverFreeText).toEqual([]);
    const entry = db
      .select()
      .from(shoppingListEntries)
      .all()
      .find((e) => e.productId === productId);
    expect(entry?.status).toBe("done");
  });

  it("surfaces leftover free-text entries for keep/clear", async () => {
    brain.scriptEstimateShelfLife(ok([{ name: "Milk", days: 7 }]));
    db.insert(shoppingListEntries)
      .values({
        source: "manual",
        freeText: "Napkins",
        status: "open",
        createdAt: "2026-01-01",
      })
      .run();

    const result = await call(server.receipt.confirm, extractionInput());

    expect(result.available).toBe(true);
    expect(result.leftoverFreeText.map((e: { freeText: string | null }) => e.freeText)).toEqual([
      "Napkins",
    ]);
  });

  it("reports unavailable and writes nothing when the Brain's shelf-life call fails", async () => {
    brain.scriptEstimateShelfLife(fail(new BrainUnavailableError("down")));

    const result = await call(server.receipt.confirm, extractionInput());

    expect(result).toEqual({ available: false });
    expect(db.select().from(products).all()).toEqual([]);
  });
});

describe("pantry.addFreeText", () => {
  it("parses free text and persists a Product + Stock Lot per line", async () => {
    brain.scriptParseFreeTextItems(
      ok({ lines: [{ name: "spinach", category: "food", quantity: 2, unit: "bags" }] }),
    );
    brain.scriptEstimateShelfLife(ok([{ name: "spinach", days: 5 }]));

    const result = await call(server.pantry.addFreeText, { text: "2 bags of spinach" });

    expect(result.available).toBe(true);
    expect(result.lots).toHaveLength(1);
    expect(result.lots[0]).toMatchObject({
      productName: "spinach",
      category: "food",
      quantity: 2,
      unit: "bags",
    });
  });

  it("returns no lots when the Brain finds nothing to add", async () => {
    brain.scriptParseFreeTextItems(ok({ lines: [] }));

    const result = await call(server.pantry.addFreeText, { text: "hmm" });

    expect(result).toEqual({ available: true, lots: [] });
  });

  it("reports unavailable and writes nothing when the Brain's parse call fails", async () => {
    brain.scriptParseFreeTextItems(fail(new BrainUnavailableError("down")));

    const result = await call(server.pantry.addFreeText, { text: "2 bags of spinach" });

    expect(result).toEqual({ available: false });
    expect(db.select().from(products).all()).toEqual([]);
  });

  it("rejects empty text", async () => {
    await expect(call(server.pantry.addFreeText, { text: "" })).rejects.toThrow();
  });
});

describe("shopping.addManual", () => {
  it("adds a manual entry", async () => {
    const entry = await call(server.shopping.addManual, { text: "Coffee" });

    expect(entry.freeText).toBe("Coffee");
  });

  it("rejects empty text", async () => {
    await expect(call(server.shopping.addManual, { text: "" })).rejects.toThrow();
  });
});

describe("shopping.checkOff", () => {
  it("checks off an open entry", async () => {
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
  });

  it("no-ops silently for an entry that isn't open", async () => {
    const result = await call(server.shopping.checkOff, { entryId: 999_999 });

    expect(result).toEqual({ checked: false });
  });
});

describe("shopping.acceptCycleGuess", () => {
  it("adds a cycle-guess entry", async () => {
    const productId = seedProduct({ name: "Butter" });

    const entry = await call(server.shopping.acceptCycleGuess, {
      productId,
      productName: "Butter",
    });

    expect(entry.source).toBe("cycle_guess");
  });
});

describe("staple.setStaple / unstaple", () => {
  it("declares a staple, creating the product if missing", async () => {
    const result = await call(server.staple.setStaple, { name: "Salt" });

    expect(result.staples.map((s) => s.name)).toContain("Salt");
  });

  it("removes a staple", async () => {
    seedProduct({ name: "Pepper", isStaple: true });

    const result = await call(server.staple.unstaple, { name: "Pepper" });

    expect(result.staples.map((s) => s.name)).not.toContain("Pepper");
  });

  it("returns non-staple product names for the add-staple autocomplete", async () => {
    seedProduct({ name: "Milk", isStaple: false });

    const result = await call(server.staple.setStaple, { name: "Salt" });

    expect(result.nonStapleNames).toContain("Milk");
    expect(result.nonStapleNames).not.toContain("Salt");
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
