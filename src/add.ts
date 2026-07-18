import { eq } from "drizzle-orm";
import type { Brain, FreeTextExtraction } from "./brain.js";
import type { Clock } from "./clock.js";
import { products, stockLots } from "./db/schema.js";
import type { Db } from "./db.js";

export interface ConfirmAddItemsResult {
  lotIds: number[];
  productIds: number[];
}

// Bootstrap/receipt-less entry: no Raw Name is involved (free text isn't a
// receipt string), so unlike confirmReceipt this never writes rawNameMap —
// the same item arriving later on a receipt normalizes against the Catalog
// by name and lands on this same Product, adding a second Lot. Purchase date
// is unknown for existing items, so every lot here is recorded as purchased
// today (per the ticket, approximate by design).
//
// Otherwise mirrors confirmReceipt: the Brain call happens before any write,
// and every write happens in one synchronous transaction afterwards, so a
// Brain failure (or retry) never leaves half-created rows behind.
export async function confirmAddItems(
  db: Db,
  brain: Brain,
  clock: Clock,
  extraction: FreeTextExtraction,
): Promise<ConfirmAddItemsResult> {
  const purchasedAt = formatDate(clock.now());

  const uniqueNames = [...new Set(extraction.lines.map((line) => line.name))];
  const existingByName = new Map<string, { id: number; shelfLifeDays: number | null }>();
  for (const name of uniqueNames) {
    const existing = db.select().from(products).where(eq(products.name, name)).get();
    if (existing) {
      existingByName.set(name, { id: existing.id, shelfLifeDays: existing.shelfLifeDays });
    }
  }

  const namesNeedingShelfLife = uniqueNames.filter(
    (name) => (existingByName.get(name)?.shelfLifeDays ?? null) === null,
  );

  const estimatedDaysByName = new Map<string, number>();
  if (namesNeedingShelfLife.length > 0) {
    const estimates = await brain.estimateShelfLife(namesNeedingShelfLife);
    for (const estimate of estimates) {
      estimatedDaysByName.set(estimate.name, estimate.days);
    }
  }

  const resolvedDays = (name: string): number | null =>
    existingByName.get(name)?.shelfLifeDays ?? estimatedDaysByName.get(name) ?? null;

  const { lotIds, productIdByName } = db.transaction((tx) => {
    const productIdByName = new Map<string, number>();

    for (const name of uniqueNames) {
      const existing = existingByName.get(name);
      if (existing) {
        productIdByName.set(name, existing.id);
        const days = estimatedDaysByName.get(name);
        if (existing.shelfLifeDays === null && days !== undefined) {
          tx.update(products)
            .set({ shelfLifeDays: days })
            .where(eq(products.id, existing.id))
            .run();
        }
        continue;
      }

      const line = extraction.lines.find((l) => l.name === name)!;
      const [created] = tx
        .insert(products)
        .values({ name, category: line.category, shelfLifeDays: resolvedDays(name) })
        .returning()
        .all();
      productIdByName.set(name, created!.id);
    }

    const insertedLotIds: number[] = [];
    for (const line of extraction.lines) {
      const productId = productIdByName.get(line.name)!;
      const shelfLifeDays = resolvedDays(line.name);
      const estExpiry = shelfLifeDays !== null ? addDays(purchasedAt, shelfLifeDays) : null;

      const [lot] = tx
        .insert(stockLots)
        .values({
          productId,
          quantity: line.quantity,
          unit: line.unit ?? null,
          price: null,
          purchasedAt,
          estExpiry,
          status: "in_stock",
        })
        .returning()
        .all();
      insertedLotIds.push(lot!.id);
    }

    return { lotIds: insertedLotIds, productIdByName };
  });

  return { lotIds, productIds: [...productIdByName.values()] };
}

export function renderAddPreview(extraction: FreeTextExtraction): string {
  if (extraction.lines.length === 0) {
    return "No items found in that list.";
  }

  const lines = extraction.lines.map((line) => {
    const qty = line.unit ? `${line.quantity} ${line.unit}` : `${line.quantity}`;
    return `• ${line.name} (${qty})`;
  });

  return ["🧺 Parsed items:", ...lines].join("\n");
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}
