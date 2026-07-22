import { defineAction } from "astro:actions";
import { z } from "zod";
import { confirmAddItems } from "../../../src/add.js";
import { BrainUnavailableError, receiptExtractionSchema } from "../../../src/brain.js";
import { systemClock } from "../../../src/clock.js";
import {
  addMissingIngredients,
  type CookRecipe,
  cookRecipeSchema,
  decrementForRecipe,
  fetchFavoriteRecipes,
  fetchFoodInventory,
  fetchStapleNames,
  rateRecipe,
  reclassifyRecipe,
  saveCookedRecipe,
  tierRecipes,
} from "../../../src/cook.js";
import {
  chatTurnSchema,
  confirmCook,
  cookSuggestionsSchema,
  sendMessage,
} from "../../../src/cookAgent.js";
import { markLotStillGood } from "../../../src/digest.js";
import {
  decideAutoRelist as decideAutoRelistDb,
  finishBatch,
  finishLot,
} from "../../../src/finish.js";
import { fetchLotsByIds } from "../../../src/inventory.js";
import { addManualEntry } from "../../../src/list.js";
import { fetchPrefs, savePrefs } from "../../../src/prefs.js";
import { applyKnownRawNames, confirmReceipt, fetchCatalogNames } from "../../../src/receipt.js";
import { clearEntry, reconcileShoppingList } from "../../../src/reconcile.js";
import { addCycleGuessEntry } from "../../../src/shopping.js";
import { fetchStaples, setStaple, unstaple as unstapleDb } from "../../../src/staple.js";
import { getBrain, getDb } from "../lib/webDb.js";

// Transport per #27: Astro Actions, not hand-rolled REST routes — typed
// client calls with Zod input validation for free.
export const server = {
  inventory: {
    finishBatch: defineAction({
      input: z.object({ lotIds: z.array(z.number().int()) }),
      handler: ({ lotIds }, context) =>
        finishBatch(getDb(), systemClock, lotIds, context.locals.userName),
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
  pantry: {
    // Free-text bootstrap/receipt-less entry per the restored #17 flow: the
    // Brain parses "2 bags of spinach, a dozen eggs" into lines, then
    // confirmAddItems persists them the same way a receipt line would
    // (matched-or-created Product, one Stock Lot per line), minus rawNameMap
    // since free text carries no Raw Name. A Brain failure returns
    // `available: false` so the client can show a retry toast without
    // anything half-written.
    addFreeText: defineAction({
      input: z.object({ text: z.string().min(1) }),
      handler: async ({ text }) => {
        const db = getDb();
        const brain = getBrain();
        try {
          const extraction = await brain.parseFreeTextItems(text, fetchCatalogNames(db));
          if (extraction.lines.length === 0) {
            return { available: true as const, lots: [] };
          }
          const { lotIds } = await confirmAddItems(db, brain, systemClock, extraction);
          return { available: true as const, lots: fetchLotsByIds(db, lotIds) };
        } catch (err) {
          if (err instanceof BrainUnavailableError) {
            console.error("Brain unavailable", err.cause ?? err);
            return { available: false as const };
          }
          throw err;
        }
      },
    }),
  },
  digest: {
    // "Gone" is a Finish-Confirmation, so it carries the same Auto-Relist
    // behavior as any other Finish tap — same primitive /inventory uses.
    markGone: defineAction({
      input: z.object({ lotId: z.number().int() }),
      handler: ({ lotId }, context) =>
        finishLot(getDb(), systemClock, lotId, context.locals.userName),
    }),
    // Pushes est_expiry a few days out from today; a no-op (applied: false)
    // if the Lot already stopped being just-expired, e.g. a racing tap.
    markStillGood: defineAction({
      input: z.object({ lotId: z.number().int() }),
      handler: ({ lotId }) => ({ applied: markLotStillGood(getDb(), systemClock, lotId) }),
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
        const inventory = fetchFoodInventory(db, systemClock);
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
      handler: ({ recipe }) => {
        const db = getDb();
        const result = decrementForRecipe(db, recipe as CookRecipe);
        const recipeId = saveCookedRecipe(db, systemClock, recipe as CookRecipe);

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
      handler: ({ ingredientNames }) => {
        const db = getDb();
        const count = addMissingIngredients(
          db,
          systemClock,
          ingredientNames.map((name) => ({ name })),
        );
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
    // Cook-agent chat per #50: the client holds ChatTurn[] history itself
    // (reset on page load, no server session) and resends the full history
    // each call. `loadedSuggestions` is whatever Cook-tonight/Almost-there
    // tiers the screen already loaded on mount, so the suggestRecipes tool
    // can reuse them instead of a fresh Brain call.
    chatSend: defineAction({
      input: z.object({
        history: z.array(chatTurnSchema),
        message: z.string().min(1),
        loadedSuggestions: cookSuggestionsSchema.nullable(),
      }),
      handler: ({ history, message, loadedSuggestions }) =>
        sendMessage(history, message, {
          db: getDb(),
          brain: getBrain(),
          clock: systemClock,
          loadedSuggestions,
        }),
    }),
    // The only call that's allowed to execute a pending commitCook tool call
    // — history's last turn must be that toolCall (enforced in
    // cookAgent.confirmCook), so the Stock-Lot decrement never runs without
    // this explicit second tap.
    chatConfirm: defineAction({
      input: z.object({ history: z.array(chatTurnSchema) }),
      handler: ({ history }) =>
        confirmCook(history, {
          db: getDb(),
          brain: getBrain(),
          clock: systemClock,
          loadedSuggestions: null,
        }),
    }),
  },
  receipt: {
    // FormData input (a File, not JSON) per #48 — the client posts the
    // picked photo straight through, no base64 round-trip. Nothing is
    // written here: a Brain failure returns `available: false` so a retry
    // tap costs nothing and never needs the photo re-picked.
    parse: defineAction({
      accept: "form",
      input: z.object({ photo: z.instanceof(File) }),
      handler: async ({ photo }) => {
        const db = getDb();
        const buffer = Buffer.from(await photo.arrayBuffer());
        try {
          const extraction = applyKnownRawNames(
            db,
            await getBrain().extractReceipt(buffer, fetchCatalogNames(db)),
          );
          return { available: true as const, extraction };
        } catch (err) {
          if (err instanceof BrainUnavailableError) {
            console.error("Brain unavailable", err.cause ?? err);
            return { available: false as const };
          }
          throw err;
        }
      },
    }),
    // Takes the client's (possibly user-edited) extraction wholesale — no
    // server-side pending-receipt state to reconcile against (per #48).
    // confirmReceipt only writes after its own Brain call (shelf-life
    // estimation for unseen names) succeeds, so an `available: false` here
    // means nothing was persisted and a retry is safe.
    confirm: defineAction({
      input: z.object({ extraction: receiptExtractionSchema }),
      handler: async ({ extraction }) => {
        const db = getDb();
        try {
          const result = await confirmReceipt(db, getBrain(), systemClock, extraction);
          // Same reconciliation as the old Telegram confirm flow: Product-
          // matched entries close silently, free-text leftovers come back
          // for a human keep/clear decision.
          const reconciled = reconcileShoppingList(db, result.productIds);
          return { available: true as const, leftoverFreeText: reconciled.leftoverFreeText };
        } catch (err) {
          if (err instanceof BrainUnavailableError) {
            console.error("Brain unavailable", err.cause ?? err);
            return { available: false as const };
          }
          throw err;
        }
      },
    }),
  },
  shopping: {
    addManual: defineAction({
      input: z.object({ text: z.string().min(1) }),
      handler: ({ text }) => {
        const entry = addManualEntry(getDb(), systemClock, text);
        return entry;
      },
    }),
    checkOff: defineAction({
      input: z.object({ entryId: z.number().int() }),
      handler: ({ entryId }) => {
        const checked = clearEntry(getDb(), entryId);
        return { checked };
      },
    }),
    acceptCycleGuess: defineAction({
      input: z.object({ productId: z.number().int(), productName: z.string() }),
      handler: ({ productId, productName }) => {
        const entry = addCycleGuessEntry(getDb(), systemClock, { productId, productName });
        return entry;
      },
    }),
  },
  staple: {
    setStaple: defineAction({
      input: z.object({ name: z.string().min(1) }),
      handler: ({ name }) => {
        const db = getDb();
        setStaple(db, name);
        return { staples: fetchStaples(db) };
      },
    }),
    unstaple: defineAction({
      input: z.object({ name: z.string().min(1) }),
      handler: ({ name }) => {
        const db = getDb();
        unstapleDb(db, name);
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
