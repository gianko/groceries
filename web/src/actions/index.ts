import { defineAction } from "astro:actions";
import { z } from "zod";
import { BrainUnavailableError } from "../../../src/brain.js";
import { systemClock } from "../../../src/clock.js";
import {
  addMissingIngredients,
  type CookRecipe,
  decrementForRecipe,
  fetchFavoriteRecipes,
  fetchFoodInventory,
  fetchStapleNames,
  rateRecipe,
  reclassifyRecipe,
  saveCookedRecipe,
  tierRecipes,
} from "../../../src/cook.js";
import { decideAutoRelist as decideAutoRelistDb, finishBatch } from "../../../src/finish.js";
import { addManualEntry, fetchOpenEntries, type ShoppingListEntry } from "../../../src/list.js";
import { fetchPrefs, savePrefs } from "../../../src/prefs.js";
import { clearEntry } from "../../../src/reconcile.js";
import { addCycleGuessEntry } from "../../../src/shopping.js";
import { fetchStaples, setStaple, unstaple as unstapleDb } from "../../../src/staple.js";
import { sendGroupEcho } from "../lib/echo.js";
import { getBrain, getDb } from "../lib/webDb.js";

function entryLabel(entry: ShoppingListEntry): string {
  return entry.productName ?? entry.freeText ?? "";
}

// Shared "label by actor" shape for every group echo (shopping per #28/#30,
// staples per #32) — only the verb/suffix/emoji differ.
function echoEntry(label: string, verb: string, actor: string, emoji: string): void {
  sendGroupEcho(`${label} ${verb} by ${actor} ${emoji}`);
}

const cookIngredientSchema = z.object({
  name: z.string(),
  quantity: z.number(),
  unit: z.string().nullable(),
  present: z.boolean(),
});

// The client passes the full recipe object back on cook.commit/rate-adjacent
// calls per #34 — Brain-sourced suggestions are session-ephemeral with no
// server-side ID to reference, unlike #27/#30's DB-backed rows.
const cookRecipeSchema = z.object({
  title: z.string(),
  ingredients: z.array(cookIngredientSchema),
  missingCount: z.number().int().nonnegative(),
  instructions: z.array(z.string()).nullable(),
});

// Transport per #27: Astro Actions, not hand-rolled REST routes — typed
// client calls with Zod input validation for free.
export const server = {
  inventory: {
    finishBatch: defineAction({
      input: z.object({ lotIds: z.array(z.number().int()) }),
      handler: ({ lotIds }) => finishBatch(getDb(), systemClock, lotIds),
    }),
    decideAutoRelist: defineAction({
      input: z.object({
        productId: z.number().int(),
        wantsAutoRelist: z.boolean(),
      }),
      handler: ({ productId, wantsAutoRelist }) => ({
        applied: decideAutoRelistDb(getDb(), productId, wantsAutoRelist),
      }),
    }),
  },
  cook: {
    // Brain-backed phase-two fetch per #34: the page server-renders
    // Favorites-tonight immediately, and the Preact island calls this on
    // mount for Cook-tonight/Almost-there. A Brain failure surfaces as
    // `available: false` rather than an Action error, so those two sections
    // can show an inline unavailable message without blocking the screen.
    suggestTonight: defineAction({
      input: z.object({}),
      handler: async () => {
        const db = getDb();
        const inventory = fetchFoodInventory(db);
        const inventoryNames = new Set(inventory.map((item) => item.name.toLowerCase()));
        const stapleNames = fetchStapleNames(db);
        const favorites = fetchFavoriteRecipes(db);

        try {
          const suggestions = await getBrain().suggestRecipes({
            inventory: inventory.map((item) => ({
              name: item.name,
              category: "food",
              quantity: item.quantity,
              unit: item.unit,
              estExpiry: item.estExpiry,
            })),
            prefsBlurb: fetchPrefs(db).blurb,
            favoriteRecipeNames: favorites.map((f) => f.title),
          });
          const classified = suggestions.map((recipe) =>
            reclassifyRecipe(recipe, inventoryNames, stapleNames),
          );
          const { cookTonight, almostThere } = tierRecipes(classified);
          return { available: true as const, cookTonight, almostThere };
        } catch (err) {
          if (err instanceof BrainUnavailableError) {
            console.error("Brain unavailable", err.cause ?? err);
            return { available: false as const };
          }
          throw err;
        }
      },
    }),
    // Atomically decrements matched Lots then saves the cooked-recipe row,
    // unconditionally, in that order — matching COOKING_THIS_CALLBACK in
    // bot.ts. Idempotency is a client-side lockout (disable-on-tap) per #34,
    // not a server-side dedup guard.
    commit: defineAction({
      input: z.object({ recipe: cookRecipeSchema }),
      handler: ({ recipe }, context) => {
        const db = getDb();
        const result = decrementForRecipe(db, recipe as CookRecipe);
        const recipeId = saveCookedRecipe(db, systemClock, recipe as CookRecipe);

        const productNames = result.decremented.map((lot) => lot.productName);
        const usedSuffix = productNames.length > 0 ? ` — used ${productNames.join(", ")}` : "";
        sendGroupEcho(`Cooked ${recipe.title}${usedSuffix} by ${context.locals.userName} 🍳`);

        return {
          recipeId,
          decremented: result.decremented,
          finishConfirmations: result.finishConfirmations,
        };
      },
    }),
    // Direct write, no confirm step, per #34 — matches the one-tap
    // philosophy #30 established for shopping-list actions.
    addMissing: defineAction({
      input: z.object({ ingredientNames: z.array(z.string()) }),
      handler: ({ ingredientNames }, context) => {
        const db = getDb();
        const count = addMissingIngredients(
          db,
          systemClock,
          ingredientNames.map((name) => ({ name })),
        );
        for (const name of ingredientNames) {
          echoEntry(name, "added to shopping list", context.locals.userName, "🛒");
        }
        return { count };
      },
    }),
    // First-tap-wins via rateRecipe's own WHERE-guard — no revisit surface,
    // per #34. Rating doesn't echo: personal feedback, not a shared-inventory
    // consequence.
    rate: defineAction({
      input: z.object({ recipeId: z.number().int(), rating: z.enum(["up", "down"]) }),
      handler: ({ recipeId, rating }) => ({ rated: rateRecipe(getDb(), recipeId, rating) }),
    }),
  },
  shopping: {
    addManual: defineAction({
      input: z.object({ text: z.string().min(1) }),
      handler: ({ text }, context) => {
        const entry = addManualEntry(getDb(), systemClock, text);
        echoEntry(entryLabel(entry), "added to shopping list", context.locals.userName, "🛒");
        return entry;
      },
    }),
    checkOff: defineAction({
      input: z.object({ entryId: z.number().int() }),
      handler: ({ entryId }, context) => {
        const db = getDb();
        // Looked up before the flip — clearEntry only reports success, not
        // which entry it was, and a lost race means there's nothing left to
        // echo anyway.
        const entry = fetchOpenEntries(db).find((e) => e.id === entryId);
        const checked = clearEntry(db, entryId);
        if (checked && entry) {
          echoEntry(entryLabel(entry), "checked off", context.locals.userName, "✓");
        }
        return { checked };
      },
    }),
    acceptCycleGuess: defineAction({
      input: z.object({ productId: z.number().int(), productName: z.string() }),
      handler: ({ productId, productName }, context) => {
        const entry = addCycleGuessEntry(getDb(), systemClock, { productId, productName });
        echoEntry(
          `${productName} (probably low)`,
          "added to shopping list",
          context.locals.userName,
          "🛒",
        );
        return entry;
      },
    }),
  },
  staple: {
    setStaple: defineAction({
      input: z.object({ name: z.string().min(1) }),
      handler: ({ name }, context) => {
        const db = getDb();
        const result = setStaple(db, name);
        echoEntry(result.productName, "added as a staple", context.locals.userName, "📌");
        return { staples: fetchStaples(db) };
      },
    }),
    unstaple: defineAction({
      input: z.object({ name: z.string().min(1) }),
      handler: ({ name }, context) => {
        const db = getDb();
        const productName = unstapleDb(db, name);
        if (productName) {
          echoEntry(productName, "removed as a staple", context.locals.userName, "📌");
        }
        return { staples: fetchStaples(db) };
      },
    }),
  },
  prefs: {
    savePrefs: defineAction({
      input: z.object({ householdSize: z.number().int().min(1), blurb: z.string() }),
      handler: ({ householdSize, blurb }) => savePrefs(getDb(), { householdSize, blurb }),
    }),
  },
};
