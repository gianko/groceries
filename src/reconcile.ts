import { and, eq, inArray } from "drizzle-orm";
import { shoppingListEntries } from "./db/schema.js";
import type { Db } from "./db.js";
import { fetchOpenEntries, type ShoppingListEntry } from "./list.js";

export interface ReconcileResult {
  doneCount: number;
  leftoverFreeText: ShoppingListEntry[];
}

// Product-linked open entries whose Product appears on the confirmed receipt
// are closed silently, matched by Product identity only — never fuzzy text
// (per the ticket). Free-text entries have no Product to match against, so
// every open free-text entry is "leftover" here and goes back to a human via
// keep/clear buttons instead of being guessed at.
export function reconcileShoppingList(db: Db, purchasedProductIds: number[]): ReconcileResult {
  let doneCount = 0;
  if (purchasedProductIds.length > 0) {
    const result = db
      .update(shoppingListEntries)
      .set({ status: "done" })
      .where(
        and(
          eq(shoppingListEntries.status, "open"),
          inArray(shoppingListEntries.productId, purchasedProductIds),
        ),
      )
      .run();
    doneCount = result.changes;
  }

  const leftoverFreeText = fetchOpenEntries(db).filter((entry) => entry.freeText !== null);
  return { doneCount, leftoverFreeText };
}

// First-tap-wins conditional UPDATE, same pattern as finishLot: two racing
// taps on the same Clear button can't both succeed.
export function clearEntry(db: Db, entryId: number): boolean {
  const result = db
    .update(shoppingListEntries)
    .set({ status: "done" })
    .where(and(eq(shoppingListEntries.id, entryId), eq(shoppingListEntries.status, "open")))
    .run();
  return result.changes > 0;
}

export function renderReconcilePrompt(entries: ShoppingListEntry[]): string {
  const lines = entries.map((entry) => `• ${entry.freeText}`);
  return ["🧾 Still need these?", ...lines].join("\n");
}
