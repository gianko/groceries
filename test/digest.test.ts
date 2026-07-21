import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { expiryVerdicts, products, stockLots } from "../src/db/schema.js";
import { createDb, type Db } from "../src/db.js";
import {
  digestQualifies,
  fetchExpiringSoonLots,
  fetchJustExpiredLots,
  markLotGone,
  markLotStillGood,
  markVerdictsAsked,
  renderExpiryDigest,
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
  it("includes in-stock Lots that have reached or passed their estimate", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-10T12:00:00Z"));
    const cheese = insertProduct(db, "cheese");
    const yogurt = insertProduct(db, "yogurt");

    insertLot(db, cheese.id, { estExpiry: "2026-01-10" });
    insertLot(db, yogurt.id, { estExpiry: "2026-01-08" });

    const result = fetchJustExpiredLots(db, clock);
    expect(result.map((r) => r.productName)).toEqual(["yogurt", "cheese"]);
  });

  it("excludes a Lot that already has an outstanding verdict", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-10T12:00:00Z"));
    const cheese = insertProduct(db, "cheese");
    const lot = insertLot(db, cheese.id, { estExpiry: "2026-01-10" });

    markVerdictsAsked(db, clock, [lot.id]);

    expect(fetchJustExpiredLots(db, clock)).toEqual([]);
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

describe("markVerdictsAsked", () => {
  it("inserts one row per Lot", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-10T12:00:00Z"));
    const cheese = insertProduct(db, "cheese");
    const lotA = insertLot(db, cheese.id, { estExpiry: "2026-01-10" });
    const lotB = insertLot(db, cheese.id, { estExpiry: "2026-01-09" });

    markVerdictsAsked(db, clock, [lotA.id, lotB.id]);

    expect(db.select().from(expiryVerdicts).all()).toHaveLength(2);
  });
});

describe("markLotGone", () => {
  it("finishes the Lot when a verdict is outstanding", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-10T12:00:00Z"));
    const cheese = insertProduct(db, "cheese");
    const lot = insertLot(db, cheese.id, { estExpiry: "2026-01-10" });
    markVerdictsAsked(db, clock, [lot.id]);

    const result = markLotGone(db, clock, lot.id, "Gian");

    expect(result.finished).toBe(true);
    expect(db.select().from(stockLots).where(eq(stockLots.id, lot.id)).get()?.status).toBe(
      "finished",
    );
    expect(db.select().from(expiryVerdicts).all()).toEqual([]);
  });

  it("is a no-op when no verdict is outstanding (already handled)", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-10T12:00:00Z"));
    const cheese = insertProduct(db, "cheese");
    const lot = insertLot(db, cheese.id, { estExpiry: "2026-01-10" });
    markVerdictsAsked(db, clock, [lot.id]);

    markLotGone(db, clock, lot.id, "Gian");
    const second = markLotGone(db, clock, lot.id, "Gian");

    expect(second.finished).toBe(false);
  });

  it("carries the same Auto-Relist offer as any other Finish-Confirmation", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-10T12:00:00Z"));
    const milk = insertProduct(db, "milk", { autoRelist: true });
    const lot = insertLot(db, milk.id, { estExpiry: "2026-01-10" });
    markVerdictsAsked(db, clock, [lot.id]);

    const result = markLotGone(db, clock, lot.id, "Gian");

    expect(result.autoRelisted).toBe(true);
  });
});

describe("markLotStillGood", () => {
  it("pushes est_expiry out a few days from today and clears the verdict", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-10T12:00:00Z"));
    const cheese = insertProduct(db, "cheese");
    const lot = insertLot(db, cheese.id, { estExpiry: "2026-01-08" });
    markVerdictsAsked(db, clock, [lot.id]);

    const applied = markLotStillGood(db, clock, lot.id);

    expect(applied).toBe(true);
    const updated = db.select().from(stockLots).where(eq(stockLots.id, lot.id)).get();
    expect(updated?.estExpiry).toBe(`2026-01-${10 + STILL_GOOD_EXTENSION_DAYS}`);
    expect(db.select().from(expiryVerdicts).all()).toEqual([]);
  });

  it("is a no-op when no verdict is outstanding", () => {
    const db = createDb();
    const clock = new FakeClock(new Date("2026-01-10T12:00:00Z"));
    const cheese = insertProduct(db, "cheese");
    const lot = insertLot(db, cheese.id, { estExpiry: "2026-01-08" });

    expect(markLotStillGood(db, clock, lot.id)).toBe(false);
  });
});

describe("renderExpiryDigest", () => {
  it("shows both sections when both have entries", () => {
    const soon = [
      { lotId: 1, productName: "bread", quantity: 1, unit: null, estExpiry: "2026-01-12" },
    ];
    const expired = [
      { lotId: 2, productName: "yogurt", quantity: 2, unit: "pots", estExpiry: "2026-01-08" },
    ];

    const text = renderExpiryDigest(soon, expired);
    expect(text).toContain("Expiring soon");
    expect(text).toContain("bread");
    expect(text).toContain("gone or still good");
    expect(text).toContain("yogurt");
  });

  it("omits an empty section", () => {
    const expired = [
      { lotId: 2, productName: "yogurt", quantity: 2, unit: "pots", estExpiry: "2026-01-08" },
    ];
    const text = renderExpiryDigest([], expired);
    expect(text).not.toContain("Expiring soon");
  });
});
