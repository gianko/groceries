import { eq, sql } from "drizzle-orm";
import type { Clock } from "./clock.js";
import { products, shoppingListEntries } from "./db/schema.js";
import type { Db } from "./db.js";

export type ShoppingListSource =
  | "finished"
  | "staple"
  | "recipe_missing"
  | "manual"
  | "cycle_guess";

export interface ShoppingListEntry {
  id: number;
  source: ShoppingListSource;
  productName: string | null;
  freeText: string | null;
}

export function fetchOpenEntries(db: Db): ShoppingListEntry[] {
  return db
    .select({
      id: shoppingListEntries.id,
      source: shoppingListEntries.source,
      productName: products.name,
      freeText: shoppingListEntries.freeText,
    })
    .from(shoppingListEntries)
    .leftJoin(products, eq(shoppingListEntries.productId, products.id))
    .where(eq(shoppingListEntries.status, "open"))
    .orderBy(sql`lower(coalesce(${products.name}, ${shoppingListEntries.freeText}))`)
    .all();
}

// Manual add matches an existing Product by exact name only (case-insensitive
// so "milk" and "Milk" don't fork), never fuzzily — anything that isn't an
// exact Catalog match becomes a free-text entry instead of guessing.
export function addManualEntry(db: Db, clock: Clock, rawText: string): ShoppingListEntry {
  const text = rawText.trim();
  const product = db
    .select()
    .from(products)
    .where(sql`lower(${products.name}) = lower(${text})`)
    .get();

  const createdAt = clock.now().toISOString();

  const [inserted] = db
    .insert(shoppingListEntries)
    .values({
      source: "manual",
      productId: product?.id ?? null,
      freeText: product ? null : text,
      status: "open",
      createdAt,
    })
    .returning()
    .all();

  return {
    id: inserted!.id,
    source: "manual",
    productName: product?.name ?? null,
    freeText: product ? null : text,
  };
}

export function renderList(entries: ShoppingListEntry[]): string {
  if (entries.length === 0) {
    return "🛒 Shopping list is empty.";
  }

  const lines = entries.map((entry) => `• ${entry.productName ?? entry.freeText}`);
  return ["🛒 Shopping list", ...lines].join("\n");
}
