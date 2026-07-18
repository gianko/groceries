import { and, eq, sql } from "drizzle-orm";
import type { Clock } from "./clock.js";
import { products, shoppingListEntries, stockLots } from "./db/schema.js";
import type { Db } from "./db.js";
import { renderEntryLine, type ShoppingListEntry } from "./list.js";

export const EXPIRING_WINDOW_DAYS = 2;

export interface ExpiringLot {
  lotId: number;
  productName: string;
  quantity: number;
  unit: string | null;
  estExpiry: string;
}

// "Use tonight / don't rebuy": in-stock Lots whose estimated expiry falls
// within EXPIRING_WINDOW_DAYS of now, soonest first. Overdue Lots (already
// past their estimate) are included too — the daily Expiry Digest is what
// asks for a gone/still-good verdict on those; this is just a heads-up.
export function fetchExpiringLots(db: Db, clock: Clock): ExpiringLot[] {
  const cutoff = addDays(formatDate(clock.now()), EXPIRING_WINDOW_DAYS);

  const rows = db
    .select({
      lotId: stockLots.id,
      productName: products.name,
      quantity: stockLots.quantity,
      unit: stockLots.unit,
      estExpiry: stockLots.estExpiry,
    })
    .from(stockLots)
    .innerJoin(products, eq(stockLots.productId, products.id))
    .where(
      and(
        eq(stockLots.status, "in_stock"),
        sql`${stockLots.estExpiry} is not null`,
        sql`${stockLots.estExpiry} <= ${cutoff}`,
      ),
    )
    .all();

  return rows
    .map((row) => ({ ...row, estExpiry: row.estExpiry as string }))
    .sort(
      (a, b) =>
        a.estExpiry.localeCompare(b.estExpiry) || a.productName.localeCompare(b.productName),
    );
}

export interface CycleGuess {
  productId: number;
  productName: string;
}

function fetchOpenListProductIds(db: Db): Set<number> {
  const rows = db
    .select({ productId: shoppingListEntries.productId })
    .from(shoppingListEntries)
    .where(eq(shoppingListEntries.status, "open"))
    .all();
  return new Set(rows.map((row) => row.productId).filter((id): id is number => id !== null));
}

// Pure derivation over purchase history, computed fresh on every call and
// never stored (per CONTEXT.md's Cycle Guess definition). For each Product
// with at least two distinct purchase dates, the gaps between consecutive
// purchases give a median cadence; a guess fires once the time since the
// last purchase has already reached that median. A Product already sitting
// on the open shopping list is skipped — it's already queued.
export function computeCycleGuesses(db: Db, clock: Clock): CycleGuess[] {
  const rows = db
    .select({
      productId: stockLots.productId,
      productName: products.name,
      purchasedAt: stockLots.purchasedAt,
    })
    .from(stockLots)
    .innerJoin(products, eq(stockLots.productId, products.id))
    .all();

  const byProduct = new Map<number, { name: string; dates: Set<string> }>();
  for (const row of rows) {
    const entry = byProduct.get(row.productId) ?? { name: row.productName, dates: new Set() };
    entry.dates.add(row.purchasedAt);
    byProduct.set(row.productId, entry);
  }

  const openProductIds = fetchOpenListProductIds(db);
  const today = formatDate(clock.now());
  const guesses: CycleGuess[] = [];

  for (const [productId, { name, dates }] of byProduct) {
    if (openProductIds.has(productId) || dates.size < 2) {
      continue;
    }

    const sorted = [...dates].sort();
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(daysBetween(sorted[i - 1]!, sorted[i]!));
    }

    const medianGap = median(gaps);
    const lastPurchase = sorted[sorted.length - 1]!;
    const sinceLast = daysBetween(lastPurchase, today);

    if (sinceLast >= medianGap) {
      guesses.push({ productId, productName: name });
    }
  }

  return guesses.sort((a, b) => a.productName.localeCompare(b.productName));
}

// "Add" is the only write a Cycle Guess ever causes; "skip" leaves no trace
// (per the ticket) so there's no corresponding function for it.
export function addCycleGuessEntry(db: Db, clock: Clock, guess: CycleGuess): void {
  db.insert(shoppingListEntries)
    .values({
      source: "cycle_guess",
      productId: guess.productId,
      freeText: null,
      status: "open",
      createdAt: clock.now().toISOString(),
    })
    .run();
}

export function renderShoppingSummary(
  entries: ShoppingListEntry[],
  expiringLots: ExpiringLot[],
  cycleGuesses: CycleGuess[],
): string {
  const sections: string[] = [];

  const listLines = entries.length > 0 ? entries.map(renderEntryLine) : ["(empty)"];
  sections.push(["🛒 Shopping list", ...listLines].join("\n"));

  if (expiringLots.length > 0) {
    const lines = expiringLots.map((lot) => {
      const qty = lot.unit ? `${lot.quantity} ${lot.unit}` : `${lot.quantity}`;
      return `• ${lot.productName} — ${qty} (exp ${lot.estExpiry})`;
    });
    sections.push(["⏰ Use soon / don't rebuy", ...lines].join("\n"));
  }

  if (cycleGuesses.length > 0) {
    const lines = cycleGuesses.map((guess) => `• ${guess.productName}`);
    sections.push(["🔁 Probably low", ...lines].join("\n"));
  }

  sections.push("Reply to this message to add anything else.");

  return sections.join("\n\n");
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}

function daysBetween(a: string, b: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / msPerDay);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
