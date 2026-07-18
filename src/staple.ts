import { eq, sql } from "drizzle-orm";
import { products } from "./db/schema.js";
import type { Db } from "./db.js";

export interface StapleResult {
  productName: string;
  created: boolean;
}

// Matches an existing Product by exact (case-insensitive) name, same as
// addManualEntry; declaring a Staple creates the Product if the Catalog
// lacks it (per the ticket) instead of requiring it be bought first. New
// Products default to "food" — every worked example (salt, oil, pepper) is
// food, and /staple takes no category argument to pick otherwise.
export function setStaple(db: Db, rawName: string): StapleResult {
  const name = rawName.trim();

  const existing = db
    .select()
    .from(products)
    .where(sql`lower(${products.name}) = lower(${name})`)
    .get();

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
