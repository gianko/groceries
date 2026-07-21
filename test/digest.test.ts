import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { products, stockLots } from "../src/db/schema.js";
import { createDb, type Db } from "../src/db.js";
import {
  digestQualifies,
  fetchExpiringSoonLots,
  fetchJustExpiredLots,
  markLotStillGood,
  STILL_GOOD_EXTENSION_DAYS,
} from "../src/digest.js";
import { FakeClock } from "./support/fakeClock.js";

function insertProduct(db: Db, name: string, opts: { autoRelist?: boolean } = {}) {
  const [product] = db
    .insert(products)
    .values({ name, category: "food", autoRelist: opts.autoRelist ?? false })
    .returning()
    .all();
  return product!;
}

function insertLot(
  db: Db,
  productId: number,
  opts: {
    estExpiry?: string | null;
    quantity?: number;
    unit?: string | null;
    status?: "in_stock" | "finished";
  } = {},
) {
  const [lot] = db
    .insert(stockLots)
    .values({
      productId,
      quantity: opts.quantity ?? 1,
      unit: opts.unit ?? null,
      purchasedAt: "2026-01-01",
      estExpiry: opts.estExpiry ?? null,
      status: opts.status ?? "in_stock",
    })
    .returning()
    .all();
  return lot!;
}

describe("fetchExpiringSoonLots", () => {
  it("includes in-stock Lots expiring within the window but not yet past estimate", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-10T12:00:00Z"));
    const bread = insertProduct(db, "bread");
    const milk = insertProduct(db, "milk");

    insertLot(db, bread.id, { estExpiry: "2026-01-12" });
    insertLot(db, milk.id, { estExpiry: "2026-01-11" });

    const result = fetchExpiringSoonLots(db, clock);
    expect(result.map((r) => r.productName)).toEqual(["milk", "bread"]);
  });

  it("excludes already-expired Lots, finished Lots, and Lots with no estExpiry", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-10T12:00:00Z"));
    const cheese = insertProduct(db, "cheese");
    const rice = insertProduct(db, "rice");
    const soap = insertProduct(db, "soap");

    insertLot(db, cheese.id, { estExpiry: "2026-01-10" }); // already reached today
    insertLot(db, rice.id, { estExpiry: null });
    insertLot(db, soap.id, { estExpiry: "2026-01-11", status: "finished" });

    expect(fetchExpiringSoonLots(db, clock)).toEqual([]);
  });

  it("excludes Lots past the window", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-10T12:00:00Z"));
    const soap = insertProduct(db, "soap");
    insertLot(db, soap.id, { estExpiry: "2026-02-01" });

    expect(fetchExpiringSoonLots(db, clock)).toEqual([]);
  });
});

describe("fetchJustExpiredLots", () => {
  it("includes in-stock Lots that have reached or passed their estimate, computed fresh", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-10T12:00:00Z"));
    const cheese = insertProduct(db, "cheese");
    const yogurt = insertProduct(db, "yogurt");

    insertLot(db, cheese.id, { estExpiry: "2026-01-10" });
    insertLot(db, yogurt.id, { estExpiry: "2026-01-08" });

    const result = fetchJustExpiredLots(db, clock);
    expect(result.map((r) => r.productName)).toEqual(["yogurt", "cheese"]);
  });

  it("keeps returning the same Lot on repeated calls until it's resolved", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-10T12:00:00Z"));
    const cheese = insertProduct(db, "cheese");
    const lot = insertLot(db, cheese.id, { estExpiry: "2026-01-10" });

    expect(fetchJustExpiredLots(db, clock).map((r) => r.lotId)).toEqual([lot.id]);
    expect(fetchJustExpiredLots(db, clock).map((r) => r.lotId)).toEqual([lot.id]);
  });

  it("excludes Lots not yet expired, finished Lots, and Lots with no estExpiry", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-10T12:00:00Z"));
    const bread = insertProduct(db, "bread");
    const rice = insertProduct(db, "rice");
    const soap = insertProduct(db, "soap");

    insertLot(db, bread.id, { estExpiry: "2026-01-11" });
    insertLot(db, rice.id, { estExpiry: null });
    insertLot(db, soap.id, { estExpiry: "2026-01-09", status: "finished" });

    expect(fetchJustExpiredLots(db, clock)).toEqual([]);
  });
});

describe("digestQualifies", () => {
  it("is true when either section has entries, false when both are empty", () => {
    const lot = { lotId: 1, productName: "milk", quantity: 1, unit: null, estExpiry: "2026-01-10" };
    expect(digestQualifies([lot], [])).toBe(true);
    expect(digestQualifies([], [lot])).toBe(true);
    expect(digestQualifies([], [])).toBe(false);
  });
});

describe("markLotStillGood", () => {
  it("pushes est_expiry out a few days from today", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-10T12:00:00Z"));
    const cheese = insertProduct(db, "cheese");
    const lot = insertLot(db, cheese.id, { estExpiry: "2026-01-08" });

    const applied = markLotStillGood(db, clock, lot.id);

    expect(applied).toBe(true);
    const updated = db.select().from(stockLots).where(eq(stockLots.id, lot.id)).get();
    expect(updated?.estExpiry).toBe(`2026-01-${10 + STILL_GOOD_EXTENSION_DAYS}`);
  });

  it("is a no-op on a second call — the pushed-out estExpiry no longer matches just-expired", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-10T12:00:00Z"));
    const cheese = insertProduct(db, "cheese");
    const lot = insertLot(db, cheese.id, { estExpiry: "2026-01-08" });

    markLotStillGood(db, clock, lot.id);
    const second = markLotStillGood(db, clock, lot.id);

    expect(second).toBe(false);
  });

  it("is a no-op when the Lot isn't past its estimate", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-10T12:00:00Z"));
    const cheese = insertProduct(db, "cheese");
    const lot = insertLot(db, cheese.id, { estExpiry: "2026-01-12" });

    expect(markLotStillGood(db, clock, lot.id)).toBe(false);
  });

  it("is a no-op when the Lot is already finished", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-10T12:00:00Z"));
    const cheese = insertProduct(db, "cheese");
    const lot = insertLot(db, cheese.id, { estExpiry: "2026-01-08", status: "finished" });

    expect(markLotStillGood(db, clock, lot.id)).toBe(false);
  });
});
