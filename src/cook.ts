import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { RecipeSuggestion } from "./brain.js";
import type { Clock } from "./clock.js";
import { expiryVerdicts, products, recipes, shoppingListEntries, stockLots } from "./db/schema.js";
import type { Db } from "./db.js";
import { compareExpiry } from "./inventory.js";

export interface CookInventoryItem {
  name: string;
  quantity: number;
  unit: string | null;
  estExpiry: string | null;
}

// Food only, in stock, soonest-expiring first — the ordering is what makes
// "weighted toward soonest-expiring Lots" visible in the Brain input. A Lot
// with an outstanding gone/still-good verdict is excluded even though it's
// still in_stock: an ignored Expiry Digest prompt degrades gracefully by
// falling out of recipe trust rather than blocking on a human tap (per
// ADR-0002 and the Expiry Digest ticket).
export function fetchFoodInventory(db: Db): CookInventoryItem[] {
  const rows = db
    .select({
      name: products.name,
      category: products.category,
      quantity: stockLots.quantity,
      unit: stockLots.unit,
      estExpiry: stockLots.estExpiry,
    })
    .from(stockLots)
    .innerJoin(products, eq(stockLots.productId, products.id))
    .leftJoin(expiryVerdicts, eq(expiryVerdicts.lotId, stockLots.id))
    .where(and(eq(stockLots.status, "in_stock"), isNull(expiryVerdicts.lotId)))
    .all();

  return rows
    .filter((row) => row.category === "food")
    .map(({ name, quantity, unit, estExpiry }) => ({ name, quantity, unit, estExpiry }))
    .sort((a, b) => compareExpiry(a.estExpiry, b.estExpiry) || a.name.localeCompare(b.name));
}

export interface CookIngredient {
  name: string;
  quantity: number;
  unit: string | null;
  present: boolean;
}

export interface CookRecipe {
  title: string;
  ingredients: CookIngredient[];
  missingCount: number;
  // null only for a favorite whose most-recently-cooked row predates this
  // field (or was never re-cooked since) — see fetchFavoriteRecipes.
  instructions: string[] | null;
}

// The Brain is told to reference in-stock ingredients verbatim by Catalog
// name; this is the backstop. Any ingredient the Brain marked "present" that
// isn't an exact (case-insensitive) match for a name in the food inventory
// handed to it is reclassified as missing — a hallucinated or paraphrased
// name never counts as stock. Staples are exempt in the other direction:
// they're assumed always present regardless of what the Brain said or
// whether they even appear in the inventory list (per CONTEXT.md, a Staple
// can exist with zero Stock Lots).
export function reclassifyRecipe(
  recipe: Omit<RecipeSuggestion, "instructions"> & { instructions: string[] | null },
  inventoryNames: ReadonlySet<string>,
  stapleNames: ReadonlySet<string>,
): CookRecipe {
  const ingredients: CookIngredient[] = recipe.ingredients.map((ingredient) => {
    const lower = ingredient.name.trim().toLowerCase();
    const present = stapleNames.has(lower) || (ingredient.present && inventoryNames.has(lower));
    return {
      name: ingredient.name,
      quantity: ingredient.quantity,
      unit: ingredient.unit ?? null,
      present,
    };
  });

  return {
    title: recipe.title,
    ingredients,
    missingCount: ingredients.filter((i) => !i.present).length,
    instructions: recipe.instructions,
  };
}

export function fetchStapleNames(db: Db): Set<string> {
  const rows = db
    .select({ name: products.name })
    .from(products)
    .where(eq(products.isStaple, true))
    .all();
  return new Set(rows.map((r) => r.name.toLowerCase()));
}

export interface CookSuggestions {
  cookTonight: CookRecipe[];
  almostThere: CookRecipe[];
}

// Only the two tiers the feature promises are shown: a recipe reclassified
// to more than 3 actual missing ingredients fits neither, so it's dropped.
export function tierRecipes(recipes: CookRecipe[]): CookSuggestions {
  return {
    cookTonight: recipes.filter((r) => r.missingCount === 0),
    almostThere: recipes.filter((r) => r.missingCount > 0 && r.missingCount <= 3),
  };
}

export function renderCookTonight(recipes: CookRecipe[]): string {
  if (recipes.length === 0) {
    return "🍳 Nothing fully in stock for tonight.";
  }
  const lines = recipes.map((r) => `• ${r.title}`);
  return ["🍳 Cook tonight", ...lines].join("\n");
}

export function renderFavoritesTonight(favoriteRecipes: CookRecipe[]): string {
  const lines = favoriteRecipes.map((r) => `• ${r.title}`);
  return ["⭐ Favorites you can cook tonight", ...lines].join("\n");
}

function formatQuantity(quantity: number, unit: string | null): string {
  return unit ? `${quantity} ${unit}` : `${quantity}`;
}

export function renderAlmostThereRecipe(recipe: CookRecipe): string {
  const missing = recipe.ingredients.filter((i) => !i.present);
  const lines = missing.map((i) => `• ${i.name} (${formatQuantity(i.quantity, i.unit)})`);
  return [`🥘 ${recipe.title}`, `Missing ${missing.length}:`, ...lines].join("\n");
}

// A guessed leftover is worse than asking: below this fraction of a Lot's
// original quantity, "cooking this" stops short of writing the decrement and
// instead surfaces the Lot for a Finish-Confirmation tap (per the ticket's
// ~25% threshold and ADR-0002 — the decrement write itself is authorized by
// the "cooking this" tap, but a near-empty remainder is too uncertain to
// commit as a number).
const FINISH_CONFIRMATION_THRESHOLD = 0.25;

function unitsMatch(a: string | null, b: string | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

interface MatchableLot {
  id: number;
  productName: string;
  quantity: number;
  unit: string | null;
  estExpiry: string | null;
}

function toFinishConfirmation(lot: MatchableLot): FinishConfirmationLot {
  return { lotId: lot.id, productName: lot.productName, quantity: lot.quantity, unit: lot.unit };
}

function fetchLotsForProduct<TDb extends Pick<Db, "select">>(
  db: TDb,
  name: string,
): MatchableLot[] {
  const rows = db
    .select({
      id: stockLots.id,
      productName: products.name,
      quantity: stockLots.quantity,
      unit: stockLots.unit,
      estExpiry: stockLots.estExpiry,
    })
    .from(stockLots)
    .innerJoin(products, eq(stockLots.productId, products.id))
    .where(and(eq(stockLots.status, "in_stock"), sql`lower(${products.name}) = lower(${name})`))
    .all();

  return rows.sort((a, b) => compareExpiry(a.estExpiry, b.estExpiry) || a.id - b.id);
}

export interface DecrementedLot {
  lotId: number;
  productName: string;
  before: number;
  after: number;
}

export interface FinishConfirmationLot {
  lotId: number;
  productName: string;
  quantity: number;
  unit: string | null;
}

export interface CookDecrementResult {
  decremented: DecrementedLot[];
  finishConfirmations: FinishConfirmationLot[];
}

// The one write "cooking this" is allowed to make: matched Lots decrement by
// the recipe's own ingredient quantities, soonest-expiry first. A Lot whose
// unit doesn't match the recipe ingredient, or whose remainder would land at
// or below FINISH_CONFIRMATION_THRESHOLD, is left untouched and reported as
// needing a Finish-Confirmation instead — see the threshold comment above.
// Ingredients the recipe marked absent (missing, or a Staple with no Lots at
// all) are skipped: nothing to decrement.
export function decrementForRecipe(db: Db, recipe: CookRecipe): CookDecrementResult {
  const decremented: DecrementedLot[] = [];
  const finishConfirmations: FinishConfirmationLot[] = [];

  db.transaction((tx) => {
    for (const ingredient of recipe.ingredients) {
      if (!ingredient.present) {
        continue;
      }

      const lots = fetchLotsForProduct(tx, ingredient.name);
      let needed = ingredient.quantity;

      for (const lot of lots) {
        if (needed <= 0) {
          break;
        }

        if (!unitsMatch(ingredient.unit, lot.unit)) {
          finishConfirmations.push(toFinishConfirmation(lot));
          continue;
        }

        const take = Math.min(needed, lot.quantity);
        const remainder = lot.quantity - take;
        const remainderRatio = lot.quantity > 0 ? remainder / lot.quantity : 0;

        if (remainderRatio <= FINISH_CONFIRMATION_THRESHOLD) {
          finishConfirmations.push(toFinishConfirmation(lot));
        } else {
          tx.update(stockLots).set({ quantity: remainder }).where(eq(stockLots.id, lot.id)).run();
          decremented.push({
            lotId: lot.id,
            productName: lot.productName,
            before: lot.quantity,
            after: remainder,
          });
        }

        needed -= take;
      }
    }
  });

  return { decremented, finishConfirmations };
}

export function renderCookingThisResult(title: string, result: CookDecrementResult): string {
  const lines = [`🍳 Cooking ${title}`];

  if (result.decremented.length > 0) {
    lines.push("Used:");
    for (const lot of result.decremented) {
      lines.push(`• ${lot.productName} (${lot.before} → ${lot.after})`);
    }
  }

  if (result.finishConfirmations.length > 0) {
    lines.push("Nearly out — confirm below:");
    for (const lot of result.finishConfirmations) {
      lines.push(`• ${lot.productName}`);
    }
  }

  if (result.decremented.length === 0 && result.finishConfirmations.length === 0) {
    lines.push("Nothing to update.");
  }

  return lines.join("\n");
}

// Writes each missing ingredient as a recipe_missing entry: Product-linked
// when the name is an exact (case-insensitive) Catalog match, free text
// otherwise — the ingredient joins the Catalog itself only when it's first
// purchased, never here.
export function addMissingIngredients(
  db: Db,
  clock: Clock,
  ingredients: { name: string }[],
): number {
  const createdAt = clock.now().toISOString();

  db.transaction((tx) => {
    for (const ingredient of ingredients) {
      const name = ingredient.name.trim();
      const product = tx
        .select()
        .from(products)
        .where(sql`lower(${products.name}) = lower(${name})`)
        .get();

      tx.insert(shoppingListEntries)
        .values({
          source: "recipe_missing",
          productId: product?.id ?? null,
          freeText: product ? null : name,
          status: "open",
          createdAt,
        })
        .run();
    }
  });

  return ingredients.length;
}

export interface SavedRecipeIngredient {
  name: string;
  quantity: number;
  unit: string | null;
}

export interface FavoriteRecipe {
  title: string;
  ingredients: SavedRecipeIngredient[];
  instructions: string[] | null;
}

// One row per "cooking this" tap, the recipe as actually cooked. Rating
// starts unset — the row is itself the pending-rating state, same as an
// unanswered Finish-Confirmation (ADR-0002: only a human tap flips it).
export function saveCookedRecipe(db: Db, clock: Clock, recipe: CookRecipe): number {
  const [inserted] = db
    .insert(recipes)
    .values({
      title: recipe.title,
      ingredients: recipe.ingredients.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unit: i.unit,
      })),
      instructions: recipe.instructions,
      rating: null,
      createdAt: clock.now().toISOString(),
    })
    .returning()
    .all();
  return inserted!.id;
}

// Guarding the WHERE on rating being unset makes this the same atomic
// first-tap-wins primitive as finishLot: of a racing 👍/👎 pair on the same
// recipe row, only the first succeeds.
export function rateRecipe(db: Db, recipeId: number, rating: "up" | "down"): boolean {
  const result = db
    .update(recipes)
    .set({ rating })
    .where(and(eq(recipes.id, recipeId), isNull(recipes.rating)))
    .run();
  return result.changes > 0;
}

// A recipe can be cooked (and rated) more than once under the same title;
// only the most recently cooked verdict decides whether it's still a
// favorite, so a later 👎 supersedes an earlier 👍 on a re-cook.
export function fetchFavoriteRecipes(db: Db): FavoriteRecipe[] {
  const rows = db
    .select({
      title: recipes.title,
      ingredients: recipes.ingredients,
      instructions: recipes.instructions,
      rating: recipes.rating,
    })
    .from(recipes)
    .orderBy(desc(recipes.id))
    .all();

  const latestByTitle = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = row.title.toLowerCase();
    if (!latestByTitle.has(key)) {
      latestByTitle.set(key, row);
    }
  }

  return [...latestByTitle.values()]
    .filter((row) => row.rating === "up")
    .map((row) => ({
      title: row.title,
      ingredients: row.ingredients,
      instructions: row.instructions ?? null,
    }));
}

// The deterministic favorites-first pass: a liked recipe is only surfaced
// when it's fully coverable by current inventory via the same exact
// (case-insensitive) Product-name match reclassifyRecipe uses, Staples
// exempt. A favorite short even one ingredient is dropped here entirely —
// per the ticket, it must not pre-empt the LLM pass, and there's no
// Almost-there tier for favorites.
export function fetchCoverableFavorites(
  favorites: FavoriteRecipe[],
  inventoryNames: ReadonlySet<string>,
  stapleNames: ReadonlySet<string>,
): CookRecipe[] {
  return favorites
    .map((favorite) =>
      reclassifyRecipe(
        {
          title: favorite.title,
          ingredients: favorite.ingredients.map((i) => ({ ...i, present: true })),
          missingCount: 0,
          instructions: favorite.instructions,
        },
        inventoryNames,
        stapleNames,
      ),
    )
    .filter((recipe) => recipe.missingCount === 0);
}
