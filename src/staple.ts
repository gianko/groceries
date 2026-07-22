import { eq, sql } from "drizzle-orm";
import { products } from "./db/schema.js";
import type { Db } from "./db.js";

export interface StapleResult {
  productName: string;
  created: boolean;
}

function findProductByName(db: Db, name: string) {
  return db.select().from(products).where(sql`lower(${products.name}) = lower(${name})`).get();
}

// Matches an existing Product by exact (case-insensitive) name, same as
// addManualEntry; declaring a Staple creates the Product if the Catalog
// lacks it (per the ticket) instead of requiring it be bought first. New
// Products default to "food" — every worked example (salt, oil, pepper) is
// food, and /staple takes no category argument to pick otherwise.
export function setStaple(db: Db, rawName: string): StapleResult {
  const name = rawName.trim();

  const existing = findProductByName(db, name);

  if (existing) {
    db.update(products).set({ isStaple: true }).where(eq(products.id, existing.id)).run();
    return { productName: existing.name, created: false };
  }

  const [created] = db
    .insert(products)
    .values({ name, category: "food", isStaple: true })
    .returning()
    .all();
  return { productName: created!.name, created: true };
}

export interface Staple {
  id: number;
  name: string;
  category: string;
}

// Flat, alphabetical — no Food/Household grouping like #27's inventory
// screen, since a household's Staples list is short enough that grouping
// only adds overhead.
export function fetchStaples(db: Db): Staple[] {
  return db
    .select({ id: products.id, name: products.name, category: products.category })
    .from(products)
    .where(eq(products.isStaple, true))
    .orderBy(sql`lower(${products.name})`)
    .all();
}

// Feeds the Add Staple input's autocomplete, so promoting an existing
// Product to a Staple doesn't require retyping its exact name (and risking
// a near-duplicate Product via setStaple's case-insensitive match).
export function fetchNonStapleProductNames(db: Db): string[] {
  return db
    .select({ name: products.name })
    .from(products)
    .where(eq(products.isStaple, false))
    .orderBy(sql`lower(${products.name})`)
    .all()
    .map((row) => row.name);
}

// Symmetric with setStaple, but never creates a Product — un-staple only
// ever acts on something already declared, so a no-match name is a no-op.
// Returns the matched Product's stored name (null on no-op) so callers can
// echo the actual name rather than whatever casing was typed.
export function unstaple(db: Db, rawName: string): string | null {
  const name = rawName.trim();

  const existing = findProductByName(db, name);

  if (!existing) {
    return null;
  }

  db.update(products).set({ isStaple: false }).where(eq(products.id, existing.id)).run();
  return existing.name;
}
