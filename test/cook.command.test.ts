import type { InlineKeyboardMarkup } from "grammy/types";
import { beforeEach, describe, expect, it } from "vitest";
import type { RecipeContext, RecipeSuggestion } from "../src/brain.js";
import { BrainUnavailableError } from "../src/brain.js";
import type { Config } from "../src/config.js";
import { products, shoppingListEntries, stockLots } from "../src/db/schema.js";
import { fail, ok } from "./support/brainFake.js";
import { createTestHarness, type TestHarness } from "./support/harness.js";
import { callbackQueryUpdate, textMessageUpdate } from "./support/updates.js";

const ALLOWED_USER_A = 111;
const ALLOWED_USER_B = 222;
const GROUP_CHAT_ID = -1001234567890;

const config: Config = {
  telegramBotToken: "test-token",
  geminiApiKey: "test-key",
  allowedUserIds: [ALLOWED_USER_A, ALLOWED_USER_B],
  groupChatId: GROUP_CHAT_ID,
  tz: "Europe/Dublin",
  dbPath: ":memory:",
  heartbeatPath: "heartbeat",
  heartbeatIntervalMs: 30_000,
  heartbeatStaleMs: 90_000,
  snapshotPath: "pantry.snapshot.db",
  snapshotCron: "0 3 * * *",
};

function seedLot(
  harness: TestHarness,
  overrides: {
    name: string;
    category?: "food" | "household";
    isStaple?: boolean;
    estExpiry?: string | null;
    unit?: string | null;
  },
): void {
  const [product] = harness.db
    .insert(products)
    .values({
      name: overrides.name,
      category: overrides.category ?? "food",
      isStaple: overrides.isStaple ?? false,
    })
    .returning()
    .all();

  harness.db
    .insert(stockLots)
    .values({
      productId: product!.id,
      quantity: 1,
      unit: overrides.unit ?? null,
      purchasedAt: "2026-07-01",
      estExpiry: overrides.estExpiry ?? null,
      status: "in_stock",
    })
    .run();
}

async function runCook(harness: TestHarness): Promise<void> {
  await harness.handleUpdate(
    textMessageUpdate({ userId: ALLOWED_USER_A, chatId: GROUP_CHAT_ID, text: "/cook" }),
  );
}

const COOK_ADD_MISSING = "cook:addmissing";

// Mirrors findConfirmMarkup in receipt.command.test.ts: the stub transport
// assigns sequential message ids starting at 1000 in call order, so the
// recipe title pins down which reply this is.
function findRecipeMarkup(
  harness: TestHarness,
  titleSubstring: string,
): { messageId: number; markup: InlineKeyboardMarkup } {
  const index = harness.calls.findIndex((c) =>
    (c.payload.text as string)?.includes(titleSubstring),
  );
  return {
    messageId: 1000 + index,
    markup: harness.calls[index]!.payload.reply_markup as InlineKeyboardMarkup,
  };
}

describe("/cook", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness(config);
  });

  it("passes food inventory sorted soonest-expiring first, plus the prefs blurb", async () => {
    seedLot(harness, { name: "bread", estExpiry: "2026-07-20" });
    seedLot(harness, { name: "milk", estExpiry: "2026-07-18", unit: "l" });
    seedLot(harness, { name: "soap", category: "household" });

    harness.brain.scriptSuggestRecipes(ok([]));
    await runCook(harness);

    const call = harness.brain.calls.find((c) => c.method === "suggestRecipes");
    const input = call!.args[0] as RecipeContext;

    expect(input.inventory.map((i) => i.name)).toEqual(["milk", "bread"]);
    expect(input.inventory.every((i) => i.category === "food")).toBe(true);
  });

  it("puts a fully-covered recipe in Cook tonight", async () => {
    seedLot(harness, { name: "bread" });
    const recipe: RecipeSuggestion = {
      title: "Beans on toast",
      ingredients: [{ name: "bread", quantity: 2, unit: "slice", present: true }],
      missingCount: 0,
    };
    harness.brain.scriptSuggestRecipes(ok([recipe]));

    await runCook(harness);

    const text = harness.calls.find((c) => c.payload.text)!.payload.text as string;
    expect(text).toContain("Cook tonight");
    expect(text).toContain("Beans on toast");
  });

  it("puts a <=3-missing recipe in Almost there with an add-missing button", async () => {
    seedLot(harness, { name: "rice" });
    const recipe: RecipeSuggestion = {
      title: "Chili",
      ingredients: [
        { name: "rice", quantity: 200, unit: "g", present: true },
        { name: "kidney beans", quantity: 1, unit: "can", present: false },
      ],
      missingCount: 1,
    };
    harness.brain.scriptSuggestRecipes(ok([recipe]));

    await runCook(harness);

    const cookCall = harness.calls.find((c) => (c.payload.text as string)?.includes("Chili"));
    expect(cookCall!.payload.text).toContain("kidney beans");
    expect(cookCall!.payload.reply_markup).toBeDefined();
    const markup = cookCall!.payload.reply_markup as InlineKeyboardMarkup;
    expect(markup.inline_keyboard[0]![0]!.text).toContain("Add 1 missing item");
  });

  it("reclassifies a hallucinated present ingredient as missing (not a verbatim Catalog match)", async () => {
    seedLot(harness, { name: "rice" });
    const recipe: RecipeSuggestion = {
      title: "Fried rice",
      ingredients: [
        { name: "rice", quantity: 200, unit: "g", present: true },
        { name: "chopped scallions", quantity: 1, unit: null, present: true },
      ],
      missingCount: 0,
    };
    harness.brain.scriptSuggestRecipes(ok([recipe]));

    await runCook(harness);

    const recipeCall = harness.calls.find((c) =>
      (c.payload.text as string)?.includes("Fried rice"),
    );
    expect(recipeCall!.payload.text).toContain("chopped scallions");
    expect(recipeCall!.payload.reply_markup).toBeDefined();
  });

  it("never counts a Staple as missing", async () => {
    seedLot(harness, { name: "salt", isStaple: true });
    const recipe: RecipeSuggestion = {
      title: "Simple pasta",
      ingredients: [{ name: "salt", quantity: 1, unit: "pinch", present: false }],
      missingCount: 1,
    };
    harness.brain.scriptSuggestRecipes(ok([recipe]));

    await runCook(harness);

    const text = harness.calls.find((c) => c.payload.text)!.payload.text as string;
    expect(text).toContain("Cook tonight");
    expect(text).toContain("Simple pasta");
  });

  it("drops a recipe with more than 3 actual missing ingredients", async () => {
    const recipe: RecipeSuggestion = {
      title: "Fancy stew",
      ingredients: [
        { name: "a", quantity: 1, unit: null, present: false },
        { name: "b", quantity: 1, unit: null, present: false },
        { name: "c", quantity: 1, unit: null, present: false },
        { name: "d", quantity: 1, unit: null, present: false },
      ],
      missingCount: 4,
    };
    harness.brain.scriptSuggestRecipes(ok([recipe]));

    await runCook(harness);

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]!.payload.text).toContain("No recipe ideas");
  });

  it("surfaces the busy message when the Brain is unavailable", async () => {
    harness.brain.scriptSuggestRecipes(fail(new BrainUnavailableError("nope")));

    await runCook(harness);

    expect(harness.calls[0]!.payload.text).toContain("busy");
  });

  it("writes recipe_missing entries in one tap and removes the button", async () => {
    seedLot(harness, { name: "rice" });
    const recipe: RecipeSuggestion = {
      title: "Chili",
      ingredients: [
        { name: "rice", quantity: 200, unit: "g", present: true },
        { name: "kidney beans", quantity: 1, unit: "can", present: false },
      ],
      missingCount: 1,
    };
    harness.brain.scriptSuggestRecipes(ok([recipe]));
    await runCook(harness);

    const { messageId, markup } = findRecipeMarkup(harness, "Chili");

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: COOK_ADD_MISSING,
        messageId,
        replyMarkup: markup,
      }),
    );

    const rows = harness.db.select().from(shoppingListEntries).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("recipe_missing");
    expect(rows[0]?.freeText).toBe("kidney beans");

    const answer = harness.calls.find((c) => c.method === "answerCallbackQuery");
    expect(answer!.payload.text).toContain("Added 1 item");
  });

  it("first-tap-wins on the add-missing button", async () => {
    const recipe: RecipeSuggestion = {
      title: "Chili",
      ingredients: [{ name: "kidney beans", quantity: 1, unit: "can", present: false }],
      missingCount: 1,
    };
    harness.brain.scriptSuggestRecipes(ok([recipe]));
    await runCook(harness);

    const { messageId, markup } = findRecipeMarkup(harness, "Chili");

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: COOK_ADD_MISSING,
        messageId,
        replyMarkup: markup,
      }),
    );
    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_B,
        chatId: GROUP_CHAT_ID,
        data: COOK_ADD_MISSING,
        messageId,
        replyMarkup: markup,
      }),
    );

    const rows = harness.db.select().from(shoppingListEntries).all();
    expect(rows).toHaveLength(1);

    const answers = harness.calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.map((c) => c.payload.text)).toEqual(["Added 1 item", "Already handled"]);
  });
});
