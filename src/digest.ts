import { and, eq, isNull, type SQL, sql } from "drizzle-orm";
import type { Clock } from "./clock.js";
import { expiryVerdicts, products, stockLots } from "./db/schema.js";
import type { Db } from "./db.js";
import { type FinishResult, finishLot } from "./finish.js";
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

// In-stock Lots that have already reached their estimate and don't already
// have an outstanding gone/still-good verdict — once asked, a Lot drops out
// of this query for good (whether answered or ignored), so the one-time
// promise holds regardless of how many digests fire afterward.
export function fetchJustExpiredLots(db: Db, clock: Clock): DigestLot[] {
  const today = formatDate(clock.now());

  return queryLots(
    db,
    and(
      eq(stockLots.status, "in_stock"),
      sql`${stockLots.estExpiry} is not null`,
      sql`${stockLots.estExpiry} <= ${today}`,
      isNull(expiryVerdicts.lotId),
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
    .leftJoin(expiryVerdicts, eq(expiryVerdicts.lotId, stockLots.id))
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

// The one write the digest cron itself is allowed to make: recording that a
// verdict was asked. ADR-0002 forbids a cron from mutating a Stock Lot's
// status or est_expiry — the two columns a human tap is the sole author of —
// and this table is neither: it never appears on stockLots, only records
// "already asked", and ticket #16's own acceptance criterion is scoped to
// "zero unconfirmed state mutations", i.e. no write that asserts something
// about a Lot's condition without a human tap behind it. Recording that a
// question was asked asserts nothing.
export function markVerdictsAsked(db: Db, clock: Clock, lotIds: number[]): void {
  if (lotIds.length === 0) {
    return;
  }

  const createdAt = clock.now().toISOString();
  db.transaction((tx) => {
    for (const lotId of lotIds) {
      tx.insert(expiryVerdicts).values({ lotId, createdAt }).run();
    }
  });
}

// Guarded by deleting the outstanding verdict row first: of a racing
// gone/still-good pair on the same Lot, only the first tap finds a row to
// delete and proceeds. "Gone" is a Finish-Confirmation, so it carries the
// same Auto-Relist behavior as any other Finish tap (per the ticket).
export function markLotGone(db: Db, clock: Clock, lotId: number, finishedBy: string): FinishResult {
  const deleted = db.delete(expiryVerdicts).where(eq(expiryVerdicts.lotId, lotId)).run();
  if (deleted.changes === 0) {
    return {
      finished: false,
      productId: null,
      productName: null,
      autoRelisted: false,
      offerAutoRelist: false,
    };
  }

  return finishLot(db, clock, lotId, finishedBy);
}

// Same delete-first guard as markLotGone. The status guard on the update is
// belt-and-suspenders: nothing else should touch a Lot with an outstanding
// verdict, but a Lot finished through another path (e.g. /inventory) while
// its verdict sat unanswered must not have its expiry silently rewritten.
export function markLotStillGood(db: Db, clock: Clock, lotId: number): boolean {
  const deleted = db.delete(expiryVerdicts).where(eq(expiryVerdicts.lotId, lotId)).run();
  if (deleted.changes === 0) {
    return false;
  }

  const newExpiry = addDays(formatDate(clock.now()), STILL_GOOD_EXTENSION_DAYS);
  const result = db
    .update(stockLots)
    .set({ estExpiry: newExpiry })
    .where(and(eq(stockLots.id, lotId), eq(stockLots.status, "in_stock")))
    .run();
  return result.changes > 0;
}

function lotLine(lot: DigestLot): string {
  const qty = lot.unit ? `${lot.quantity} ${lot.unit}` : `${lot.quantity}`;
  return `• ${lot.productName} — ${qty} (exp ${lot.estExpiry})`;
}

export function renderExpiryDigest(expiringSoon: DigestLot[], justExpired: DigestLot[]): string {
  const sections: string[] = [];

  if (expiringSoon.length > 0) {
    sections.push(["⏰ Expiring soon", ...expiringSoon.map(lotLine)].join("\n"));
  }

  if (justExpired.length > 0) {
    sections.push(
      ["🗑👌 Just expired — gone or still good?", ...justExpired.map(lotLine)].join("\n"),
    );
  }

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
