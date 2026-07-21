import { and, eq, type SQL, sql } from "drizzle-orm";
import type { Clock } from "./clock.js";
import { products, stockLots } from "./db/schema.js";
import type { Db } from "./db.js";
import { EXPIRING_WINDOW_DAYS } from "./shopping.js";

// "A few days" per the ticket — pushed from today, not from the old
// (already-passed) est_expiry, since the household is asserting the food is
// still good as of now.
export const STILL_GOOD_EXTENSION_DAYS = 3;

export interface DigestLot {
  lotId: number;
  productName: string;
  quantity: number;
  unit: string | null;
  estExpiry: string;
}

// In-stock Lots expiring within the window but not yet past their estimate —
// the digest's heads-up section, no verdict attached.
export function fetchExpiringSoonLots(db: Db, clock: Clock): DigestLot[] {
  const today = formatDate(clock.now());
  const cutoff = addDays(today, EXPIRING_WINDOW_DAYS);

  return queryLots(
    db,
    and(
      eq(stockLots.status, "in_stock"),
      sql`${stockLots.estExpiry} is not null`,
      sql`${stockLots.estExpiry} > ${today}`,
      sql`${stockLots.estExpiry} <= ${cutoff}`,
    ),
  );
}

// In-stock Lots that have already reached their estimate — computed fresh on
// every call, so a Lot resurfaces here on every page load until a human taps
// Gone or Still-good (which finishes it or pushes its estimate out, either
// way dropping it out of this query).
export function fetchJustExpiredLots(db: Db, clock: Clock): DigestLot[] {
  const today = formatDate(clock.now());

  return queryLots(
    db,
    and(
      eq(stockLots.status, "in_stock"),
      sql`${stockLots.estExpiry} is not null`,
      sql`${stockLots.estExpiry} <= ${today}`,
    ),
  );
}

function queryLots(db: Db, where: SQL | undefined): DigestLot[] {
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
    .where(where)
    .all();

  return rows
    .map((row) => ({ ...row, estExpiry: row.estExpiry as string }))
    .sort(
      (a, b) =>
        a.estExpiry.localeCompare(b.estExpiry) || a.productName.localeCompare(b.productName),
    );
}

export function digestQualifies(expiringSoon: DigestLot[], justExpired: DigestLot[]): boolean {
  return expiringSoon.length > 0 || justExpired.length > 0;
}

// Guarded on the Lot still being just-expired (same predicate as
// fetchJustExpiredLots) as well as in_stock: of a racing pair of taps on the
// same Lot, only the first finds a matching row and proceeds — the second
// finds est_expiry already pushed past today and no-ops. "Gone" isn't
// guarded here; it's a Finish-Confirmation, so it routes through
// finishLot's own in_stock guard instead (see src/finish.ts).
export function markLotStillGood(db: Db, clock: Clock, lotId: number): boolean {
  const today = formatDate(clock.now());
  const newExpiry = addDays(today, STILL_GOOD_EXTENSION_DAYS);
  const result = db
    .update(stockLots)
    .set({ estExpiry: newExpiry })
    .where(
      and(
        eq(stockLots.id, lotId),
        eq(stockLots.status, "in_stock"),
        sql`${stockLots.estExpiry} <= ${today}`,
      ),
    )
    .run();
  return result.changes > 0;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}
