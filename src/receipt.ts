import { eq } from "drizzle-orm";
import type { Brain, ReceiptExtraction } from "./brain.js";
import type { Clock } from "./clock.js";
import { products, rawNameMap, stockLots } from "./db/schema.js";
import type { Db } from "./db.js";

export interface ConfirmReceiptResult {
  lotIds: number[];
}

// Products are matched by exact normalized name, created if unseen; shelf
// life is estimated once per Product via a single batched call for every
// cache miss on this receipt, then cached on the Product row for reuse by
// later receipts. Every line's Raw Name is permanently mapped to its
// resolved Product, regardless of whether the Product was matched or
// created (per ADR-0001, known Raw Names bypass LLM naming from here on).
//
// The Brain call happens before any write, and every write happens in one
// synchronous transaction afterwards: if the Brain fails (or a retry is
// needed), no half-created Product/Lot rows are ever left behind, and a
// retry sees the exact same "nothing stored yet" starting point.
export async function confirmReceipt(
  db: Db,
  brain: Brain,
  clock: Clock,
  extraction: ReceiptExtraction,
): Promise<ConfirmReceiptResult> {
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

  const lotIds: number[] = db.transaction((tx) => {
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
          price: line.price ?? null,
          purchasedAt,
          estExpiry,
          status: "in_stock",
        })
        .returning()
        .all();
      insertedLotIds.push(lot!.id);

      tx.insert(rawNameMap)
        .values({ rawName: line.rawName, productId })
        .onConflictDoUpdate({ target: rawNameMap.rawName, set: { productId } })
        .run();
    }

    return insertedLotIds;
  });

  return { lotIds };
}

export function renderReceiptPreview(extraction: ReceiptExtraction): string {
  if (extraction.lines.length === 0) {
    return "No items found on that receipt.";
  }

  const lines = extraction.lines.map((line) => {
    const qty = line.unit ? `${line.quantity} ${line.unit}` : `${line.quantity}`;
    const price =
      line.price !== null && line.price !== undefined ? ` — €${line.price.toFixed(2)}` : "";
    return `• ${line.name} (${qty})${price}`;
  });

  return ["🧾 Parsed receipt:", ...lines].join("\n");
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}
