import { eq, sql } from "drizzle-orm";
import type { RecipeSuggestion } from "./brain.js";
import type { Clock } from "./clock.js";
import { products, shoppingListEntries, stockLots } from "./db/schema.js";
import type { Db } from "./db.js";
import { compareExpiry } from "./inventory.js";

export interface CookInventoryItem {
  name: string;
  quantity: number;
  unit: string | null;
  estExpiry: string | null;
}

// Food only, in stock, soonest-expiring first — the ordering is what makes
// "weighted toward soonest-expiring Lots" visible in the Brain input.
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
    .where(eq(stockLots.status, "in_stock"))
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
  recipe: RecipeSuggestion,
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

function formatQuantity(quantity: number, unit: string | null): string {
  return unit ? `${quantity} ${unit}` : `${quantity}`;
}

export function renderAlmostThereRecipe(recipe: CookRecipe): string {
  const missing = recipe.ingredients.filter((i) => !i.present);
  const lines = missing.map((i) => `• ${i.name} (${formatQuantity(i.quantity, i.unit)})`);
  return [`🥘 ${recipe.title}`, `Missing ${missing.length}:`, ...lines].join("\n");
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
