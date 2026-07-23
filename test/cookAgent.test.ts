import { describe, expect, it } from "vitest";
import type { ChatTurn } from "../src/brain.js";
import { type CookAgentDeps, confirmCook, sendMessage } from "../src/cookAgent.js";
import { products, stockLots } from "../src/db/schema.js";
import { createDb, type Db } from "../src/db.js";
import { BrainFake, fail, ok } from "./support/brainFake.js";
import { FakeClock } from "./support/fakeClock.js";

function seedProduct(db: Db, overrides: { name: string; isStaple?: boolean }): number {
  const [product] = db
    .insert(products)
    .values({ name: overrides.name, category: "food", isStaple: overrides.isStaple ?? false })
    .returning()
    .all();
  return product!.id;
}

function seedLot(db: Db, productId: number, quantity = 10): number {
  const [lot] = db
    .insert(stockLots)
    .values({
      productId,
      quantity,
      unit: null,
      purchasedAt: "2026-01-01",
      estExpiry: null,
      status: "in_stock",
    })
    .returning()
    .all();
  return lot!.id;
}

function makeDeps(brain: BrainFake, db: Db): CookAgentDeps {
  return { db, brain, clock: new FakeClock(new Date("2026-07-01T00:00:00Z")) };
}

describe("sendMessage", () => {
  it("calls the Brain for suggestions and attaches each recipe returned", async () => {
    const db = createDb();
    const brain = new BrainFake();
    brain.scriptConverse(
      ok<ChatTurn>({ role: "toolCall", call: { name: "suggestRecipes", args: {} } }),
      ok<ChatTurn>({ role: "model", text: "How about Pasta bake?" }),
    );
    brain.scriptSuggestRecipes(
      ok([
        {
          title: "Pasta bake",
          ingredients: [{ name: "Pasta", quantity: 1, unit: null, present: true }],
          missingCount: 0,
          instructions: ["Boil, then bake."],
        },
      ]),
    );

    const result = await sendMessage([], "what should I cook?", makeDeps(brain, db));

    expect(result.reply).toBe("How about Pasta bake?");
    expect(result.attachments).toEqual([
      {
        type: "recipe",
        recipe: {
          title: "Pasta bake",
          ingredients: [{ name: "Pasta", quantity: 1, unit: null, present: false }],
          missingCount: 1,
          instructions: ["Boil, then bake."],
        },
      },
    ]);
  });

  it("passes a constraint through to the Brain call", async () => {
    const db = createDb();
    const brain = new BrainFake();
    brain.scriptConverse(
      ok<ChatTurn>({
        role: "toolCall",
        call: { name: "suggestRecipes", args: { constraint: "something with chicken" } },
      }),
      ok<ChatTurn>({ role: "model", text: "Try chicken stir-fry." }),
    );
    brain.scriptSuggestRecipes(
      ok([
        {
          title: "Chicken stir-fry",
          ingredients: [{ name: "Chicken", quantity: 1, unit: null, present: true }],
          missingCount: 0,
          instructions: ["Fry it."],
        },
      ]),
    );

    const result = await sendMessage(
      [],
      "something with the chicken that's expiring",
      makeDeps(brain, db),
    );

    expect(result.reply).toBe("Try chicken stir-fry.");
    expect(brain.calls.filter((c) => c.method === "suggestRecipes")).toHaveLength(1);
  });

  it("executes read-only and immediate-write tools without a confirm step", async () => {
    const db = createDb();
    const brain = new BrainFake();
    brain.scriptConverse(
      ok<ChatTurn>({
        role: "toolCall",
        call: { name: "addToShoppingList", args: { ingredientNames: ["Garlic"] } },
      }),
      ok<ChatTurn>({ role: "model", text: "Added garlic to the list." }),
    );

    const result = await sendMessage([], "add garlic please", makeDeps(brain, db));

    expect(result.reply).toBe("Added garlic to the list.");
  });

  it("rates a recipe immediately, with no confirm step", async () => {
    const db = createDb();
    db.run(
      `insert into recipes (title, ingredients, instructions, created_at) values ('Soup', '[]', null, '2026-01-01')`,
    );
    const [row] = db.all<{ id: number }>(`select id from recipes where title = 'Soup'`);
    const brain = new BrainFake();
    brain.scriptConverse(
      ok<ChatTurn>({
        role: "toolCall",
        call: { name: "rateRecipe", args: { recipeId: row!.id, rating: "up" } },
      }),
      ok<ChatTurn>({ role: "model", text: "Glad you liked it!" }),
    );

    const result = await sendMessage([], "that soup was great", makeDeps(brain, db));

    expect(result.reply).toBe("Glad you liked it!");
    const updated = db.all<{ rating: string | null }>(
      `select rating from recipes where id = ${row!.id}`,
    );
    expect(updated[0]?.rating).toBe("up");
  });

  it("never decrements stock when the model proposes commitCook — only a confirm step does", async () => {
    const db = createDb();
    const productId = seedProduct(db, { name: "Bread" });
    seedLot(db, productId, 10);
    const brain = new BrainFake();
    const recipe = {
      title: "Toast",
      ingredients: [{ name: "Bread", quantity: 2, unit: null, present: true }],
      missingCount: 0,
      instructions: ["Toast it."],
    };
    brain.scriptConverse(
      ok<ChatTurn>({ role: "toolCall", call: { name: "commitCook", args: { main: recipe } } }),
    );

    const result = await sendMessage([], "cook the toast", makeDeps(brain, db));

    expect(result.attachments).toEqual([
      { type: "confirmCook", meal: { main: recipe, side: null } },
    ]);
    expect(result.reply).toContain("Toast");
    const lot = db.select().from(stockLots).all()[0];
    expect(lot?.quantity).toBe(10);
  });

  it("proposes a main+side meal together in one commitCook call", async () => {
    const db = createDb();
    const brain = new BrainFake();
    const main = {
      title: "Chicken stir-fry",
      ingredients: [],
      missingCount: 0,
      instructions: ["Sear the chicken."],
    };
    const side = {
      title: "Steamed rice",
      ingredients: [],
      missingCount: 0,
      instructions: ["Steam the rice."],
    };
    brain.scriptConverse(
      ok<ChatTurn>({ role: "toolCall", call: { name: "commitCook", args: { main, side } } }),
    );

    const result = await sendMessage([], "cook a full meal", makeDeps(brain, db));

    expect(result.attachments).toEqual([{ type: "confirmCook", meal: { main, side } }]);
    expect(result.reply).toContain("Chicken stir-fry + Steamed rice");
  });

  it("surfaces a graceful reply when the Brain is unavailable", async () => {
    const db = createDb();
    const brain = new BrainFake();
    brain.scriptConverse(fail(new Error("boom")));
    // BrainUnavailableError specifically triggers the graceful path.
    const { BrainUnavailableError } = await import("../src/brain.js");
    brain.scriptConverse(fail(new BrainUnavailableError("down")));

    const result = await sendMessage([], "what's for dinner", makeDeps(brain, db));

    expect(result.reply).toContain("🧠");
  });
});

describe("confirmCook", () => {
  it("decrements stock and saves the recipe only once the confirm step runs", async () => {
    const db = createDb();
    const productId = seedProduct(db, { name: "Bread" });
    seedLot(db, productId, 10);
    const brain = new BrainFake();
    const recipe = {
      title: "Toast",
      ingredients: [{ name: "Bread", quantity: 2, unit: null, present: true }],
      missingCount: 0,
      instructions: ["Toast it."],
    };
    const history: ChatTurn[] = [
      { role: "user", text: "cook the toast" },
      { role: "toolCall", call: { name: "commitCook", args: { main: recipe } } },
    ];
    brain.scriptConverse(ok<ChatTurn>({ role: "model", text: "Enjoy your toast!" }));

    const result = await confirmCook(history, makeDeps(brain, db));

    expect(result.reply).toBe("Enjoy your toast!");
    const lot = db.select().from(stockLots).all()[0];
    expect(lot?.quantity).toBe(8);
  });

  it("decrements and saves both dishes when a side is included", async () => {
    const db = createDb();
    const breadId = seedProduct(db, { name: "Bread" });
    seedLot(db, breadId, 10);
    const riceId = seedProduct(db, { name: "Rice" });
    seedLot(db, riceId, 1000);
    const brain = new BrainFake();
    const main = {
      title: "Toast",
      ingredients: [{ name: "Bread", quantity: 2, unit: null, present: true }],
      missingCount: 0,
      instructions: null,
    };
    const side = {
      title: "Rice",
      ingredients: [{ name: "Rice", quantity: 200, unit: null, present: true }],
      missingCount: 0,
      instructions: null,
    };
    const history: ChatTurn[] = [
      { role: "toolCall", call: { name: "commitCook", args: { main, side } } },
    ];
    brain.scriptConverse(ok<ChatTurn>({ role: "model", text: "Enjoy!" }));

    const result = await confirmCook(history, makeDeps(brain, db));

    expect(result.reply).toBe("Enjoy!");
    const lots = db.select().from(stockLots).all();
    expect(lots.find((l) => l.productId === breadId)?.quantity).toBe(8);
    expect(lots.find((l) => l.productId === riceId)?.quantity).toBe(800);
    const rows = db.all<{ title: string }>(`select title from recipes`);
    expect(rows.map((r) => r.title).sort()).toEqual(["Rice", "Toast"]);
  });

  it("attaches a finish-checklist when a lot needs finish-confirmation", async () => {
    const db = createDb();
    const productId = seedProduct(db, { name: "Milk" });
    seedLot(db, productId, 1);
    const brain = new BrainFake();
    const recipe = {
      title: "Cereal",
      ingredients: [{ name: "Milk", quantity: 1, unit: null, present: true }],
      missingCount: 0,
      instructions: null,
    };
    const history: ChatTurn[] = [
      { role: "toolCall", call: { name: "commitCook", args: { main: recipe } } },
    ];
    brain.scriptConverse(ok<ChatTurn>({ role: "model", text: "All set." }));

    const result = await confirmCook(history, makeDeps(brain, db));

    expect(result.attachments).toEqual([
      {
        type: "finishChecklist",
        recipeId: expect.any(Number),
        lots: [{ lotId: expect.any(Number), productName: "Milk", quantity: 1, unit: null }],
      },
    ]);
  });

  it("throws if the history doesn't end with a pending commitCook call", async () => {
    const db = createDb();
    const brain = new BrainFake();

    await expect(
      confirmCook([{ role: "user", text: "cook it" }], makeDeps(brain, db)),
    ).rejects.toThrow();
  });
});
