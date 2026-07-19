import { and, eq } from "drizzle-orm";
import type { Clock } from "./clock.js";
import { products, shoppingListEntries, stockLots } from "./db/schema.js";
import type { Db } from "./db.js";

export interface FinishResult {
  finished: boolean;
  productId: number | null;
  productName: string | null;
  // True when the Product's Auto-Relist flag put a `finished`-source entry
  // straight onto the shopping list, no questions asked (per the ticket).
  autoRelisted: boolean;
  // True when the Finish-Confirmation should attach the "always re-add
  // this?" offer — only while the household hasn't answered it yet for this
  // Product, and only when Auto-Relist isn't already on.
  offerAutoRelist: boolean;
}

const notFinished: FinishResult = {
  finished: false,
  productId: null,
  productName: null,
  autoRelisted: false,
  offerAutoRelist: false,
};

// Guarding the WHERE on the current status makes this the atomic
// first-tap-wins primitive: two racing taps only ever let one succeed. Every
// Finish-Confirmation path (inventory's per-lot buttons, cook's near-empty
// threshold) routes through here, so Auto-Relist and the re-add offer are
// handled in exactly one place.
export function finishLot(db: Db, clock: Clock, lotId: number): FinishResult {
  return db.transaction((tx) => {
    const result = tx
      .update(stockLots)
      .set({ status: "finished" })
      .where(and(eq(stockLots.id, lotId), eq(stockLots.status, "in_stock")))
      .run();
    if (result.changes === 0) {
      return notFinished;
    }

    const lot = tx
      .select({ productId: stockLots.productId })
      .from(stockLots)
      .where(eq(stockLots.id, lotId))
      .get()!;
    const product = tx.select().from(products).where(eq(products.id, lot.productId)).get()!;

    let autoRelisted = false;
    if (product.autoRelist) {
      tx.insert(shoppingListEntries)
        .values({
          source: "finished",
          productId: product.id,
          freeText: null,
          status: "open",
          createdAt: clock.now().toISOString(),
        })
        .run();
      autoRelisted = true;
    }

    return {
      finished: true,
      productId: product.id,
      productName: product.name,
      autoRelisted,
      offerAutoRelist: !product.autoRelist && !product.autoRelistAsked,
    };
  });
}

// The atomic "answered" guard for the always-re-add offer, same first-tap-wins
// shape as finishLot: guarding the WHERE on autoRelistAsked being false means
// only the first of a racing Yes/No pair takes effect, and the offer never
// resurfaces afterwards (per the ticket, it stops once answered) regardless
// of which way it was answered.
export function decideAutoRelist(db: Db, productId: number, wantsAutoRelist: boolean): boolean {
  const result = db
    .update(products)
    .set({ autoRelist: wantsAutoRelist, autoRelistAsked: true })
    .where(and(eq(products.id, productId), eq(products.autoRelistAsked, false)))
    .run();
  return result.changes > 0;
}

export interface FinishBatchResult {
  results: { lotId: number; finished: boolean; productName: string }[];
  autoRelistOffers: { productId: number; productName: string }[];
}

// The Mini App's batch-confirm bar (#27) calls this once per confirm tap
// instead of firing N Action calls: one round trip, with the per-lot
// first-tap-wins race against finishLot still resolved independently for
// each lot, and the combined Auto-Relist offer assembled here rather than
// pushed onto the client.
export function finishBatch(db: Db, clock: Clock, lotIds: number[]): FinishBatchResult {
  const results: FinishBatchResult["results"] = [];
  const autoRelistOffers: FinishBatchResult["autoRelistOffers"] = [];

  for (const lotId of lotIds) {
    const outcome = finishLot(db, clock, lotId);
    const productName = outcome.productName ?? lookupProductNameForLot(db, lotId);
    results.push({ lotId, finished: outcome.finished, productName });
    if (outcome.finished && outcome.offerAutoRelist && outcome.productId !== null) {
      autoRelistOffers.push({ productId: outcome.productId, productName });
    }
  }

  return { results, autoRelistOffers };
}

// finishLot only returns a productName on success (it never looked the
// product up on the no-op path); a failed batch entry still needs one for
// the partial-failure notice, so look it up independent of status.
function lookupProductNameForLot(db: Db, lotId: number): string {
  const row = db
    .select({ productName: products.name })
    .from(stockLots)
    .innerJoin(products, eq(stockLots.productId, products.id))
    .where(eq(stockLots.id, lotId))
    .get();
  return row?.productName ?? "unknown item";
}
