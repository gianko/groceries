import type { InlineKeyboardMarkup } from "grammy/types";
import { beforeEach, describe, expect, it } from "vitest";
import type { RecipeContext, RecipeSuggestion } from "../src/brain.js";
import { BrainUnavailableError } from "../src/brain.js";
import type { Config } from "../src/config.js";
import { products, recipes, shoppingListEntries, stockLots } from "../src/db/schema.js";
import { fail, ok } from "./support/brainFake.js";
import { type ApiCall, createTestHarness, type TestHarness } from "./support/harness.js";
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
  digestCron: "0 17 * * *",
  webAppUrl: "https://pantry.example.com",
};

function seedLot(
  harness: TestHarness,
  overrides: {
    name: string;
    category?: "food" | "household";
    isStaple?: boolean;
    estExpiry?: string | null;
    unit?: string | null;
    quantity?: number;
  },
): number {
  const [product] = harness.db
    .insert(products)
    .values({
      name: overrides.name,
      category: overrides.category ?? "food",
      isStaple: overrides.isStaple ?? false,
    })
    .returning()
    .all();

  const [lot] = harness.db
    .insert(stockLots)
    .values({
      productId: product!.id,
      quantity: overrides.quantity ?? 1,
      unit: overrides.unit ?? null,
      purchasedAt: "2026-07-01",
      estExpiry: overrides.estExpiry ?? null,
      status: "in_stock",
    })
    .returning()
    .all();

  return lot!.id;
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

// Once callback-query handling has produced non-message calls (answerCallbackQuery,
// editMessageReplyMarkup) interleaved with replies, the stub's sequential message id
// no longer lines up with the call's raw index — only with how many sendMessage/
// sendPhoto calls preceded it. Count those instead.
function sentMessageCount(harness: TestHarness, upTo: ApiCall): number {
  return harness.calls
    .slice(0, harness.calls.indexOf(upTo) + 1)
    .filter((c) => c.method === "sendMessage" || c.method === "sendPhoto").length;
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
      instructions: [],
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
      instructions: [],
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
      instructions: [],
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
      instructions: [],
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
      instructions: [],
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
      instructions: [],
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
      instructions: [],
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

  it("decrements matched Lots on 'cooking this' and removes the tapped button", async () => {
    const breadLotId = seedLot(harness, { name: "bread", unit: "slice", quantity: 10 });
    const recipe: RecipeSuggestion = {
      title: "Beans on toast",
      ingredients: [{ name: "bread", quantity: 2, unit: "slice", present: true }],
      missingCount: 0,
      instructions: [],
    };
    harness.brain.scriptSuggestRecipes(ok([recipe]));
    await runCook(harness);

    const { messageId, markup } = findRecipeMarkup(harness, "Beans on toast");

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "cook:cooking:0",
        messageId,
        replyMarkup: markup,
      }),
    );

    const lot = harness.db
      .select()
      .from(stockLots)
      .all()
      .find((l) => l.id === breadLotId);
    expect(lot?.quantity).toBe(8);

    const resultCall = harness.calls.find((c) => (c.payload.text as string)?.includes("bread"));
    expect(resultCall!.payload.text).toContain("bread (10 → 8)");

    const answer = harness.calls.find((c) => c.method === "answerCallbackQuery");
    expect(answer!.payload.text).toBe("Logged");
  });

  it("fires a Finish-Confirmation button instead of writing a small guessed remainder", async () => {
    const riceLotId = seedLot(harness, { name: "rice", unit: "cup", quantity: 4 });
    const recipe: RecipeSuggestion = {
      title: "Fried rice",
      ingredients: [{ name: "rice", quantity: 3, unit: "cup", present: true }],
      missingCount: 0,
      instructions: [],
    };
    harness.brain.scriptSuggestRecipes(ok([recipe]));
    await runCook(harness);

    const { messageId, markup } = findRecipeMarkup(harness, "Fried rice");

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "cook:cooking:0",
        messageId,
        replyMarkup: markup,
      }),
    );

    const lot = harness.db
      .select()
      .from(stockLots)
      .all()
      .find((l) => l.id === riceLotId);
    expect(lot?.quantity).toBe(4);

    const resultCall = harness.calls.find((c) =>
      (c.payload.text as string)?.includes("Nearly out"),
    );
    expect(resultCall!.payload.text).toContain("rice");
    const finishMarkup = resultCall!.payload.reply_markup as InlineKeyboardMarkup;
    expect(finishMarkup.inline_keyboard[0]![0]!.text).toBe("Finish");
    expect((finishMarkup.inline_keyboard[0]![0] as { callback_data: string }).callback_data).toBe(
      `finish:${riceLotId}`,
    );

    // The stub transport assigns sequential message ids in the order
    // sendMessage/sendPhoto calls happen (see findRecipeMarkup above), so
    // count only those calls up to and including this reply.
    const resultMessageId = 1000 + sentMessageCount(harness, resultCall!) - 1;

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: `finish:${riceLotId}`,
        messageId: resultMessageId,
        replyMarkup: finishMarkup,
      }),
    );
    const finished = harness.db
      .select()
      .from(stockLots)
      .all()
      .find((l) => l.id === riceLotId);
    expect(finished?.status).toBe("finished");
  });

  it("first-tap-wins on the Finish-Confirmation spawned by 'cooking this'", async () => {
    const riceLotId = seedLot(harness, { name: "rice", unit: "cup", quantity: 4 });
    const recipe: RecipeSuggestion = {
      title: "Fried rice",
      ingredients: [{ name: "rice", quantity: 3, unit: "cup", present: true }],
      missingCount: 0,
      instructions: [],
    };
    harness.brain.scriptSuggestRecipes(ok([recipe]));
    await runCook(harness);

    const { messageId, markup } = findRecipeMarkup(harness, "Fried rice");
    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "cook:cooking:0",
        messageId,
        replyMarkup: markup,
      }),
    );

    const resultCall = harness.calls.find((c) =>
      (c.payload.text as string)?.includes("Nearly out"),
    );
    const finishMarkup = resultCall!.payload.reply_markup as InlineKeyboardMarkup;
    const resultMessageId = 1000 + sentMessageCount(harness, resultCall!) - 1;

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: `finish:${riceLotId}`,
        messageId: resultMessageId,
        replyMarkup: finishMarkup,
      }),
    );
    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_B,
        chatId: GROUP_CHAT_ID,
        data: `finish:${riceLotId}`,
        messageId: resultMessageId,
        replyMarkup: finishMarkup,
      }),
    );

    const finished = harness.db
      .select()
      .from(stockLots)
      .all()
      .find((l) => l.id === riceLotId);
    expect(finished?.status).toBe("finished");

    const answers = harness.calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.map((c) => c.payload.text)).toEqual([
      "Logged",
      "Marked finished",
      "Already finished",
    ]);
  });

  it("shows a 👍/👎 prompt after 'cooking this' and saves the verdict on tap", async () => {
    seedLot(harness, { name: "bread", unit: "slice", quantity: 10 });
    const recipe: RecipeSuggestion = {
      title: "Beans on toast",
      ingredients: [{ name: "bread", quantity: 2, unit: "slice", present: true }],
      missingCount: 0,
      instructions: [],
    };
    harness.brain.scriptSuggestRecipes(ok([recipe]));
    await runCook(harness);

    const { messageId, markup } = findRecipeMarkup(harness, "Beans on toast");
    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "cook:cooking:0",
        messageId,
        replyMarkup: markup,
      }),
    );

    const resultCall = harness.calls.find((c) => (c.payload.text as string)?.includes("bread"));
    const resultMarkup = resultCall!.payload.reply_markup as InlineKeyboardMarkup;
    const buttons = resultMarkup.inline_keyboard.flat() as {
      text: string;
      callback_data: string;
    }[];
    expect(buttons.map((b) => b.text)).toEqual(["👍", "👎"]);
    const upCallback = buttons.find((b) => b.text === "👍")!.callback_data;

    const resultMessageId = 1000 + sentMessageCount(harness, resultCall!) - 1;
    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: upCallback,
        messageId: resultMessageId,
        replyMarkup: resultMarkup,
      }),
    );

    const rows = harness.db.select().from(recipes).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Beans on toast");
    expect(rows[0]?.rating).toBe("up");

    const answer = harness.calls.find(
      (c) => c.method === "answerCallbackQuery" && c.payload.text === "Saved",
    );
    expect(answer).toBeDefined();
  });

  it("first-tap-wins between racing 👍/👎 taps on the rating prompt", async () => {
    seedLot(harness, { name: "bread", unit: "slice", quantity: 10 });
    const recipe: RecipeSuggestion = {
      title: "Beans on toast",
      ingredients: [{ name: "bread", quantity: 2, unit: "slice", present: true }],
      missingCount: 0,
      instructions: [],
    };
    harness.brain.scriptSuggestRecipes(ok([recipe]));
    await runCook(harness);

    const { messageId, markup } = findRecipeMarkup(harness, "Beans on toast");
    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "cook:cooking:0",
        messageId,
        replyMarkup: markup,
      }),
    );

    const resultCall = harness.calls.find((c) => (c.payload.text as string)?.includes("bread"));
    const resultMarkup = resultCall!.payload.reply_markup as InlineKeyboardMarkup;
    const buttons = resultMarkup.inline_keyboard.flat() as {
      text: string;
      callback_data: string;
    }[];
    const upCallback = buttons.find((b) => b.text === "👍")!.callback_data;
    const downCallback = buttons.find((b) => b.text === "👎")!.callback_data;
    const resultMessageId = 1000 + sentMessageCount(harness, resultCall!) - 1;

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: upCallback,
        messageId: resultMessageId,
        replyMarkup: resultMarkup,
      }),
    );
    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_B,
        chatId: GROUP_CHAT_ID,
        data: downCallback,
        messageId: resultMessageId,
        replyMarkup: resultMarkup,
      }),
    );

    const rows = harness.db.select().from(recipes).all();
    expect(rows[0]?.rating).toBe("up");

    const answers = harness.calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.map((c) => c.payload.text)).toEqual(["Logged", "Saved", "Already rated"]);
  });

  it("surfaces a liked, fully-coverable favorite before any LLM suggestion", async () => {
    seedLot(harness, { name: "bread", unit: "slice", quantity: 10 });
    harness.db
      .insert(recipes)
      .values({
        title: "Beans on toast",
        ingredients: [{ name: "bread", quantity: 2, unit: "slice" }],
        rating: "up",
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();

    harness.brain.scriptSuggestRecipes(ok([]));
    await runCook(harness);

    expect(harness.calls[0]!.payload.text).toContain("⭐ Favorites you can cook tonight");
    expect(harness.calls[0]!.payload.text).toContain("Beans on toast");

    const call = harness.brain.calls.find((c) => c.method === "suggestRecipes");
    const input = call!.args[0] as RecipeContext;
    expect(input.favoriteRecipeNames).toEqual(["Beans on toast"]);
  });

  it("does not surface a liked favorite missing an ingredient, and still calls the LLM", async () => {
    harness.db
      .insert(recipes)
      .values({
        title: "Chili",
        ingredients: [{ name: "kidney beans", quantity: 1, unit: "can" }],
        rating: "up",
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();

    harness.brain.scriptSuggestRecipes(ok([]));
    await runCook(harness);

    const favoritesCall = harness.calls.find((c) =>
      (c.payload.text as string)?.includes("⭐ Favorites"),
    );
    expect(favoritesCall).toBeUndefined();
    expect(harness.brain.calls.some((c) => c.method === "suggestRecipes")).toBe(true);
  });

  it("never surfaces a disliked recipe from the deterministic pass", async () => {
    seedLot(harness, { name: "bread", unit: "slice", quantity: 10 });
    harness.db
      .insert(recipes)
      .values({
        title: "Beans on toast",
        ingredients: [{ name: "bread", quantity: 2, unit: "slice" }],
        rating: "down",
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .run();

    harness.brain.scriptSuggestRecipes(ok([]));
    await runCook(harness);

    const favoritesCall = harness.calls.find((c) =>
      (c.payload.text as string)?.includes("⭐ Favorites"),
    );
    expect(favoritesCall).toBeUndefined();
  });

  it("first-tap-wins on 'cooking this'", async () => {
    seedLot(harness, { name: "bread", unit: "slice", quantity: 10 });
    const recipe: RecipeSuggestion = {
      title: "Beans on toast",
      ingredients: [{ name: "bread", quantity: 2, unit: "slice", present: true }],
      missingCount: 0,
      instructions: [],
    };
    harness.brain.scriptSuggestRecipes(ok([recipe]));
    await runCook(harness);

    const { messageId, markup } = findRecipeMarkup(harness, "Beans on toast");

    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_A,
        chatId: GROUP_CHAT_ID,
        data: "cook:cooking:0",
        messageId,
        replyMarkup: markup,
      }),
    );
    await harness.handleUpdate(
      callbackQueryUpdate({
        userId: ALLOWED_USER_B,
        chatId: GROUP_CHAT_ID,
        data: "cook:cooking:0",
        messageId,
        replyMarkup: markup,
      }),
    );

    const rows = harness.db.select().from(stockLots).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.quantity).toBe(8);

    const answers = harness.calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.map((c) => c.payload.text)).toEqual(["Logged", "Already handled"]);
  });
});
